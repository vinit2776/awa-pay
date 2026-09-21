import { and, arrayContains, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import Link from "next/link";
import { verifySession } from "@/auth/dal";
import { withGrantScope } from "@/db/runtime";
import { department, event, query, request, user } from "@/db/schema";
import { computeFlags, loadFlagContext } from "@/flags/computeFlags";
import { loadStageEntered } from "@/requests/queueData";
import { daysSince, needsRequesterReason } from "@/requests/queueRows";
import { QueueHeader } from "@/ui/QueueHeader";
import { QueueList, type QueueRow } from "@/ui/QueueList";
import { MiniTrack, StagePill } from "@/ui/StageTrack";
import { buttonClass, inputClass } from "@/ui/styles";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "needs", label: "Needs you" },
  { key: "moving", label: "Moving" },
  { key: "paid", label: "Paid" },
  { key: "closed", label: "Closed" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];

const CLOSED_STAGES = new Set(["rejected", "withdrawn"]);

export default async function MyRequestsPage({ searchParams }: PageProps<"/requests">) {
  const session = await verifySession();
  const { q, show } = await searchParams;
  const term = typeof q === "string" ? q.trim() : "";
  const filter: FilterKey = FILTERS.some((f) => f.key === show) ? (show as FilterKey) : "all";
  const now = new Date();

  const [rows, flagContext, stageEntered, returnRows, openQueryRows] = await withGrantScope(session.userId, "requester", async (tx) => {
    const conditions = [eq(request.raisedBy, session.userId)];
    if (term) {
      conditions.push(or(ilike(request.ref, `%${term}%`), ilike(request.vendor, `%${term}%`), ilike(request.invoiceNo, `%${term}%`))!);
    }

    const result = await tx
      .select({ request, departmentName: department.name })
      .from(request)
      .innerJoin(department, eq(department.id, request.departmentId))
      .where(and(...conditions))
      .orderBy(desc(request.createdAt));

    const requests = result.map((r) => r.request);
    const ids = requests.map((r) => r.id);
    const returnedIds = requests.filter((r) => r.stage === "raised").map((r) => r.id);

    // The approver's words for bills sent back, newest first so the first
    // one seen per request is the reason for the current return.
    const returns =
      returnedIds.length === 0
        ? []
        : await tx
            .select({ requestId: event.requestId, after: event.after })
            .from(event)
            .where(and(inArray(event.requestId, returnedIds), eq(event.type, "request.returned")))
            .orderBy(desc(event.at));

    const queries =
      ids.length === 0
        ? []
        : await tx
            .select({ requestId: query.requestId, question: query.question, raisedByName: user.name })
            .from(query)
            .leftJoin(user, eq(user.id, query.raisedBy))
            .where(and(inArray(query.requestId, ids), isNull(query.resolvedAt), arrayContains(query.directedAt, ["requester"])))
            .orderBy(asc(query.at));

    return [result, await loadFlagContext(tx, requests), await loadStageEntered(tx, requests), returns, queries] as const;
  });

  const returnReason = new Map<string, string>();
  for (const r of returnRows) {
    if (!r.requestId || returnReason.has(r.requestId)) continue;
    const reason = (r.after as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string") returnReason.set(r.requestId, reason);
  }
  const openQuery = new Map<string, { raisedByName: string; question: string }>();
  for (const q of openQueryRows) {
    if (!openQuery.has(q.requestId)) openQuery.set(q.requestId, { raisedByName: q.raisedByName ?? "Someone", question: q.question });
  }

  const all = rows.map(({ request: r, departmentName }) => {
    const reason = needsRequesterReason({ stage: r.stage, returnReason: returnReason.get(r.id) ?? null, openQuery: openQuery.get(r.id) ?? null });
    const bucket: Exclude<FilterKey, "all"> = reason ? "needs" : r.stage === "paid" ? "paid" : CLOSED_STAGES.has(r.stage) ? "closed" : "moving";
    const days = daysSince(stageEntered.get(r.id) ?? r.createdAt, now);
    const row: QueueRow = {
      id: r.id,
      href: `/requests/${r.id}`,
      ref: r.revision > 1 ? `${r.ref} · rev ${r.revision}` : r.ref,
      title: r.vendor ?? "Unknown vendor",
      meta: departmentName,
      badges: (
        <>
          {bucket !== "paid" && bucket !== "closed" && <MiniTrack stage={r.stage} frozen={openQuery.has(r.id)} />}
          <StagePill stage={r.stage} />
        </>
      ),
      flags: computeFlags(r, flagContext),
      reason,
      amountMinor: r.amountMinor,
      currency: r.currency,
      aside: bucket === "paid" || bucket === "closed" ? undefined : `${days}d in stage`,
      attention: reason !== null,
    };
    return { bucket, row };
  });

  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, f.key === "all" ? all.length : all.filter((x) => x.bucket === f.key).length]));
  const visible = all.filter((x) => filter === "all" || x.bucket === filter);
  // Whatever the filter, anything waiting on the requester reads first.
  const ordered = [...visible.filter((x) => x.bucket === "needs"), ...visible.filter((x) => x.bucket !== "needs")].map((x) => x.row);

  const hrefFor = (key: FilterKey) => {
    const params = new URLSearchParams();
    if (key !== "all") params.set("show", key);
    if (term) params.set("q", term);
    const qs = params.toString();
    return qs ? `/requests?${qs}` : "/requests";
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
      <QueueHeader
        title="My requests"
        summary={counts.needs ? `${counts.needs} waiting on you` : "Nothing is waiting on you"}
        action={
          <Link href="/requests/new" className={buttonClass("primary", "sm")}>
            + Raise a request
          </Link>
        }
      />

      <form className="flex gap-2" role="search">
        {filter !== "all" && <input type="hidden" name="show" value={filter} />}
        <input type="search" name="q" defaultValue={term} aria-label="Search your requests" placeholder="Ref, vendor or invoice no." className={inputClass} />
        <button type="submit" className={buttonClass("secondary", "sm")}>
          Search
        </button>
      </form>

      <nav aria-label="Filter" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={hrefFor(f.key)}
            aria-current={filter === f.key ? "page" : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] ${
              filter === f.key ? "border-ink bg-ink text-ground" : "border-line text-ink-2 hover:border-ink-3"
            }`}
          >
            {f.label}
            <span className="font-mono text-[11px]">{counts[f.key]}</span>
          </Link>
        ))}
      </nav>

      <QueueList
        groups={[{ key: "all", rows: ordered }]}
        empty={term ? "No requests match that search." : filter === "all" ? "You haven't raised any requests yet." : "Nothing here."}
      />
    </div>
  );
}
