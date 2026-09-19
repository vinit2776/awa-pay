import type { Role } from "@/db/runtime";

// Roles the capability table (AGENTS.md §11) grants "comment, nudge, raise
// & answer queries" to — every role except developer, who "sees the
// machine, not the money." Shared by commentsCore.ts and queriesCore.ts
// (and, from phase 7, nudgesCore.ts) so the list is defined once.
export const CONVERSATION_ROLES: Role[] = ["requester", "approver", "accountant", "payer", "super_admin"];

// The four roles that work a request through its stages — the ones a query
// can be aimed at from the request page. CONVERSATION_ROLES above adds
// super_admin, who configures rather than works a request.
export const DESK_ROLES: Role[] = ["requester", "approver", "accountant", "payer"];
