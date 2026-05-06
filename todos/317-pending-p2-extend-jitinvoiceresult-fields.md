---
status: pending
priority: p2
issue_id: '317'
tags: [code-review, types, pr-150]
dependencies: []
---

# Extend `JitInvoiceResult` with `expectedReceiveMsat` and `lspNodeId`

## Problem Statement

`executeJitBuy` returns `JitInvoiceResult` carrying only `bolt11`, `openingFeeMsat`, `paymentHash`. The buy resolves a real channel commitment with an LSP, and consumers re-derive the net amount (`amountSats - openingFeeSats`) at multiple call sites in `Receive.tsx`. The result should include the values it already knows — saving callers from re-doing math and clarifying which LSP committed.

## Findings

- **File**: `src/ldk/lsps2/types.ts:48-52` (`JitInvoiceResult`)
- **File**: `src/ldk/context.tsx:326` (`expectedReceiveMsat` already computed and discarded)
- **File**: `src/pages/Receive.tsx:626, 637, 438` — net amount re-derived 3x with the same `(x + 999n) / 1000n` ceiling
- **Identified by**: kieran-typescript-reviewer (#5)

## Proposed Solutions

### Option A: Add fields (Recommended)

```ts
export interface JitInvoiceResult {
  bolt11: string
  openingFeeMsat: bigint
  paymentHash: string
  expectedReceiveMsat: bigint  // NEW: amount - opening fee
  lspNodeId: string            // NEW: which LSP committed (for telemetry / display)
}
```

- `executeJitBuy` populates them at `:319-326`
- `Receive.tsx` consumes `expectedReceiveMsat` directly instead of re-deriving
- **Pros**: DRY; honest contract; future telemetry can attribute commitments to a specific LSP
- **Cons**: Touches the type and ~3 call sites
- **Effort**: Small

### Option B: Leave as-is

- Document that callers must re-derive
- **Pros**: No change
- **Cons**: Bug surface; net-amount re-derivation is fragile

## Recommended Action

(Filled during triage)

## Technical Details

- **Affected files**: `src/ldk/lsps2/types.ts`, `src/ldk/context.tsx`, `src/pages/Receive.tsx`, tests

## Acceptance Criteria

- [ ] `JitInvoiceResult` includes `expectedReceiveMsat` and `lspNodeId`
- [ ] `executeJitBuy` populates both
- [ ] `Receive.tsx` consumes `expectedReceiveMsat` instead of re-deriving
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/150
