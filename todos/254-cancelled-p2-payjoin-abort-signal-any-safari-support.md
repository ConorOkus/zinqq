---
status: cancelled
priority: p2
issue_id: '254'
tags: [code-review, payjoin, browser-compat, abort]
dependencies: []
---

# `AbortSignal.any` browser support footgun (Safari < 17.4)

## Problem Statement

`Send.tsx:628` uses `AbortSignal.any([ctx.signal, payjoinAbort.signal])`. `AbortSignal.any` is Baseline-2024; Safari shipped it in 17.4 (Mar 2024). For users on iOS 16 or older Safari, the call throws and the page errors. There is no try/catch and no fallback.

## Findings

- **kieran-typescript-reviewer P2 #6**: composeSignal in payjoin.ts:113 already implements 1-parent-plus-timeout composition manually. Extract to a multi-parent helper and use it both in Send.tsx and payjoin.ts.

## Proposed Solutions

### Option 1 (recommended) — Extract `composeSignals(parents, timeoutMs?)`

Single helper at `src/utils/abort.ts` (or `src/onchain/payjoin/abort.ts`):

```ts
export function composeSignals(
  parents: AbortSignal[],
  timeoutMs?: number
): { signal: AbortSignal; cleanup: () => void } {
  // unify the 1-parent and N-parent paths; optional timeout
}
```

Use it in `Send.tsx` and replace the existing `composeSignal` in `payjoin.ts`.

- Pros: kills browser-support risk; deduplicates the abort-listener boilerplate; reusable.
- Cons: small upfront helper.

### Option 2 — Pin `AbortSignal.any` and document the iOS 16 floor

Update `package.json` browserslist or README to declare iOS ≥ 17.4. Lose the long tail.

- Pros: cheap.
- Cons: real users on older iOS would see crashes.

## Recommended Action

Option 1. Extract the helper, replace both call sites.

## Technical Details

- Affected files:
  - `src/pages/Send.tsx:628` (replace `AbortSignal.any` call)
  - `src/onchain/payjoin/payjoin.ts:113-134` (replace `composeSignal`)
- New file: `src/onchain/payjoin/abort.ts` or `src/utils/abort.ts`
- Test: unit-test the helper with fake timers + multiple parent abort

## Acceptance Criteria

- [ ] `composeSignals` helper extracted with unit tests
- [ ] `AbortSignal.any` no longer used directly
- [ ] Manual smoke test in Safari 16 simulator (or document the deferral)

## Work Log

## Resources

- PR #143
- Existing pattern: `src/ldk/sync/esplora-client.ts:91-95` already uses `AbortSignal.any` — this todo would migrate that too, OR scope to Payjoin paths only

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
