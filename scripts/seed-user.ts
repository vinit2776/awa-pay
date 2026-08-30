// Provisioning stays admin-only (docs/START-HERE.md phase 2) — there is no
// sign-up route, so this script is the only way to create a user until a
// real admin console exists. Uses the owner connection like db-owner.ts's
// other callers (seed/test fixtures only, never a live app code path).
//
// Usage: npx tsx scripts/seed-user.ts <email> <name> <password> [role]
import { hashSecret } from "../src/auth/password";
import { roleGrant, user } from "../src/db/schema";
import { closeOwnerConnection, dbOwner } from "./db-owner";

async function main() {
  const [email, name, password, role] = process.argv.slice(2);
  if (!email || !name || !password) {
    console.error("Usage: npx tsx scripts/seed-user.ts <email> <name> <password> [role]");
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashSecret(password);
  const [created] = await dbOwner
    .insert(user)
    .values({ name, email, passwordHash })
    .returning({ id: user.id, email: user.email });

  console.log(`Created user ${created.email} (${created.id})`);

  if (role) {
    await dbOwner.insert(roleGrant).values({
      userId: created.id,
      role: role as (typeof roleGrant.$inferInsert)["role"],
      deptScope: "global",
      companyScope: "global",
      grantedBy: created.id,
    });
    console.log(`Granted role "${role}" (global scope)`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeOwnerConnection());
