---
title: 'Send Flow State Machine — Recipient-First Classification with Two-Phase Validation'
problem_type: design_pattern
date: 2026-07-22
category: design-patterns
module: src/pages/Send.tsx
component: frontend_stimulus
severity: medium
applies_when:
  - 'Building a payment/send flow that must accept multiple input types (address, invoice, offer, Lightning Address) into one entry field'
  - 'An async classification/resolution step determines which downstream screens are even needed'
  - 'A scanner or paste source needs to feed the same state machine as manual entry'
related_components: [src/pages/Send.tsx, src/pages/Send.test.tsx, src/ldk/payment-input.ts]
tags:
  [send, state-machine, react, lightning, onchain, lnurl, bip353, validation, discriminated-union]
---

# Send Flow State Machine — Recipient-First Classification with Two-Phase Validation

> Note: this file is named `react-send-flow-amount-first-state-machine.md` because it originally documented a 2026-03-16 amount-first design. That design was reversed to recipient-first two days later (2026-03-18) and the flow has stayed recipient-first since; the filename is kept stable because several historical plan docs link to this exact path.

## Context

`src/pages/Send.tsx` (~1030 lines) implements Zinqq's single send flow for on-chain, Lightning (BOLT 11/BOLT 12), LNURL-pay, and BIP 353 (Lightning Address) payments. The flow must accept one free-text "recipient" input — an address, invoice, offer, or `user@domain` string — and route to the right sequence of screens without ever asking the user to pick a currency, chain, or token (a standing product constraint: this app pays fully-specified payment requests only).

The flow was originally built amount-first (numpad → recipient → review), matching an early design-system mock. That ordering broke down for several reasons that only became clear once Lightning Address (BIP 353/LNURL) and QR scanning were added:

1. **Payment type is unknown at amount entry.** You can't validate against on-chain balance vs. Lightning outbound capacity, or know whether a dust minimum applies, until the input is classified.
2. **BOLT 11/BOLT 12 invoices frequently carry a fixed amount.** If amount is entered first, that user-entered value conflicts with the invoice's embedded amount and one of them has to be silently discarded.
3. **LNURL-pay and BIP 353 require an async network round-trip** (DoH lookup, then LNURL fallback, then possibly a callback fetch for the actual invoice) before an amount step can even be shown — amount-first has nowhere to put that async gap.
4. **QR-scanned input arrives recipient-shaped.** A scanner always produces a raw string (address/invoice/URI), never an amount typed on a numpad, so an amount-first machine required a special-cased entry path for scans.

The flow was restructured to recipient-first in the 2026-03-18 plan (`docs/plans/2026-03-18-001-feat-recipient-first-send-flow-plan.md`), and it briefly regressed back to amount-first during an unrelated merge (`docs/solutions/integration-issues/merge-conflict-resolution-data-loss-regression.md`) before being restored. It has remained recipient-first since.

## Guidance

### Current step order and state machine

The live `SendStep` discriminated union in `src/pages/Send.tsx`:

```typescript
type SendStep =
  // Recipient entry (first screen)
  | { step: 'recipient' }
  // Amount entry (shown only when input has no embedded amount)
  | {
      step: 'amount'
      parsedInput: ParsedPaymentInput
      rawInput: string
      minSat?: bigint
      maxSat?: bigint
    }
  // On-chain flow
  | {
      step: 'oc-review'
      address: string
      amount: bigint
      fee: bigint
      feeRate: bigint
      isSendMax: boolean
      fromStep: 'recipient' | 'amount'
      label?: string
    }
  | { step: 'oc-success'; txid: string; amount: bigint }
  // Lightning flow
  | {
      step: 'ln-review'
      parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' }
      amountMsat: bigint
      fromStep: 'recipient' | 'amount'
      label?: string
    }
  | {
      step: 'ln-sending'
      parsed: ParsedPaymentInput & { type: 'bolt11' | 'bolt12' }
      amountMsat: bigint
      paymentId: Uint8Array
    }
  | { step: 'ln-success'; preimage: Uint8Array; amountMsat: bigint }
  // Shared
  | { step: 'error'; message: string; retryStep: ReviewStep | null }

type ReviewStep = Extract<SendStep, { step: 'oc-review' } | { step: 'ln-review' }>
```

Screen order is **recipient → amount (conditional) → review → success/error**. The amount step is skipped entirely when the classified input already carries a fixed amount (a BOLT 11/BOLT 12 invoice with `amountMsat !== null`, a BIP 321 URI with `?amount=`, or a fixed-range LNURL where `minSendableMsat === maxSendableMsat`).

### Why recipient-first won

Classifying the payment input _first_ is what makes every other decision possible:

- **On-chain vs. Lightning determines amount semantics** — dust minimum (`MIN_DUST_SATS = 294n`) and balance source (`onchainBalance` vs `lnCapacityMsat`) differ, and neither is knowable before classification.
- **BOLT 11/BOLT 12 with a fixed amount skip the amount step entirely** — `routeResolvedInput` and `processRecipientInput` both check `parsed.amountMsat !== null` and go straight to `ln-review`, never touching the numpad.
- **BIP-321 URIs and bare addresses need an amount**, so unresolved on-chain input with no embedded `amountSats` routes to `{ step: 'amount' }`.
- **LNURL and BIP 353 resolve asynchronously** — `resolveAddress` does a BIP 353 DoH lookup first, falls back to LNURL-pay, and only then decides whether an amount step, a direct invoice fetch, or an error is next. This multi-step async resolution has a natural home when recipient is the first screen and amount is deferred; it has no clean home in an amount-first machine, since the resolution can produce zero, one, or two more screens depending on what it finds.
- **Scanned QR input becomes a first-class citizen of the same entry point.** A scan is just recipient text arriving from a different source. `pendingQrInput` (populated from `location.state.scannedInput`) is gated on `onchain.status === 'ready'` and then always calls `processRecipientInput(raw, 'recipient')` — the exact same function and step-tag the manual "Next" button uses. There is no separate scan-handling code path.

### The `fromStep` tag threads state through async classification

`processRecipientInput(value, fromStep)` takes a second parameter, `fromStep: 'recipient' | 'amount'`, that records whether this call originated from the first screen (raw text, amount not yet known) or from the amount screen (recipient already classified once, user-entered `amountSats` now available). The same classification function is reused for both entry points instead of duplicating recipient-parsing logic on the amount screen:

- Called with `'recipient'`: an on-chain address or amountless invoice with no embedded amount routes to `{ step: 'amount', parsedInput, rawInput }`, stashing the parsed input for the second call.
- Called with `'amount'`: the previously-parsed input plus the now-known `amountSats` are combined (`effectiveMsat = amountSats * 1000n`, `effectiveAmount = parsed.amountSats ?? amountSats`) and routed to `oc-review` or `ln-review`.

LNURL and BOLT 11/BOLT 12 inputs coming back from the amount screen are **not re-parsed** through `classifyPaymentInput` — `handleAmountNext` reads `sendStep.parsedInput` directly and calls `fetchAndRouteInvoice` (LNURL) or builds `ln-review` inline. This is deliberate: re-parsing a BIP-353-resolved `rawInput` (which is still the `user@domain` string, not the resolved invoice) would reclassify it as `bip353` and restart the async resolution loop.

### Discriminated-union steps — impossible states unrepresentable

Each step variant only carries the fields that step needs (`oc-review` has `address`/`fee`/`feeRate`; `ln-review` has `parsed`/`amountMsat`). TypeScript's control-flow narrowing on `sendStep.step` means a handler like `handleOcConfirm` can destructure `sendStep.address` only after the `sendStep.step !== 'oc-review'` guard — there is no way to accidentally read an on-chain field from a Lightning step, and adding a new step variant forces every exhaustive `if`/`switch` to be revisited.

### Two-phase validation

- **Phase 1 (numpad):** `numpadDigitReducer` only enforces a digit-count ceiling (`MAX_DIGITS = 8`) and blocks a non-positive amount from enabling "Next" (`nextDisabled={amountSats <= 0n}`). No balance or dust checks happen here because the payment type isn't fully resolved to a spendable-balance check yet.
- **Phase 2 (inside `processRecipientInput`, after classification):** dust minimum for on-chain (`effectiveAmount < MIN_DUST_SATS`), balance/capacity checks (`effectiveAmount > onchainBalance`, `effectiveMsat > lnCapacityMsat`), and LNURL min/max constraints (checked in `handleAmountNext` against `sendStep.minSat`/`maxSat` before Phase 2 even runs, since those bounds come from the LNURL metadata already stored in the `amount` step).

### Refs for async double-invoke guards

Two `useRef` guards prevent duplicate work that `useState` can't prevent within a single synchronous burst of events:

- `processingRef` — set/cleared around the whole body of `processRecipientInput`, so a paste event and a rapid click on "Next" can't both enter classification concurrently.
- `sendingRef` — set/cleared around `handleOcConfirm` and `handleLnConfirm`, guarding the actual broadcast/payment-send call against double taps on "Confirm Send".

Both follow the same shape:

```typescript
if (sendingRef.current) return
sendingRef.current = true
try {
  /* ... */
} finally {
  sendingRef.current = false
}
```

Refs are necessary here because `useState` setters are batched and asynchronous — a second click handler firing before a state update commits could still read the stale "not sending" value. A ref mutation is synchronous and visible to the very next line of JS, which is what a same-tick double-invoke guard needs.

### Error step retry routes to the exact resolvable step, not always step 1

The `error` step carries `retryStep: ReviewStep | null`. This is a live, fully-populated step object — not a step _name_ — so "Try Again" can jump straight back to a `oc-review` or `ln-review` step with its `address`/`amount`/`fee`/`parsed`/`amountMsat` already filled in, skipping re-classification and re-estimation entirely:

```typescript
// handleOcConfirm
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  setSendStep({ step: 'error', message, retryStep: reviewStep })
}

// error screen
onClick={() => {
  if (sendStep.retryStep) {
    setSendStep(sendStep.retryStep)
  } else {
    void navigate('/')
  }
}}
```

`retryStep` is only populated for broadcast failures on the on-chain path (`handleOcConfirm`) — a retryable class of error where the review data (address, fee estimate) is still valid and worth reusing. Lightning payment failures, timeouts, and cancellations set `retryStep: null`, because a failed/abandoned Lightning payment attempt shouldn't be silently resubmitted with the same `paymentId`-adjacent state; those show "Done" and return home. This is the general rule: **map each error class to the earliest step whose captured data is still valid**, which is sometimes the review step itself (fee already estimated, no need to reclassify) and sometimes "back to the beginning" when no captured state can be safely reused.

### Fee captured at review is reused at send, not recomputed

`oc-review` stores `fee`/`feeRate` computed once by `estimateFee`/`estimateMaxSendable` in `processRecipientInput`. `handleOcConfirm` passes that same `feeRate` straight to `onchain.sendToAddress`/`onchain.sendMax` — it does not call `estimateFee` again. This keeps the number the user reviewed and confirmed identical to the number that gets broadcast, and avoids a second network round-trip (and a second chance for the fee to have moved) between review and send.

## Why This Matters

A send flow is fund-safety-critical: any state that can be reached with a review screen showing one address/amount and a confirm button that broadcasts a different one is a direct loss-of-funds bug. Modeling the flow as a discriminated union makes those states unrepresentable at compile time rather than something to test for at runtime. The recipient-first ordering exists specifically because payment-type classification is a hard _prerequisite_ for correct amount validation, balance checks, and screen sequencing — reversing that order (as amount-first did) forces the amount step to be payment-type-agnostic, which then requires either duplicating validation logic per type after the fact or approximating limits (e.g., showing a unified on-chain+Lightning balance on the numpad before knowing which bucket applies) and hoping the numbers reconcile downstream. Recipient-first also lets one function (`processRecipientInput`) and one step tag (`fromStep`) serve manual entry, paste, and QR scan without a parallel code path per input source — fewer paths through fund-moving code is directly a safety property, not just a stylistic preference.

## When to Apply

- Any entry flow that accepts multiple heterogeneous input formats into one field and only later branches by type (payment requests, deep links, multi-protocol identifiers).
- Any flow with an async resolution/lookup step that can produce a variable number of downstream screens (zero, one, or more) depending on what the lookup returns.
- Any flow where a secondary input source (scanner, paste, deep link, clipboard) needs to enter the same state machine as manual typing — route it through the same processing function with the same step tag rather than adding a parallel path.
- Any confirm/broadcast action where re-deriving fee, amount, or destination at send time (instead of reusing what was shown at review) could let the user confirm one thing and send another.

## Examples

Recipient input with no embedded amount (bare on-chain address or amountless invoice) — routed to the amount step, tagged with the raw input for a later second pass:

```typescript
// src/pages/Send.tsx — processRecipientInput, fromStep === 'recipient'
if (!hasEmbeddedAmount && fromStep === 'recipient') {
  setSendStep({ step: 'amount', parsedInput: parsed, rawInput: trimmed })
  return
}
```

Fixed-amount BOLT 11/BOLT 12 — amount step is skipped, straight to review:

```typescript
// src/pages/Send.tsx — routeResolvedInput
if (parsed.amountMsat !== null) {
  setSendStep({
    step: 'ln-review',
    parsed,
    amountMsat: parsed.amountMsat,
    fromStep: 'recipient',
    label,
  })
  return
}
```

QR scan feeding the same entry point as manual "Next", gated on wallet readiness:

```typescript
// src/pages/Send.tsx
useEffect(() => {
  if (!pendingQrInput) return
  if (onchain.status !== 'ready') return
  const raw = pendingQrInput
  setPendingQrInput(null)
  setInputValue(raw)
  void processRecipientInput(raw, 'recipient')
}, [pendingQrInput, onchain.status, processRecipientInput])
```

Retryable broadcast error returning directly to the populated review step (verified in `src/pages/Send.test.tsx`, "error done and retry" describe block — "returns to review screen on retry"):

```typescript
// error screen retry handler
if (sendStep.retryStep) {
  setSendStep(sendStep.retryStep)
} else {
  void navigate('/')
}
```

## Related

- `docs/plans/2026-03-18-001-feat-recipient-first-send-flow-plan.md` — the plan that reversed amount-first to recipient-first
- `docs/solutions/integration-issues/merge-conflict-resolution-data-loss-regression.md` — the merge that silently reverted this flow back to amount-first, and how it was restored
- `docs/solutions/integration-issues/qr-scanner-camera-send-flow-integration.md` — how scanned QR input is passed via `location.state` and fed into `processRecipientInput`
- `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` — the on-chain build/sign/broadcast pipeline that `oc-review`/`handleOcConfirm` sit on top of
