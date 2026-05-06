---
status: pending
priority: p2
issue_id: 292
tags: [code-review, lightning, lsp, performance, pr-148]
dependencies: []
---

# P2 — `sendBolt12Payment` + startup auto-connect warm Megalith only, never LQwD primary

## Problem Statement

PR #148 introduces LQwD as the primary LSP for receive, but two non-receive callsites in `src/ldk/context.tsx` still warm only the env-var (Megalith / fallback) peer:

1. **`sendBolt12Payment`** at `src/ldk/context.tsx:568-578` — when sending a BOLT 12 offer payment, the code ensures `LDK_CONFIG.lspNodeId/Host/Port` is connected before routing the onion. If the user's actual channel is with LQwD, the warmup connects the wrong peer (Megalith) and the BOLT 12 send pays the WebSocket-handshake latency on LQwD anyway when LDK actually sends.
2. **Startup auto-connect** at `src/ldk/context.tsx:1050-1056` — on boot, the code unconditionally connects to `LDK_CONFIG.lspNodeId/Host/Port`. New users who only ever transact via LQwD never have LQwD pre-warmed; their first JIT receive pays the WebSocket-handshake cost on the critical path.

Neither is a hard break: receive's own connect path (`attemptJitInvoiceWithLsp` step 0) and BOLT 12's LDK-internal routing both reconnect on demand. But it's a UX degradation directly contradicting the brainstorm decision to make LQwD the primary.

## Findings

- `src/ldk/context.tsx:568-578` reads `LDK_CONFIG.lspNodeId/Host/Port` directly — bypasses `resolveLspContacts()`.
- `src/ldk/context.tsx:1050-1056` does the same on the boot path.
- The plan explicitly noted these other callsites as "out of scope" for the receive-only PR. We accepted that scope, but the consequence is real cold-start latency for LQwD-primary users.

## Proposed Solutions

### Option A — Warm both LSPs at boot

After `resolveLspContacts()` settles, call `connectAndTrack` for both `primary` and `fallback` (whichever are non-null). Cost: two WebSockets vs one. LDK can hold both peers happily.

**Pros:** First receive is fast regardless of which LSP the flow picks. BOLT 12 send works against either LSP without an on-demand connect.

**Cons:** Two persistent WebSocket connections (battery / data on mobile). Pre-existing pattern only warms one, so this is a small policy change.

**Effort:** Small.

**Risk:** Low.

### Option B — Resolve-then-warm the chosen LSP

Boot logic awaits `resolveLspContacts()`, then warms `primary ?? fallback`. BOLT 12 send does the same.

**Pros:** Single WebSocket, lines up with the receive flow's choice.

**Cons:** Both callsites become async on the LSP-resolve promise. Slightly more refactor.

**Effort:** Small-Medium.

**Risk:** Low.

### Option C — Defer entirely (status quo + comment)

Document that startup warmup remains Megalith-only, with rationale ("Megalith currently holds 100% of existing channels; LQwD warming is on-demand"). Accept the cold-start latency for new LQwD-only users.

**Pros:** No code change.

**Cons:** UX regression for LQwD primary becomes permanent. Future readers won't know it's intentional.

**Effort:** Trivial (comment only).

**Risk:** Low.

## Recommended Action

(triage)

## Technical Details

- **Affected files:** `src/ldk/context.tsx` (lines 568-578 for BOLT 12; lines 1050-1056 for boot warmup).
- **Out of scope for this todo:** line 419's "list peer for channel-presence check" — that's a "do we have channels with this LSP?" gate, not a warmup. It correctly stays env-var-driven (Megalith is the only LSP that's had channels until now).

## Acceptance Criteria

- [ ] Boot warmup uses `resolveLspContacts()` (chose option A or B).
- [ ] `sendBolt12Payment` warmup uses the same.
- [ ] No regression in cold-start time for existing Megalith users.
- [ ] Test coverage: at least a unit test that the boot warmup connects both peers (or the chosen one).
- [ ] `pnpm test` + `pnpm build` + `pnpm format:check` pass.

## Work Log

| Date       | Action                                    | Notes                                                              |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------ |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | architecture-strategist + kieran-typescript-reviewer both flagged. |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/context.tsx:568-578`, `src/ldk/context.tsx:1050-1056`
- Related: `src/ldk/lsp/contacts.ts:resolveLspContacts`
