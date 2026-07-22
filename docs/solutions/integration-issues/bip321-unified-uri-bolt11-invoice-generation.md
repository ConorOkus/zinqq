---
title: BIP 321 Unified URI with BOLT 11 Invoice Generation via LDK ChannelManager
category: integration-issues
date: 2026-03-16
module: src/pages/Receive.tsx, src/ldk/context.tsx
tags: [receive, bip321, bolt11, invoice, qr, lightning, onchain, ldk]
severity: LOW
related:
  - bdk-wasm-onchain-send-patterns.md
  - ldk-wasm-foundation-layer-patterns.md
---

# BIP 321 Unified URI with BOLT 11 Invoice Generation

## Problem

The Receive screen only showed an on-chain address and QR code. Users with Lightning channels had no way to receive Lightning payments through the QR code. The goal was to build a BIP 321 unified URI (`bitcoin:<address>?lightning=<bolt11>`) so a single QR code supports both on-chain and Lightning payments.

## Root Cause

LDK's `UtilMethods.constructor_create_invoice_from_channelmanager` was not exposed through the React context layer. The Receive page only consumed `OnchainContext` and had no access to Lightning invoice generation.

**Update (LDK 0.2):** `UtilMethods.constructor_create_invoice_from_channelmanager` was removed entirely in the LDK 0.2 upgrade. The code samples below are historical — see the update note after each for the current equivalent.

## Solution

### 1. Add `createInvoice` to LDK Context

```typescript
// src/ldk/context.tsx:159-178 — historical, LDK <0.2
const createInvoice = useCallback((description = 'Zinqq Wallet'): string => {
  const node = nodeRef.current
  if (!node) throw new Error('Node not initialized')

  const result = UtilMethods.constructor_create_invoice_from_channelmanager(
    node.channelManager,
    Option_u64Z_None.constructor_none(), // zero-amount
    description,
    3600, // 1 hour expiry
    Option_u16Z_None.constructor_none() // default CLTV
  )

  if (!(result instanceof Result_Bolt11InvoiceSignOrCreationErrorZ_OK)) {
    console.error('[ldk] create_invoice failed:', result)
    throw new Error('Failed to create invoice')
  }

  return result.res.to_str()
}, [])
```

**Key LDK types needed (historical):**

- `Option_u64Z_None` — signals no amount restriction (zero-amount invoice)
- `Option_u16Z_None` — use default min_final_cltv_expiry_delta
- `Result_Bolt11InvoiceSignOrCreationErrorZ_OK` — result pattern matching via `instanceof`

**Update — current implementation (`src/ldk/context.tsx` ~840-880):** `UtilMethods.constructor_create_invoice_from_channelmanager` no longer exists. Invoice creation is now a `ChannelManager` method, `create_bolt11_invoice`, and it takes a `Bolt11InvoiceDescription` wrapper (built from a `Description`) instead of a raw string. The code comment at ~853-854 states the removal explicitly. The function also now accepts an optional amount and returns both the invoice string and its payment hash:

```typescript
// src/ldk/context.tsx ~840-880 — current, LDK 0.2+
const createInvoice = useCallback(
  (amountMsat?: bigint, description = 'Zinqq Wallet'): { bolt11: string; paymentHash: string } => {
    const node = nodeRef.current
    if (!node) throw new Error('Node not initialized')

    const amountOption =
      amountMsat != null
        ? Option_u64Z.constructor_some(amountMsat)
        : Option_u64Z_None.constructor_none()

    const descResult = Description.constructor_new(description)
    if (!(descResult instanceof Result_DescriptionCreationErrorZ_OK)) {
      throw new Error('Invalid invoice description')
    }
    const result = node.channelManager.create_bolt11_invoice(
      amountOption,
      Bolt11InvoiceDescription.constructor_direct(descResult.res),
      Option_u32Z.constructor_some(3600), // 1 hour expiry
      Option_u16Z_None.constructor_none(),
      Option_ThirtyTwoBytesZ.constructor_none()
    )

    if (!(result instanceof Result_Bolt11InvoiceSignOrCreationErrorZ_OK)) {
      console.error('[ldk] create_invoice failed:', result)
      throw new Error('Failed to create invoice')
    }

    const invoice = result.res
    return { bolt11: invoice.to_str(), paymentHash: bytesToHex(invoice.payment_hash()) }
  },
  []
)
```

### 2. Build BIP 321 URI with Optional Lightning

```typescript
// src/pages/Receive.tsx:69-74 — historical, hand-rolled URI
const bip321Uri = address
  ? invoice
    ? `bitcoin:${address.toUpperCase()}?lightning=${invoice}`
    : `bitcoin:${address.toUpperCase()}`
  : ''
```

**Update — current implementation:** URI construction is no longer hand-rolled. Receive.tsx calls the shared `buildBip321Uri({ address, amountSats, invoice })` helper from `src/onchain/bip321.ts` (also used for the amount-embedding and BOLT 12 `lno=` cases), rather than string-templating the URI inline.

The Lightning invoice is optional — if creation fails (no channels, WASM error), the URI degrades to on-chain only.

### 3. QR Uppercase Optimization

```typescript
// src/pages/Receive.tsx:116
const qrValue = bip321Uri.toUpperCase()
```

QR codes encode uppercase alphanumeric characters more efficiently (alphanumeric mode vs byte mode), producing smaller/faster-to-scan codes. Both BIP 321 URIs and BOLT 11 invoices (bech32) are case-insensitive, so uppercasing is safe.

**Important:** The clipboard copy preserves original case (`bip321Uri`), while the QR display uses uppercase (`bip321Uri.toUpperCase()`). Derive QR from the copy string to prevent the two constructions from drifting apart.

### 4. Graceful Degradation Pattern

Two independent `useEffect` blocks generate the address and invoice separately:

```typescript
// src/pages/Receive.tsx:31-39
useEffect(() => {
  if (createInvoice && invoice === null) {
    try {
      setInvoice(createInvoice())
    } catch (err) {
      // Lightning invoice is optional — onchain fallback still works
      console.warn('[Receive] Failed to create invoice:', err)
    }
  }
}, [createInvoice, invoice])
```

No `invoiceError` state is stored — failure is silent because the on-chain address alone is a complete fallback.

**Update:** Invoice failure is still non-fatal (on-chain fallback is unchanged), but it's no longer silent — Receive.tsx now stores the failure in an `invoiceError` state and surfaces it in the UI (`src/pages/Receive.tsx` ~891) so the user sees a message instead of a QR code that quietly lost its Lightning component.

## Key Gotchas

1. **Zero-amount invoices may be unpayable** — if the node has no channels or no inbound capacity, the invoice exists but no sender can route to it. Consider checking channel state before including the `lightning=` parameter.

2. **BOLT 11 invoices disclose node identity** — the invoice embeds the node pubkey and route hints (channel peers). This is inherent to BOLT 11 and not a bug, but is a privacy trade-off worth documenting.

3. **LDK Result types require `instanceof` checks** — not `.is_ok()` or similar. Always check `result instanceof Result_..._OK` before accessing `result.res`.

4. **`constructor_create_invoice_from_channelmanager` uses the node's keys internally** — don't try to pass raw keys or `KeysManager`. The ChannelManager already wraps them.

## Prevention

1. **Wrap LDK invoice creation in a single factory function** that returns the invoice string, with the ChannelManager as its only dependency
2. **Treat Lightning as strictly optional** at every layer: URI construction, QR display, and clipboard copy
3. **Normalize QR values to uppercase** in a single utility to avoid forgotten call sites
4. **Set reasonable expiry** (1 hour for interactive receives) — expired invoices that still appear valid cause failed payments
5. **Consider omitting `lightning=`** when no channels have inbound capacity, rather than including an unpayable invoice

**Note:** This doc predates the LSPS2 JIT receive flow. The "no inbound capacity" gotcha above (#1 in Key Gotchas) is exactly what JIT receive solves — see `lsps2-jit-receive-channel-config.md`, `lsps2-jit-receive-react-effect-dependencies.md`, and `lsps2-jit-invoice-expiry-quote-valid-until-clamp.md` for the invoice path that actually ships today, where Receive.tsx requests a JIT quote and channel-config alongside (or instead of) the standard invoice above.
