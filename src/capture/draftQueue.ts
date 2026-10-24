import { type DBSchema, type IDBPDatabase, openDB } from "idb";

// The offline draft queue — entirely client-side, no server API, no new
// schema (docs/START-HERE-slice-4.md). A draft holds everything the
// online capture flow already collects, just not yet uploaded: presigned
// URLs expire in 10 minutes (src/storage/r2.ts), so a queued draft can't
// carry one captured hours earlier — flushDrafts mints a fresh slot per
// attachment at flush time instead, through the exact same actions the
// online path already uses.

export type QueuedAttachment = { blob: Blob; mime: string; sha256: string; byteLength: number };

export type QueuedDraft = {
  id: string;
  departmentId: string;
  amount: string;
  invoiceNo: string;
  invoiceDate: string;
  vendor: string;
  gstinOnBill: string;
  note: string;
  // Advances and part-payments. All optional so drafts already sitting in
  // users' IndexedDB (which predate them) still load; a missing kind means
  // "invoice", a missing payNow means the whole amount.
  kind?: "invoice" | "advance";
  payNow?: string;
  payNowReason?: string;
  quotationNo?: string;
  invoiceExpectedBy?: string;
  attachments: QueuedAttachment[];
  createdAt: number;
};

interface DraftDB extends DBSchema {
  drafts: { key: string; value: QueuedDraft };
}

const DB_NAME = "awa-pay-drafts";
const STORE_NAME = "drafts";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<DraftDB>> | null = null;

function getDb(): Promise<IDBPDatabase<DraftDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DraftDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      },
    });
  }
  return dbPromise;
}

export async function enqueueDraft(draft: Omit<QueuedDraft, "id" | "createdAt">): Promise<string> {
  const id = crypto.randomUUID();
  const db = await getDb();
  await db.put(STORE_NAME, { ...draft, id, createdAt: Date.now() });
  return id;
}

export async function listDrafts(): Promise<QueuedDraft[]> {
  const db = await getDb();
  return db.getAll(STORE_NAME);
}

export async function removeDraft(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}

// Atomically removes and returns a draft in one IndexedDB transaction —
// get-then-delete inside a single readwrite transaction is what makes two
// concurrent flush attempts unable to both grab the same draft before
// either removes it. Found the hard way: React Strict Mode double-invokes
// effects in dev, and DraftFlusher mounts fresh on every navigation, so
// without this a draft still mid-upload from one flush attempt could get
// picked up and submitted again by another, producing duplicate requests
// from a single queued draft.
async function claimDraft(id: string): Promise<QueuedDraft | undefined> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const draft = await tx.store.get(id);
  if (draft) await tx.store.delete(id);
  await tx.done;
  return draft;
}

// Module-level mutex, on top of claimDraft's own per-row atomicity: two
// flush attempts in the same tab (React Strict Mode double-invokes
// DraftFlusher's mount effect in dev; the `online` event and a mount can
// also land close together) must never run their loops concurrently at
// all, not just avoid claiming the same row — a second call simply awaits
// whichever run is already in flight instead of starting its own.
let inFlightFlush: Promise<{ flushed: number; remaining: number }> | null = null;

// upload does whatever it takes to turn one draft into a real submitted
// request (mint a slot per attachment, PUT each, call the submit action)
// and reports success/failure — draftQueue itself knows nothing about
// uploads or server actions, only about the local queue. A draft is
// claimed (removed) before its upload is attempted, and put back only on
// failure — so it's never in the store to be claimed twice, and a failed
// attempt still leaves it queued for the next one. Foreground-retry-on-
// open is itself the retry mechanism, no backoff bookkeeping on top of it.
export async function flushDrafts(
  upload: (draft: QueuedDraft) => Promise<boolean>,
): Promise<{ flushed: number; remaining: number }> {
  if (inFlightFlush) return inFlightFlush;

  inFlightFlush = (async () => {
    try {
      const drafts = await listDrafts();
      let flushed = 0;
      for (const draft of drafts) {
        const claimed = await claimDraft(draft.id);
        if (!claimed) continue; // another flush already claimed it
        const ok = await upload(claimed);
        if (ok) {
          flushed += 1;
        } else {
          const db = await getDb();
          await db.put(STORE_NAME, claimed);
        }
      }
      const remaining = (await listDrafts()).length;
      return { flushed, remaining };
    } finally {
      inFlightFlush = null;
    }
  })();

  return inFlightFlush;
}
