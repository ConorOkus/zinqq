---
status: complete
priority: p2
issue_id: '227'
tags: [code-review, payjoin, naming, simplicity]
dependencies: []
---

# Rename `src/onchain/payjoin/payjoin.ts` → `src/onchain/payjoin/pdk.ts`

## Problem Statement

The file sits inside a `payjoin/` directory and is itself named `payjoin.ts`. Imports like `from './payjoin/payjoin'` read poorly, and the file's actual responsibility is narrow — loading the PDK WASM module — not "Payjoin, the feature."

## Findings

- `src/onchain/payjoin/payjoin.ts` exports one function: `loadPdk`.
- Phase 3 (`docs/plans/2026-04-23-001-feat-payjoin-send-support-plan.md:402-411`) adds `tryPayjoinSend` and `validateProposal` as separate files. Those modules will also want to import `loadPdk` — `from './pdk'` reads better than `from './payjoin'`.

Flagged by `architecture-strategist` (P3, naming) — promoted to P2 because renaming is cheapest now, before Phase 3 locks in import paths.

## Proposed Solution

```sh
git mv src/onchain/payjoin/payjoin.ts   src/onchain/payjoin/pdk.ts
git mv src/onchain/payjoin/payjoin.test.ts src/onchain/payjoin/pdk.test.ts
```

No other file imports it yet, so the rename is local.

- Effort: Small.
- Risk: None.

## Technical Details

- Affected files: `src/onchain/payjoin/payjoin.ts` → `pdk.ts`; same for the test file

## Acceptance Criteria

- [ ] Files renamed
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` pass

## Work Log

## Resources

- PR #140
