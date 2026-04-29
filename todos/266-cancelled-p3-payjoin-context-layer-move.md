---
status: cancelled
priority: p3
issue_id: '266'
tags: [code-review, payjoin, architecture, layering]
dependencies: []
---

# `PayjoinContext` lives in the LDK layer but is on-chain only

## Problem Statement

`PayjoinContext` is exported from `src/ldk/payment-input.ts:61-69` because that's where BIP 321 URIs are parsed. But Payjoin is on-chain only (`Send.tsx:1198` even gates on this). `payjoin.ts:3` does:

```ts
import type { PayjoinContext } from '../../ldk/payment-input'
```

`onchain/` reaching into `ldk/` for an on-chain-only concept inverts the layer.

## Findings

- **architecture-strategist #5**: layering inversion. Works today, but smells.

## Proposed Solutions

### Option 1 (recommended) — Move `PayjoinContext` to on-chain layer

- New file: `src/onchain/payjoin/types.ts` exports `PayjoinContext`
- `src/ldk/payment-input.ts` imports it from there

Or fold it into `src/onchain/payjoin/payjoin.ts` directly since that's the primary consumer.

- Pros: layering respects domain ownership; LDK becomes a parser-only consumer.
- Cons: one extra import in `payment-input.ts`.

## Recommended Action

Option 1. Defer — works today, low priority.

## Technical Details

- Affected files:
  - `src/ldk/payment-input.ts` — change export to import
  - `src/onchain/payjoin/types.ts` (new) or move into existing `payjoin.ts`
  - `src/pages/Send.tsx` — update import path

## Acceptance Criteria

- [ ] `PayjoinContext` exported from `src/onchain/payjoin/`
- [ ] `payment-input.ts` imports the type
- [ ] Typecheck clean

## Work Log

## Resources

- PR #143
- architecture-strategist agent report

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
