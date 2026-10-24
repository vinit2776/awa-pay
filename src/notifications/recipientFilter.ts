// Addresses under names that RFC 2606 / RFC 6761 reserve can never be
// delivered: .invalid, .test, .example, .localhost, and example.com/.net/.org.
// Test fixtures (`…@example.invalid`), the walkthrough accounts
// (`…@awa-pay.test`) and any leftover from a crashed test run all live
// there. Sending to them is guaranteed to bounce, and bounces damage the
// sending domain's reputation — so they are dropped before a send, whatever
// the state of the database that produced them.
const RESERVED_TLDS = new Set(["invalid", "test", "example", "localhost"]);
const RESERVED_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

export function isUndeliverableAddress(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase();
  if (!domain || domain === address.trim().toLowerCase()) return true; // no "@": not an address
  const labels = domain.split(".");
  return RESERVED_TLDS.has(labels[labels.length - 1]) || RESERVED_DOMAINS.has(labels.slice(-2).join("."));
}

export function splitDeliverable(addresses: string[]): { deliverable: string[]; dropped: string[] } {
  const deliverable: string[] = [];
  const dropped: string[] = [];
  for (const a of addresses) (isUndeliverableAddress(a) ? dropped : deliverable).push(a);
  return { deliverable, dropped };
}
