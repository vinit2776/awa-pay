import { withActorScope, type Role } from "@/db/runtime";

// The signed-in person and the roles they hold, in one statement — the home
// screen (and anything else that wants "who is this and what can they do")
// used to read the user row and their role_grant rows in two separate
// transactions. Zero next/headers imports, so tests can call it directly;
// src/auth/dal.ts memoizes it per request.
export async function loadViewer(userId: string) {
  return withActorScope(userId, async (tx) => {
    const row = await tx.query.user.findFirst({
      where: (u, { eq }) => eq(u.id, userId),
      columns: { id: true, name: true, email: true, status: true, mfaEnrolled: true },
      with: {
        roleGrants: { columns: { role: true }, where: (g, { isNull }) => isNull(g.revokedAt) },
      },
    });
    if (!row) return null;

    const { roleGrants, ...user } = row;
    return { user, roles: new Set<Role>(roleGrants.map((g) => g.role)) };
  });
}
