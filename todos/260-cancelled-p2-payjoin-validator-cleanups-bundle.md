---
status: cancelled
priority: p2
issue_id: '260'
tags: [code-review, payjoin, validator, type-safety]
dependencies: []
---

# Validator small fixes bundle: `implements` declaration, OutPoint.toString, scriptsEqual idiom

## Problem Statement

Three small validator-area fixes that should land together:

1. `MemSenderPersister` (`payjoin.ts:55-64`) is structurally compatible with PDK's `JsonSenderSessionPersister` interface but is not declared `implements`. If PDK adds a method in a future bump, drift is silent until runtime.

2. `proposal-validator.ts:50-58` constructs outpoint keys via string interpolation `` `${i.previous_output.txid.toString()}:${i.previous_output.vout}` ``. BDK's `OutPoint.toString()` (`bitcoindevkit.d.ts:598`) emits exactly that format. Half the LOC, no string-format drift risk.

3. `proposal-validator.ts:16-24` `scriptsEqual` byte-by-byte loop is ~1990s style. `aBytes.every((b, i) => b === bBytes[i])` after the length check is more idiomatic.

## Findings

- **kieran-typescript-reviewer P2 #10**: missing `implements`.
- **kieran-typescript-reviewer P3 #15**: duplicated outpoint-key string construction.
- **kieran-typescript-reviewer P3 #16**: scriptsEqual modernization.

## Proposed Solutions

### Option 1 — Apply all three

Each fix is isolated and small. Land together.

- Pros: cleans three minor issues at once; no functional change.
- Cons: small; could be deferred.

## Recommended Action

Option 1. Quick bundled cleanup PR after the P1s land.

## Technical Details

- Affected files:
  - `src/onchain/payjoin/payjoin.ts:55-64` — add `import type { JsonSenderSessionPersister } from 'payjoin'` and `implements` clause
  - `src/onchain/payjoin/proposal-validator.ts:50-58` — use `i.previous_output.toString()`
  - `src/onchain/payjoin/proposal-validator.ts:16-24` — `every`-based comparison

## Acceptance Criteria

- [ ] `MemSenderPersister implements JsonSenderSessionPersister`
- [ ] OutPoint.toString() used for outpoint key construction
- [ ] scriptsEqual uses `every`
- [ ] Existing tests pass

## Work Log

## Resources

- PR #143
- BDK API: `bitcoindevkit.d.ts:598` (OutPoint.toString)
- PDK API: `payjoin.d.ts:4429-4433` (JsonSenderSessionPersister)

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
