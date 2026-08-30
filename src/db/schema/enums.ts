import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", [
  "requester",
  "approver",
  "accountant",
  "payer",
  "super_admin",
  "developer",
]);

export const deptScopeEnum = pgEnum("dept_scope", ["global", "list"]);

export const companyScopeEnum = pgEnum("company_scope", ["global", "list", "n/a"]);

export const userStatusEnum = pgEnum("user_status", ["active", "disabled"]);

export const requestStageEnum = pgEnum("request_stage", [
  "raised",
  "awaiting_approval",
  "with_accounts",
  "to_pay",
  "paid",
  "on_hold",
  "rejected",
]);
