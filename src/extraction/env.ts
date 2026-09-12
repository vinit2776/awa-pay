// The one process.env read point for extraction, mirroring
// src/notifications/env.ts's pattern exactly: deliberately NOT required at
// import time. Rule 5 says an unconfigured integration fails visibly at
// the edge, not by crashing — ANTHROPIC_API_KEY is unset in CI and in a
// fresh checkout (.env.example says so explicitly), so every test run
// exercises the "no key configured" path (extractCore.ts degrading to a
// failed attempt with a visible error) for free.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
