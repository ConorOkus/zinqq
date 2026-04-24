---
status: complete
priority: p1
issue_id: '222'
tags: [code-review, payjoin, simplicity, correctness]
dependencies: []
---

# `loadPdk()`: delete the `.catch` retry path (race + dead code)

## Problem Statement

`loadPdk()` currently tries to clear `pdkPromise` when `uniffiInitAsync` rejects, so a subsequent call retries from scratch. Two reviewers independently flagged this as wrong in opposite ways: the retry is both **buggy** and **unneeded**.

Phase 2 ships no caller of `loadPdk`, so there's no product requirement for retry behaviour — WASM load failure generally means the binary itself is broken and a retry won't rescue it.

## Findings

- **`src/onchain/payjoin/payjoin.ts:10-15`** — the `.catch` clears `pdkPromise` **after** the rejection has already propagated to awaiting callers. If callers A and B both invoke `loadPdk()` in the same microtask tick and `uniffiInitAsync` rejects, both receive the doomed promise before the `.catch` runs; B has no way to retry even though the rule was supposed to allow it.
- **`src/onchain/payjoin/payjoin.test.ts:33-39`** — the retry test passes only because it awaits the failure **fully** before calling `loadPdk()` again. It never exercises the concurrent-failure window, so the test is green against code that's broken for the case the `.catch` was added to handle.
- The PR has no caller of `loadPdk` anywhere in the app (confirmed by grep). Phase 3 is where a caller lands; we can add retry behaviour there if a real need emerges.

Flagged by `kieran-typescript-reviewer` (P1, race) and `code-simplicity-reviewer` (P1, dead code). Both point at the same code with opposite remediations; deletion resolves both.

## Proposed Solutions

### Option 1 — Delete the `.catch` + retry test (recommended)

```ts
export function loadPdk(): Promise<Pdk> {
  if (pdkPromise) return pdkPromise
  pdkPromise = (async () => {
    const mod = await import('payjoin')
    await mod.uniffiInitAsync()
    return mod.payjoin
  })()
  return pdkPromise
}
```

And drop the `'allows retry after a failed init'` test.

- Pros: YAGNI-aligned; removes the race entirely; ~4 lines gone.
- Cons: If WASM load is genuinely flaky (unlikely for local bundled WASM), callers get a permanent rejection.
- Effort: Small.
- Risk: Low.

### Option 2 — Keep retry but fix the race

Move the reset inside the IIFE's try/catch so it's synchronous with the failure:

```ts
pdkPromise = (async () => {
  try {
    const mod = await import('payjoin')
    await mod.uniffiInitAsync()
    return mod.payjoin
  } catch (err) {
    pdkPromise = null
    throw err
  }
})()
```

Add a concurrent-failure test.

- Pros: Preserves retry semantics for whoever needs them in Phase 3.
- Cons: Solves a problem no caller has yet; more test surface.
- Effort: Small.
- Risk: Low.

## Recommended Action

Option 1. Add the retry path when Phase 3 proves it's needed.

## Technical Details

- Affected files: `src/onchain/payjoin/payjoin.ts`, `src/onchain/payjoin/payjoin.test.ts`

## Acceptance Criteria

- [ ] `.catch` removed from `loadPdk`
- [ ] "allows retry after a failed init" test removed
- [ ] Remaining two tests still pass
- [ ] `pnpm typecheck` + `pnpm lint` clean

## Work Log

## Resources

- PR #140
