---
status: complete
priority: p1
issue_id: '307'
tags: [code-review, agent-native, pr-150]
dependencies: []
---

# Expose `window.__receive` for agent-native parity

## Problem Statement

This PR removes `requestJitInvoice` from the LDK context and adds `requestJitQuote` + `executeJitBuy` as the new two-phase API. Both are React-context methods, only reachable via `useLdk()` from inside the React tree. The pre-PR flow (single-tap to receive) had a chance of being driven programmatically; the new two-screen flow with a manual "Generate Payment Request" tap is **human-only**. Agent parity for the receive flow is broken.

The codebase already exposes `__ldkNode` and `__recovery` on `window` for agent/programmatic access (`src/ldk/context.tsx:924-937`). The new receive primitives should follow the same pattern.

## Findings

- **File**: `src/ldk/context.tsx:924-937` (existing `__ldkNode` / `__recovery` pattern)
- **File**: `src/pages/Receive.tsx:31-52` (state machine is React-internal)
- **Identified by**: agent-native-reviewer (P1)
- Pre-PR: an agent could in DEV reach `__ldkNode.channelManager` to drive a JIT receive — though that path was already imperfect because `__ldkNode` strips `nodeSecretKey` (`context.tsx:927`).
- Post-PR: even with `__ldkNode`, `executeJitBuy` requires the secret key (`context.tsx:346`), so reproduction is impossible from the existing surface alone.
- Verdict from the agent-native-reviewer: 0/2 new capabilities are agent-accessible.

## Proposed Solutions

### Option A: Add `window.__receive` accessor in `setState({status:'ready', ...})` block (Recommended)

```ts
// src/ldk/context.tsx — alongside the existing __recovery exposure
;(window as unknown as Record<string, unknown>).__receive = {
  quote: (amountSats: bigint, signal?: AbortSignal) =>
    requestJitQuote(amountSats * 1000n, signal ?? new AbortController().signal),
  commit: (quote: JitQuote, description = 'zinqq wallet', signal?: AbortSignal) =>
    executeJitBuyCallback(quote, description, signal ?? new AbortController().signal),
  createInvoice, // for the standard non-JIT path
}
```

- Available in all environments (matches `__recovery`'s rationale at `:932-933`)
- **Pros**: Restores parity with ~10 LOC; agent can drive both phases plus the standard path
- **Cons**: Adds a global accessor; needs cleanup on unmount
- **Effort**: Small
- **Risk**: Low — same pattern is already in use

### Option B: Document that receive is human-only

- Add a JSDoc/comment noting that the receive flow now requires UI interaction
- **Pros**: No code change
- **Cons**: Action parity broken, regresses agent-native posture
- **Effort**: Tiny
- **Risk**: Reputational — violates the agent-native principle

## Recommended Action

(Filled during triage — Option A)

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, possibly typings for `window.__receive`
- **Cleanup**: Match the `__recovery` pattern's lifecycle (set in ready state, no explicit removal — the page lifecycle handles it)

## Acceptance Criteria

- [ ] `window.__receive = { quote, commit, createInvoice }` set in the ready-state block of LdkProvider
- [ ] JSDoc on each method explaining the two-phase contract (`quote` is failover-safe + idempotent; `commit` reserves LSP liquidity and must not be retried blindly)
- [ ] Manual smoke test: in DEV, call `await window.__receive.quote(10_000n)` and verify a JitQuote is returned
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

- **2026-05-06** — Resolved via Option A. Added `window.__receive = { quote, commit, createInvoice }` next to the existing `__recovery` exposure in the LDK provider's ready-state block. `quote(amountSats, signal?)` takes sats (mirrors the UI; converts to msat internally) and returns a `JitQuote`. `commit(quote, description?, signal?)` runs Phase B. Both accept an optional signal and default to a fresh `AbortController`. JSDoc on the block documents the failover-safe vs. liquidity-reserving distinction. PR #150 commit `6e07bd9`.

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
- Existing pattern: `src/ldk/context.tsx:924-937`
