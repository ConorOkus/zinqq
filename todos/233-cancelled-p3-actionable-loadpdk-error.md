---
status: cancelled
priority: p3
issue_id: '233'
tags: [code-review, payjoin, devx, error-handling]
dependencies: ['222']
---

# `loadPdk()`: actionable error when `dist/` is empty

## Problem Statement

If a contributor imports `loadPdk()` without having run `pnpm payjoin:build`, the failure is Vite's generic "cannot resolve 'payjoin'" — not a hint to run the build step.

Agents (and humans) benefit from the error being actionable.

## Findings

- `src/onchain/payjoin/payjoin.ts:11` — `await import('payjoin')` surfaces the raw resolver error.

Flagged by `agent-native-reviewer` (P3).

## Proposed Solution

Wrap the dynamic import so a resolution failure (distinct from a runtime WASM init failure) throws a named error referencing the fix:

```ts
try {
  var mod = await import('payjoin')
} catch (err) {
  throw new Error(
    'Payjoin bindings not built. Run `pnpm payjoin:build` from the repo root. Underlying error: ' +
      String(err)
  )
}
await mod.uniffiInitAsync()
```

Only the import is wrapped; a later failure in `uniffiInitAsync()` still surfaces directly.

- Effort: Small.
- Risk: None.

## Technical Details

- Affected file: `src/onchain/payjoin/pdk.ts` (renamed per #227) or `src/onchain/payjoin/payjoin.ts` if #227 hasn't landed

## Acceptance Criteria

- [ ] Empty `dist/` yields a clear "run pnpm payjoin:build" error
- [ ] `uniffiInitAsync` failures still surface with their own error message

## Work Log

## Resources

- PR #140

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
