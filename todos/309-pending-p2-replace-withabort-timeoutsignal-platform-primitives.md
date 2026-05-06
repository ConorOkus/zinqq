---
status: pending
priority: p2
issue_id: '309'
tags: [code-review, simplicity, typescript, pr-150]
dependencies: []
---

# Replace `withAbort` + `timeoutSignal` with `AbortSignal.any` / `AbortSignal.timeout`

## Problem Statement

`src/ldk/context.tsx:120-210` defines `withAbort(promise, signal)`, `timeoutSignal(parent, ms)`, `abortError()`, and `timeoutError()` — ~62 LOC reimplementing what platform primitives already provide. The codebase already uses `AbortSignal.timeout()` and `AbortSignal.any()` in 7 places (`Send.tsx`, `esplora-client.ts`, `rapid-gossip-sync.ts`, `vss-client.ts`, `lqwd-discovery.ts`, plus tests), so reinventing here is pure inconsistency.

`withAbort` itself only exists because the LSPS2 RPC primitives (`getOpeningFeeParams`, `buyChannel`) don't accept an `AbortSignal`. It doesn't actually cancel the underlying RPC — it only short-circuits the await for the caller. If we plumb `AbortSignal` into `LSPS2Client` upstream, `withAbort` disappears entirely.

## Findings

- **File**: `src/ldk/context.tsx:120-210` (helpers), 5 call sites within `getJitQuote`
- **Identified by**: kieran-typescript-reviewer (#6), code-simplicity-reviewer (#1), architecture-strategist (#5)
- `timeoutSignal(parent, ms)` collapses to: `AbortSignal.any([parent, AbortSignal.timeout(ms)])`
- `timeoutError`'s name is `'AbortError'` not `'TimeoutError'`, which muddles `classifyJitTrigger` — it can't distinguish user-cancel from per-LSP timeout

## Proposed Solutions

### Option A: Replace with platform primitives only (Recommended for first pass)

- `timeoutSignal` → `AbortSignal.any([parent, AbortSignal.timeout(ms)])` at the call site
- Keep `withAbort` for now (RPC primitives still don't take a signal)
- Use distinct error names (`'TimeoutError'` vs `'AbortError'`) so `classifyJitTrigger` can branch
- **Pros**: Removes the `timeoutSignal` helper (~30 LOC), aligns with codebase, fixes the trigger-classification bug
- **Cons**: `withAbort` stays
- **Effort**: Small
- **Risk**: Low

### Option B: Fully eliminate the wrappers

- Plumb `AbortSignal` into `LSPS2Client.getOpeningFeeParams` / `buyChannel` / `createJitInvoice`
- Use `signal.throwIfAborted()` between RPC steps; pass `signal` directly to fetch-level primitives
- Remove `withAbort` entirely (~25 LOC) and its 5 call sites become bare awaits
- **Pros**: True cancellation; ~55 LOC removed total; idiomatic
- **Cons**: Touches the LSPS2 client + the underlying request transport (`message-handler.ts`); larger surface
- **Effort**: Medium

## Recommended Action

(Filled during triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`; for Option B also `src/ldk/lsps2/client.ts` and message-handler

## Acceptance Criteria

- [ ] `timeoutSignal` removed in favor of `AbortSignal.any([parent, AbortSignal.timeout(ms)])`
- [ ] `timeoutError` distinguishes from `abortError` (different `name` so `classifyJitTrigger` can tell them apart)
- [ ] (Option B): `withAbort` removed and signal threaded into LSPS2 client
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Existing usage: `Send.tsx:245`, `esplora-client.ts:92-94`, `rapid-gossip-sync.ts:63`, `vss-client.ts:241`, `lqwd-discovery.ts:34`
