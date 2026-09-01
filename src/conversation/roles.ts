import type { Role } from "@/db/runtime";

// Roles the capability table (AGENTS.md §11) grants "comment, nudge, raise
// & answer queries" to — every role except developer, who "sees the
// machine, not the money." Shared by commentsCore.ts and queriesCore.ts
// (and, from phase 7, nudgesCore.ts) so the list is defined once.
export const CONVERSATION_ROLES: Role[] = ["requester", "approver", "accountant", "payer", "super_admin"];
