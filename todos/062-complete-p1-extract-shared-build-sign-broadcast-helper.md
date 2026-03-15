---
status: pending
priority: p1
issue_id: "062"
tags: [code-review, architecture]
dependencies: []
---

# Extract shared build-sign-broadcast helper from sendToAddress/sendMax

## Problem Statement

`sendToAddress` and `sendMax` in context.tsx share ~90% identical safety-critical code: pause sync, get fee rate, build tx, fee sanity check, sign, persist changeset, extract tx, broadcast, resume sync. The only difference is the TxBuilder chain. If a bug fix is applied to one path but not the other, it creates a silent divergence in safety-critical logic.

## Findings

**Location:** `src/onchain/context.tsx`, lines 162-245

Both functions contain identical: sync pause/resume, fee rate fetch, fee sanity check (MAX_FEE_SATS), wallet.sign(), persistChangeset(), psbt.extract_tx(), esplora.broadcast(), mapSendError().

Flagged by: kieran-typescript-reviewer, code-simplicity-reviewer, architecture-strategist

## Proposed Solutions

### Option A: Extract buildSignBroadcast helper (Recommended)
Create a private helper that takes a callback for PSBT construction:

```typescript
async function buildSignBroadcast(
  wallet: Wallet,
  esplora: EsploraClient,
  syncHandle: OnchainSyncHandle | null,
  buildPsbt: (feeRate: FeeRate) => Psbt,
): Promise<string> {
  syncHandle?.pause()
  try {
    const feeRateSatVb = await getFeeRate(esplora)
    const psbt = buildPsbt(new FeeRate(feeRateSatVb))
    // ... fee check, sign, persist, broadcast
  } catch (err) { throw mapSendError(err) }
  finally { syncHandle?.resume() }
}
```

- Pros: Safety invariants in one place, ~25 LOC saved, extensible for future send variants (RBF, batch)
- Cons: Slightly more abstract
- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] Single helper contains all safety-critical logic (pause, fee check, sign, persist, broadcast, resume)
- [ ] sendToAddress and sendMax are thin wrappers (3-5 lines each)
- [ ] All existing tests still pass
- [ ] estimateFee and estimateMaxSendable optionally share a similar pattern
