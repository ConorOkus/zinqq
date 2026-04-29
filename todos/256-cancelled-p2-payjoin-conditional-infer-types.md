---
status: cancelled
priority: p2
issue_id: '256'
tags: [code-review, payjoin, type-safety, pdk]
dependencies: []
---

# Replace conditional-`infer` type chains with named PDK imports + drop eslint-disable on enum comparison

## Problem Statement

`payjoin.ts` declares three intermediate types via distributive conditional `infer` chains:

- Line 162-166: `pjUri` (resolves to `PjUriInterface` via `checkPjSupported`)
- Line 177-179: `reqCtx` (resolves to `WithReplyKeyInterface`)
- Line 223: `outcome` (resolves to `PollingForProposalTransitionOutcome`)

PDK already exports concrete named types for all three (verified in `vendor/rust-payjoin/payjoin-ffi/javascript/dist/generated/payjoin.d.ts`). The conditional types add visual noise, fail the 5-second readability rule, and silently break if PDK refactors internal call shapes.

Adjacent issue: `payjoin.ts:245, 269` use `// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison` to compare `outcome.tag` to string literals `'Progress'` / `'Stasis'`. The PDK exports `PollingForProposalTransitionOutcome_Tags.Progress = "Progress"`; comparing against the enum value removes both suppressions.

## Findings

- **kieran-typescript-reviewer P1 #3**: `ReturnType<...> extends infer U ? U extends ... : never : never` over-engineering — just import the named types.
- **kieran-typescript-reviewer P1 #4**: enum comparison should reference `_Tags` enum, not string literals.
- **code-simplicity-reviewer #4**: confirmed PDK types `PjUri`, `WithReplyKey`, `V2GetContext` are exported.

## Proposed Solutions

### Option 1 (recommended) — Import named types

```ts
import type {
  PjUriInterface,
  WithReplyKeyInterface,
  PollingForProposalTransitionOutcome,
  PollingForProposalTransitionOutcome_Tags,
} from 'payjoin'

// ...

let pjUri: PjUriInterface
let reqCtx: WithReplyKeyInterface
let outcome: PollingForProposalTransitionOutcome

// Later:
if (outcome.tag === PollingForProposalTransitionOutcome_Tags.Progress) { ... }
if (outcome.tag === PollingForProposalTransitionOutcome_Tags.Stasis) { ... }
```

- Pros: self-documenting; fails loudly on upstream renames; removes 12+ LOC and 2 eslint-disable suppressions; named types are stable across PDK minor versions.
- Cons: requires `import type { ... } from 'payjoin'` — adds a small surface area to the PDK boundary in source.

### Option 2 — Drop type annotations entirely, let TS infer

Skip the explicit `let pjUri: ...` and just `const pjUri = pdk.Uri.parse(...).checkPjSupported()` directly.

- Pros: zero typing ceremony.
- Cons: doesn't help with the eslint-disable; still needs annotations on `let` declarations across try/catch boundaries.

## Recommended Action

Option 1. Concrete named imports. Verify the exact symbols exist in the PDK package (grep the .d.ts for the precise names).

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.ts` lines 162-166, 177-179, 192, 223, 245, 269
- Verify `import type { PjUriInterface, WithReplyKeyInterface, PollingForProposalTransitionOutcome, PollingForProposalTransitionOutcome_Tags } from 'payjoin'` works against the current PDK build

## Acceptance Criteria

- [ ] Conditional `infer` type chains replaced with named imports
- [ ] Both `eslint-disable-next-line` suppressions removed
- [ ] `pnpm typecheck` clean
- [ ] No new lint warnings

## Work Log

## Resources

- PR #143
- PDK type definitions: `vendor/rust-payjoin/payjoin-ffi/javascript/dist/generated/payjoin.d.ts`

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
