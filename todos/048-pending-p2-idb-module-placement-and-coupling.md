---
status: pending
priority: p2
issue_id: "048"
tags: [code-review, architecture]
dependencies: []
---

# IDB module lives in ldk/ but serves all modules; bidirectional ldk/onchain coupling

## Problem Statement

`src/ldk/storage/idb.ts` is imported by `wallet/`, `onchain/`, and `ldk/` — it's shared infrastructure in an LDK-specific directory. Additionally, `ldk/traits/event-handler.ts` imports from `onchain/storage/changeset.ts` while `onchain/context.tsx` imports from `ldk/use-ldk.ts`, creating a bidirectional dependency between modules.

## Findings

- **IDB placement:** `wallet/mnemonic.ts` and `onchain/storage/changeset.ts` both import from `ldk/storage/idb`
- **Bidirectional coupling:** `ldk/event-handler → onchain/changeset` AND `onchain/context → ldk/use-ldk`
- **DB name:** Still `browser-wallet-ldk` despite serving all modules
- **Agent:** architecture-strategist (Recommendation 1, 2)

## Proposed Solutions

### Option A: Move IDB to shared `src/storage/` (Recommended)
Move `idb.ts` to `src/storage/idb.ts`. Rename DB to `browser-wallet`. Update all imports.
- **Effort:** Small | **Risk:** Low

### Option B: Also break bidirectional coupling
Introduce a `FundingWallet` interface in shared types. LDK depends on the interface, OnchainProvider implements it.
- **Effort:** Medium | **Risk:** Low

## Acceptance Criteria
- [ ] `idb.ts` lives in a module-neutral location
- [ ] DB name reflects its multi-module scope
- [ ] No `wallet/` or `onchain/` module imports from `ldk/` internals
