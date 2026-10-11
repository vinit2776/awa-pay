import { inArray } from "drizzle-orm";
import type { ScopedTx } from "@/db/runtime";
import { department, user } from "@/db/schema";

export type QueueMeta = { raisedByName: string | null; departmentName: string | null };

// Who raised each request and which department it belongs to, for the
// desk queues' rows. Two batched lookups for the whole page, never one
// per row. Runs inside the caller's scoped transaction so the same
// row-level security that scoped the requests scopes these too.
export async function loadQueueMeta(
  tx: ScopedTx,
  rows: { id: string; raisedBy: string; departmentId: string }[],
): Promise<Map<string, QueueMeta>> {
  const meta = new Map<string, QueueMeta>();
  if (rows.length === 0) return meta;

  const userIds = [...new Set(rows.map((r) => r.raisedBy))];
  const deptIds = [...new Set(rows.map((r) => r.departmentId))];
  const [users, depts] = await Promise.all([
    tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds)),
    tx.select({ id: department.id, name: department.name }).from(department).where(inArray(department.id, deptIds)),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const deptName = new Map(depts.map((d) => [d.id, d.name]));

  for (const r of rows) {
    meta.set(r.id, { raisedByName: userName.get(r.raisedBy) ?? null, departmentName: deptName.get(r.departmentId) ?? null });
  }
  return meta;
}
