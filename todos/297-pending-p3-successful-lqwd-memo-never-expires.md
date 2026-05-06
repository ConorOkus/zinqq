---
status: pending
priority: p3
issue_id: 297
tags: [code-review, lsp, pr-148]
dependencies: []
---

# P3 — Successful LQwD memo never expires

## Problem Statement

`fetchLqwdContact` memoises the resolved contact for the entire page lifetime. If LQwD rotates its node pubkey or moves hosts mid-session, every subsequent JIT receive on that tab fails until the user reloads. Operationally rare but worth a soft TTL or an explicit comment trade-off.

## Findings

- `src/ldk/lsp/lqwd-discovery.ts:23` — `let inflight: Promise<LspContact> | null = null`.
- `src/ldk/lsp/lqwd-discovery.ts:63-65` — only the rejection path clears `inflight`. A resolved promise stays cached forever.
- The fallback path (`runJitInvoiceFlow`) does cover this case, but at the cost of a failed primary attempt every receive after the rotation.

## Proposed Solutions

### Option A — Soft TTL on resolved memo

Track resolution time; if `Date.now() - resolvedAt > 60 * 60 * 1000` on next call, clear the memo and refetch.

**Pros:** Self-healing within the hour; minimal LQwD load.
**Cons:** Adds time-based state; small test surface.
**Effort:** Small.
**Risk:** Low.

### Option B — Document trade-off and rely on reload

Keep current behavior; add a doc comment explaining "LQwD pubkey rotation requires page reload" and lean on the fallback to absorb the gap.

**Pros:** Zero code change; current fallback already covers the failure mode.
**Cons:** Real-world cost of a stale memo is one wasted primary attempt per receive until reload.
**Effort:** Trivial.
**Risk:** Low.

## Recommended Action

Defer until we see telemetry indicating it matters; if any user reports "every receive falls back to Megalith" we revisit. Capture decision in the module doc comment now.

## Technical Details

- **Affected files:** `src/ldk/lsp/lqwd-discovery.ts`.

## Acceptance Criteria

- [ ] Either a TTL refresh, or a doc comment explicitly calling out the lifetime contract.
- [ ] Tests / build / lint stay green.

## Work Log

| Date       | Action                                    | Notes                      |
| ---------- | ----------------------------------------- | -------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | kieran-typescript-reviewer |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/lsp/lqwd-discovery.ts:23, 63-65`
