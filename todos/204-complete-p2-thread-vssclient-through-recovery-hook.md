---
status: pending
priority: p2
issue_id: '204'
tags: [code-review, architecture, recovery]
dependencies: []
---

# Thread vssClient through recovery hook to fix VSS durability gap

## Problem Statement

`useRecovery(null)` is called in both `Home.tsx` and `RecoverFunds.tsx`, meaning all user-driven state transitions (viewing recovery screen, dismissing success banner) only write to IDB — VSS is silently skipped. Entry into recovery is VSS-durable (called from context.tsx with real vssClient), but user actions are IDB-only. This creates cross-device state inconsistency.

Additionally, the module-level `let vssVersion = 0` in `recovery-state.ts` has no concurrency guard. Two concurrent `writeRecoveryState` calls can race, and the conflict-retry logic re-writes stale state without re-reading from VSS.

## Findings

**1. `useRecovery(null)` in UI components (Home.tsx:18, RecoverFunds.tsx:10)**
`dismiss()` calls `clearRecoveryState(null)` which no-ops the VSS delete. Stale VSS state resurrects on a fresh device.

**2. `vssVersion` module global (recovery-state.ts:26)**
Breaks from the established `versionCache` Map pattern in `persist.ts`. On conflict retry, overwrites VSS with stale state parameter.

**Sources:** kieran-typescript-reviewer (#2, #3), security-sentinel (#2), architecture-strategist

## Proposed Solutions

### Option A: Expose vssClient from LdkContext (Recommended)

- Add `vssClient: VssClient | null` to the `LdkContextValue` ready state
- `useRecovery` reads it from context instead of taking a parameter
- **Effort:** Small | **Risk:** Low

### Option B: Create a RecoveryProvider

- Wrap `useRecovery` in a dedicated provider that receives `vssClient` from LdkProvider
- More separation but more boilerplate
- **Effort:** Medium | **Risk:** Low

## Acceptance Criteria

- [ ] `useRecovery` no longer accepts `null` for vssClient — gets it from context
- [ ] `dismiss()` and `setStatus()` calls from UI write to both IDB and VSS
- [ ] On conflict retry, re-read VSS state before overwriting

## Work Log

| Date       | Action                           | Learnings                                                    |
| ---------- | -------------------------------- | ------------------------------------------------------------ |
| 2026-04-14 | Created from PR #128 code review | Architecture mismatch: entry path is durable, UI path is not |

## Resources

- PR: #128
- Files: `src/ldk/recovery/recovery-state.ts:26`, `src/pages/Home.tsx:18`, `src/pages/RecoverFunds.tsx:10`
- Pattern reference: `src/ldk/traits/persist.ts` (versionCache)
