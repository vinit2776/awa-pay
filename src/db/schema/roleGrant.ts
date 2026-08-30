import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companyScopeEnum, deptScopeEnum, roleEnum } from "./enums";
import { user } from "./user";

export const roleGrant = pgTable(
  "role_grant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    role: roleEnum("role").notNull(),
    deptScope: deptScopeEnum("dept_scope").notNull(),
    departmentIds: uuid("department_ids").array(),
    companyScope: companyScopeEnum("company_scope").notNull().default("n/a"),
    companyIds: uuid("company_ids").array(),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => user.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("role_grant_active_user_idx").on(table.userId).where(sql`${table.revokedAt} is null`),
    index("role_grant_department_ids_gin_idx").using("gin", table.departmentIds),
    index("role_grant_company_ids_gin_idx").using("gin", table.companyIds),
    check(
      "role_grant_dept_scope_list_check",
      sql`${table.deptScope} <> 'list' or (${table.departmentIds} is not null and cardinality(${table.departmentIds}) > 0)`,
    ),
    check(
      "role_grant_company_scope_list_check",
      sql`${table.companyScope} <> 'list' or (${table.companyIds} is not null and cardinality(${table.companyIds}) > 0)`,
    ),
  ],
);
