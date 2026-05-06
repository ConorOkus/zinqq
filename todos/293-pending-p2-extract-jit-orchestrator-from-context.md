---
status: pending
priority: p2
issue_id: 293
tags: [code-review, refactor, architecture, pr-148]
dependencies: []
---

# P2 — Extract JIT orchestrator from `context.tsx` to its own module

## Problem Statement

PR #148 lands `runJitInvoiceFlow`, `attemptJitInvoiceWithLsp`, `JitPeerConnectError`, `JitPaymentSizeOutOfRangeError`, `classifyJitTrigger`, and the `ConnectFn` / `AttemptJitInvoiceFn` types as **module-level exports from `src/ldk/context.tsx`** (lines ~60-279). These are pure transport-orchestration logic — they don't touch React state, refs, or the provider tree.

Two consequences:

1. **`react-refresh/only-export-components` warning** at the top of `context.tsx`. This file used to export only the `LdkProvider` component; now it mixes component exports with non-component exports, which breaks Vite Fast Refresh boundaries for the whole file.
2. **The test file `src/ldk/lsp/jit-failover.test.ts` imports from `../context`** — a React-aware module — to reach pure functions. That import path is the architectural tell that the orchestrator wants its own home.

`context.tsx` is now ~1100 lines. It's already a kitchen-sink module; this PR adds another ~220 lines of pure logic that has a natural separate-module home (we already created `src/ldk/lsp/`).

## Findings

- **New non-component exports** at `src/ldk/context.tsx:62, 67, 107` (the two error classes + `runJitInvoiceFlow`).
- **Test import** at `src/ldk/lsp/jit-failover.test.ts:6`: `import { runJitInvoiceFlow, JitPeerConnectError, JitPaymentSizeOutOfRangeError } from '../context'`.
- **Lint warning** present in `pnpm lint` output: `react-refresh/only-export-components` — currently 14 warnings total in the codebase, but this PR added one of them.

## Proposed Solutions

### Option A — Extract to `src/ldk/lsp/jit-orchestrator.ts`

Move the following to a new file:

- `JitPeerConnectError`, `JitPaymentSizeOutOfRangeError`
- `JitTrigger` type, `classifyJitTrigger`
- `ConnectFn`, `AttemptJitInvoiceFn` types
- `runJitInvoiceFlow`
- `attemptJitInvoiceWithLsp`

`context.tsx` keeps only `requestJitInvoice` (the React `useCallback` wrapper at the inner provider).

Test file changes: `import { ... } from '../context'` → `import { ... } from './jit-orchestrator'`.

**Pros:** Clean separation. Removes the Fast Refresh warning. Test file imports become pure (no React module). Discoverable home for future LSPS additions.

**Cons:** Moves ~220 lines across files (touches the diff size, but no behavior change).

**Effort:** Small.

**Risk:** Very low — pure code movement, no behavior change.

### Option B — Add `// eslint-disable-next-line react-refresh/only-export-components` and leave structure alone

**Pros:** Tiny diff.

**Cons:** Doesn't fix the underlying coupling. `context.tsx` keeps growing.

**Effort:** Trivial.

**Risk:** Technical debt accrual.

## Recommended Action

(triage — Option A is my lean.)

## Technical Details

- **Affected files:**
  - New: `src/ldk/lsp/jit-orchestrator.ts`
  - Modified: `src/ldk/context.tsx` (remove the moved code, replace with imports)
  - Modified: `src/ldk/lsp/jit-failover.test.ts` (import path swap)
- **No behavior change.** Pure relocation.

## Acceptance Criteria

- [ ] `runJitInvoiceFlow`, both error classes, `attemptJitInvoiceWithLsp`, and the type aliases live in `src/ldk/lsp/jit-orchestrator.ts`.
- [ ] `context.tsx` no longer exports any non-component identifiers from the receive flow.
- [ ] Test file imports from `./jit-orchestrator`, not `../context`.
- [ ] `pnpm lint` warning count for `react-refresh/only-export-components` decreases by exactly 1.
- [ ] All 21 LSP-failover tests still pass.

## Work Log

| Date       | Action                                    | Notes                                                                  |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| 2026-05-05 | Discovered during `/ce:review` of PR #148 | kieran-typescript-reviewer + architecture-strategist both recommended. |

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/148
- Source: `src/ldk/context.tsx:60-279, 482-496`
- Test: `src/ldk/lsp/jit-failover.test.ts:6`
