---
status: complete
priority: p1
issue_id: '252'
tags: [code-review, payjoin, data-integrity, race]
dependencies: []
---

# `apply_unconfirmed_txs` failure after successful broadcast leaves wallet/UI inconsistent

## Problem Statement

`context.tsx:244-253` orders post-Payjoin broadcast as:

1. `await esplora.broadcast(tx)` — succeeds, tx is in flight on the network
2. `wallet.apply_unconfirmed_txs([new UnconfirmedTx(tx, ...)])` — may throw (BDK rejects the tx, OutPoint not in wallet's view, etc.)
3. `persistChangeset(wallet)`

If step 2 throws, the outer `catch (err)` at line 278 maps the error and re-throws. **The broadcast already happened on the network.** The user sees "Send Failed" with "Your funds are safe" reassurance copy at `Send.tsx:845`, but the funds are actually being sent via Payjoin.

## Findings

- **security-sentinel P2-3** (escalated to P1 — user-facing fund-related UX inconsistency): on next sync the wallet will rediscover the tx, but the "Try Again" button at `Send.tsx:856-857` builds a _new_ PSBT from the same UTXOs. Until the next BDK sync (default `syncIntervalMs: 180_000`), the wallet has no record of the spend.
- The retry build would normally fail at broadcast (mempool rejects double-spend), but the failure UX is poor. On a wallet with multiple available UTXOs, the second build could pick _different_ inputs and succeed — leading to two independent broadcasts.
- This is a Payjoin-specific concern: the non-Payjoin path's `wallet.sign(psbt)` already stages BDK's view correctly; only the Payjoin path needs explicit `apply_unconfirmed_txs`.

## Proposed Solutions

### Option 1 (recommended) — Best-effort `apply_unconfirmed_txs` with isolated catch

```ts
await esplora.broadcast(tx)

if (wasTransformed) {
  try {
    wallet.apply_unconfirmed_txs([new UnconfirmedTx(tx, BigInt(Math.floor(Date.now() / 1000)))])
  } catch (err) {
    captureError(
      'error',
      'Onchain',
      'Payjoin apply_unconfirmed_txs failed post-broadcast',
      err instanceof Error ? err.message : String(err)
    )
    // Tx is broadcast; next sync will reconcile. Continue to persist + return txid.
  }
}

persistChangeset(wallet)
return txid
```

After broadcast succeeds, treat the send as successful regardless of bookkeeping outcome.

- Pros: post-broadcast errors no longer surface as "Send Failed"; the wallet self-heals on next sync; no user-facing double-send.
- Cons: a brief window where the wallet's `balance` is stale (until sync). Users may briefly see incorrect balance — but this is strictly better than a misleading error and a re-spend invitation.

### Option 2 — Pre-flight the apply before broadcast

Apply first, broadcast second. If apply fails, abort before network send.

- Pros: keeps wallet consistent.
- Cons: PDK's proposal PSBT may reference inputs/outputs in shapes BDK can't apply locally without first seeing the broadcast. This is more invasive and could break legitimate flows.

## Recommended Action

Option 1. Wrap the `apply_unconfirmed_txs` call in its own try/catch. The broadcast is the source of truth.

## Technical Details

- Affected file: `src/onchain/context.tsx` lines 244-253
- Test: add a unit test that mocks `wallet.apply_unconfirmed_txs` to throw, asserts the txid is still returned, asserts `captureError` fires once.

## Acceptance Criteria

- [ ] `apply_unconfirmed_txs` failure does not surface as a send error
- [ ] Test for the error-after-broadcast path
- [ ] `captureError` invocation includes enough detail for diagnosis without leaking PSBT bytes
- [ ] Existing tests still pass

## Work Log

**2026-04-26** — Resolved on PR #143 branch via Option 1.

- Wrapped the post-broadcast `wallet.apply_unconfirmed_txs([...])` call in its own try/catch in `context.tsx`.
- On failure: log via `captureError('error', 'Onchain', 'Payjoin apply_unconfirmed_txs failed post-broadcast', ...)` but continue. The broadcast is the source of truth; the wallet self-heals on next sync. The send returns the txid as success.
- Comment block explains the rationale: surfacing this as "Send Failed" would mislead the user into retrying and risk a real double-spend on a wallet with multiple available UTXOs (BDK might pick different inputs before its next sync sees the in-flight tx).

## Resources

- PR #143
- security-sentinel agent report for PR #143
- BDK API: `apply_unconfirmed_txs` at `bitcoindevkit.d.ts:1152`
