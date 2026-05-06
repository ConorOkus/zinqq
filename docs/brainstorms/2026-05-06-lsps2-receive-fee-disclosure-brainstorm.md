---
date: 2026-05-06
topic: LSPS2 receive — pre-invoice fee disclosure UX
status: brainstorm
---

# LSPS2 Receive — Pre-Invoice Fee Disclosure

## What We're Building

A **Review screen** inserted between the receive numpad and the BOLT11 invoice/QR, shown only when a just-in-time channel open is required. The screen discloses the LSPS2 setup fee and the net amount the user will actually receive _before_ the invoice is generated, so the displayed receive amount on the QR matches what lands in the wallet.

Today: numpad → Done → invoice fires immediately; the LSP fee is shown only as a single line under the QR (`Setup fee: X`), and the user has no chance to back out or adjust before the invoice exists. There is no warning when the requested amount is below the LSP minimum or below the fee itself.

After: numpad → **Review** → Generate invoice → QR. The Review screen shows requested amount, setup fee, and the net "You'll receive" figure, in that order, with a disabled-Confirm + minimum-suggestion when the fee exceeds the request.

## Why This Approach

- **Transparency before commitment.** The user explicitly named transparency before invoice as the core goal. A review step is the smallest UI change that satisfies it without retrofitting live recalculation onto the numpad.
- **Avoids surprise underpayment.** Today the QR says "10,000 sats" but the wallet only credits ~7,500 because LDK is told `expectedReceiveMsat = amount − openingFee` via `accept_underpaying_htlcs` (`src/ldk/context.tsx:253`). Disclosing the net up-front prevents the "I asked for 10k, where's my 2.5k?" support load.
- **Skipped when not needed.** Subsequent receives that don't require a JIT open have no fee to disclose; routing those straight to QR keeps the happy path one tap shorter.
- **Reuses existing primitives.** `getOpeningFeeParams`, `selectCheapestParams`, and `calculateOpeningFee` (`src/ldk/lsps2/`) are already pure and side-effect-free. They're called inside `attemptJitInvoiceWithLsp` today; the review screen only needs them surfaced one layer up so the numbers can be previewed without a `buyChannel` commitment.

## Key Decisions

- **Insert a Review screen, conditional on JIT.** Numpad → Review → Generate → QR when `requiresJitChannel === true`. Otherwise numpad → QR (current behavior).
- **Display only the LSP opening fee as "Setup fee".** Channel reserve is **not** added to the figure and **not** shown as a separate line. The reserve is the user's own sats locked in their own channel — locked, not lost — and conflating it with the LSP fee would overstate the cost.
- **Layout: three rows + a divider, B-integer denomination.**

  ```
    Review receive

    Amount           ₿10,000
    Setup fee      − ₿2,600
    ─────────────────────────
    You'll receive   ₿7,400

        [ Generate invoice ]
        [    Back         ]
  ```

- **Below-minimum: block + suggest.** When `setupFee ≥ amount`, disable `Generate invoice` and show `Minimum receive: ₿X` (where X is `max(LSP minPaymentSizeMsat, smallest amount that yields net > 0)`). No "warn but allow" — paying ₿2,600 in fees to receive ₿0 is never the right action.
- **No "first receive opens a Lightning channel" copy.** The user wants this educational framing removed; the breakdown speaks for itself. The label "Setup fee" is doing all the explaining.
- **Setup fee uses the LSP's quoted opening fee for the requested amount**, computed via `getOpeningFeeParams` + `selectCheapestParams` + `calculateOpeningFee` against `amountMsat`, before any `buyChannel` call. No commitment to the LSP is made until the user taps `Generate invoice`.

## Out of Scope (deliberate YAGNI)

- **Auto-gross-up** ("receive ₿10,000 spendable" mode that bumps the invoice to ₿12,600). Not requested; adds a mode toggle and confuses the QR amount. Revisit only if users ask for it.
- **Channel reserve display** anywhere in the receive flow. The reserve is not a cost. It may belong in a future "spendable vs. capacity" balance breakdown, but that's a separate balance-UX concern.
- **Education copy about Lightning channels** ("first receive opens a channel," "future receives are free," etc.). Explicitly cut.
- **Live fee preview on the numpad screen.** Considered and rejected in favor of a dedicated review step — keeps the numpad clean and the numbers stable (no jitter as the user types).
- **Review screen for non-JIT receives.** Skip when there's nothing to disclose.

## Resolved Questions

- _Should reserve be bundled into the Setup fee number?_ — **No.** Initially the user inclined toward bundling; on reflection, reserve is locked-not-lost, so showing only the true LSP cost is more accurate. Reserve disclosure, if it happens at all, lives in a separate balance-UX surface.
- _Block, warn, or auto-bump when amount < fee?_ — **Block + suggest minimum.** Auto-bumping silently changes what the user typed; warn-and-allow lets them light money on fire.
- _Always show the review, or only on JIT?_ — **Only on JIT.** No fee, no review.
- _B-integer denomination scope?_ — **App-wide.** Add a B-integer formatter (`₿10,000`) and use it everywhere BTC is currently displayed. The review screen drives consistency, but the change is global. This expands plan scope: every balance/amount surface gets touched.
- _Stale quote on Generate invoice tap?_ — **Silent re-quote.** Re-fetch the fee on tap; if it matches, proceed; if it changed, briefly show "Fee updated" and the new numbers before letting the user proceed. Optimizes for short review-screen dwell time.
- _Failure mode if `get_info` fails before the review renders?_ — **Skip review, fall back to on-chain.** Match current behavior in `src/ldk/context.tsx:144`. The review screen only renders when we have a valid quote; fee-fetch failure is treated as "JIT unavailable" and the existing on-chain fallback kicks in.
- _Fee row label?_ — **"Setup fee"** (unchanged from today's under-QR copy).
- _Minimum-receive computation?_ — **`max(LSP.minPaymentSizeMsat, smallest amount yielding net > 0 after fee)`.** In practice the LSP minimum should already cover the second term, but compute both and take the max so the displayed minimum is always actionable.

## Open Questions

(none — ready to plan)

## Files Touched (anticipated, not a plan)

- `src/pages/Receive.tsx` — insert review step in the state machine; current single-screen `step` enum (`'idle' | 'negotiating-jit' | ...`) gains `'review-jit'`.
- `src/ldk/context.tsx` — split `attemptJitInvoiceWithLsp` so fee-quote (`getOpeningFeeParams` + `calculateOpeningFee`) and channel-buy (`buyChannel` + invoice) are independently callable.
- `src/ldk/lsps2/client.ts` — likely no changes; the primitive is already there.
- New: a small helper for B-integer formatting (or a decision to use the existing one).
