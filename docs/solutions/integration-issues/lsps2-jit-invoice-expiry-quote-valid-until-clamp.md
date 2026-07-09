---
title: 'LSPS2 JIT Invoice Expiry Must Be Clamped to the Quote valid_until'
category: integration-issues
date: 2026-07-08
tags: [lsps2, ldk, jit-channel, bolt11, invoice-expiry, valid-until, megalith, phoenix, lightning]
severity: high
components: [ldk/context.tsx, ldk/lsps2/types.ts, pages/Receive.tsx]
---

# LSPS2 JIT Invoice Expiry Must Be Clamped to the Quote `valid_until`

## Problem

First mainnet JIT receive through Megalith: the invoice rendered fine, but paying it from Phoenix failed with **"payment attempts exhausted without success"** — and the Zinqq console was completely silent during the attempts (no `OpenChannelRequest`, no HTLC events). Generating a fresh invoice and paying it promptly succeeded end-to-end (0-conf channel open → `PaymentClaimable` → `PaymentClaimed`).

## Root Cause

Megalith's LSPS2 quotes carry only **~10–15 minutes** of validity (`opening_fee_params.valid_until`), but the JIT invoice was minted with a fixed **3600s** BOLT11 expiry. An invoice paid after `valid_until` looks perfectly payable to the sender's wallet, yet the LSP fails every HTLC at the intercept SCID — the payer's wallet burns all its retries against a guaranteed-dead invoice, and nothing reaches our node to log.

Diagnosis fingerprint for the future: **"attempts exhausted" on the payer + silent receiver console = stale quote**, not a code bug in the intercept/claim path. Compare the `valid_until` in the `[LSPS2] Sending: lsps2.buy` log line against the wall-clock time of the payment attempt.

## Solution

Clamp the invoice expiry to the quote's remaining validity, computed **before** issuing `lsps2.buy` so a stale quote throws without orphaning an LSP-side reservation (PR #168, `src/ldk/context.tsx`):

```typescript
const JIT_INVOICE_MAX_EXPIRY_SECS = 3600
const JIT_INVOICE_FLIGHT_MARGIN_SECS = 30 // HTLC must ARRIVE before valid_until
const JIT_INVOICE_MIN_EXPIRY_SECS = 60 // below this, re-quote instead

export function computeJitInvoiceExpirySecs(validUntil: string, nowMs: number): number {
  const validUntilMs = Date.parse(validUntil)
  // Fail closed: NaN makes every comparison false, so a plain `<` gate would
  // wave an unparseable valid_until through into the buy, the u32 WASM
  // boundary, and the BOLT11 encoder.
  if (!Number.isFinite(validUntilMs)) {
    throw new JitQuoteFreshnessError('Fee quote has an invalid expiry, please try again')
  }
  const headroomSecs = Math.floor((validUntilMs - nowMs) / 1000) - JIT_INVOICE_FLIGHT_MARGIN_SECS
  if (headroomSecs < JIT_INVOICE_MIN_EXPIRY_SECS) {
    throw new JitQuoteFreshnessError('Fee quote expired, please try again')
  }
  return Math.min(JIT_INVOICE_MAX_EXPIRY_SECS, headroomSecs)
}
```

The clamped `expirySecs` feeds **both** `create_inbound_payment` (LDK-side expiry) and the BOLT11 encoding, and `JitInvoiceResult` carries `expiresAtMs` so the Receive screen can flip the QR to a "Payment request expired / Generate new request" state (`jit-expired` step) at the same moment the invoice stops being payable.

Three review findings hardened the first cut (todos 387–389):

1. **NaN fails closed** (above) — plus `deserializeOpeningFeeParams` rejects an unparseable `valid_until` at the trust boundary, and the Phase A freshness gate uses an inverted `!(x >= y)` comparison.
2. **The expired flip yields to amount editing** — `jit-expired` is the only state that can coexist with the numpad; the numpad wins while open, Cancel lands on the expired screen.
3. **`JitQuoteFreshnessError` from the buy is discriminated in the catch** — staleness is client-local, so re-quote WITHOUT `skipPrimary`; don't let the generic buy-failure path demote to a pricier fallback LSP.

## Prevention

- **Any absolute deadline received from an LSP bounds everything derived from it.** Never pair an LSP-quoted `valid_until` with a fixed client-side lifetime (invoice expiry, retry window, UI countdown) — always derive.
- **Gate comparisons on untrusted timestamps must fail closed**: `Date.parse` returns NaN on garbage and NaN fails every `<`/`>` comparison, silently passing gates. Use `Number.isFinite` checks or inverted `!(x >= y)` comparisons, and validate at deserialization.
- Follow-up hardening is filed as todos 390–396 (single deadline owner across the three clock anchors, Phase A/B gate alignment, `visibilitychange` resync, etc.).

## Related

- [lsps2-jit-receive-channel-config.md](lsps2-jit-receive-channel-config.md) — the config needed for the claim side of the same flow
- [bip321-unified-uri-bolt11-invoice-generation.md](bip321-unified-uri-bolt11-invoice-generation.md) — warned "expired invoices that still appear valid cause failed payments"; this doc is that warning materializing via the LSP quote path
- PR #168 (`dbb41e4`), review todos 387–396
