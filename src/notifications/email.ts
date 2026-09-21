import { Resend } from "resend";
import { EMAIL_FROM, RESEND_API_KEY } from "./env";
import { splitDeliverable } from "./recipientFilter";

const SEND_TIMEOUT_MS = 8_000;

const client = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

export type EmailMessage = { to: string[]; subject: string; text: string };

// AGENTS.md rule 4, verbatim: "A notification must never break what
// triggered it." Callers are always thin "use server" action wrappers,
// called only after their transaction has already committed — never a
// pure core — so a slow or failing Resend call can never roll back an
// approval. Never throws: no key configured, a timeout, or a Resend
// error all resolve to a console.error and a plain return. Rule 5's
// "fails visibly at the edge" is satisfied by that console.error landing
// in Vercel's own log capture — a real health surface with a status
// table is slice 4's job, not built here.
export async function sendEmail(message: EmailMessage): Promise<void> {
  // Reserved-domain addresses (test fixtures, walkthrough accounts) can never
  // be delivered; drop them first so they cost no send and no bounce. Logged,
  // never silent (rule 5) — a real recipient landing here would be visible.
  const { deliverable, dropped } = splitDeliverable(message.to);
  if (dropped.length > 0) {
    console.error("[notifications] dropped undeliverable (reserved-domain) recipients:", message.subject, dropped);
  }
  if (deliverable.length === 0) {
    return;
  }
  if (!client || !EMAIL_FROM) {
    console.error("[notifications] no RESEND_API_KEY/EMAIL_FROM configured — suppressed:", message.subject, deliverable);
    return;
  }

  try {
    await Promise.race([
      client.emails.send({ from: EMAIL_FROM, to: deliverable, subject: message.subject, text: message.text }),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("send timed out")), SEND_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error("[notifications] send failed:", message.subject, deliverable, err);
  }
}
