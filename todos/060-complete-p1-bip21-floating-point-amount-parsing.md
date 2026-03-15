---
status: pending
priority: p1
issue_id: "060"
tags: [code-review, security]
dependencies: []
---

# BIP21 amount parsing uses floating-point arithmetic

## Problem Statement

The BIP21 parser converts BTC amounts to sats using `BigInt(Math.round(parseFloat(amountBtc) * 1e8))`. IEEE 754 floating-point precision errors can cause off-by-one satoshi amounts for values with many significant digits (e.g., `21000000.00000001`). Additionally, `parseFloat` accepts `Infinity`, `NaN`, and scientific notation, which cause uncaught `RangeError` exceptions from `BigInt()`.

## Findings

**Location:** `src/onchain/bip21.ts`, line 20

```typescript
amountSats = BigInt(Math.round(parseFloat(amountBtc) * 1e8))
```

Flagged by: kieran-typescript-reviewer, security-sentinel, architecture-strategist, code-simplicity-reviewer

## Proposed Solutions

### Option A: Fixed-point string parsing (Recommended)
Split on decimal point, pad/truncate to 8 decimal places, convert to BigInt. No floating-point involved.

```typescript
function btcStringToSats(btcStr: string): bigint | null {
  const trimmed = btcStr.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  const padded = (frac + '00000000').slice(0, 8)
  return BigInt(whole) * 100_000_000n + BigInt(padded)
}
```

- Pros: Exact conversion, handles all valid BIP21 amounts, rejects garbage input
- Cons: Slightly more code
- Effort: Small
- Risk: Low

### Option B: Add guards around parseFloat
Keep parseFloat but validate the result is finite and within BTC supply range.

- Pros: Minimal code change
- Cons: Still has precision issues for edge-case amounts
- Effort: Small
- Risk: Medium (doesn't fix the core precision issue)

## Acceptance Criteria

- [ ] BIP21 amounts are parsed using fixed-point arithmetic (no parseFloat)
- [ ] Invalid values (Infinity, NaN, negative, non-numeric) return null
- [ ] Test case for large amount with sub-satoshi precision: `21000000.00000001` → `2100000000000001n`
- [ ] Test case for `amount=Infinity` returns null
