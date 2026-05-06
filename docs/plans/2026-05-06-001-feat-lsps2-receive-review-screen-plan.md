---
title: feat: LSPS2 receive review screen with fee disclosure
type: feat
status: active
date: 2026-05-06
origin: docs/brainstorms/2026-05-06-lsps2-receive-fee-disclosure-brainstorm.md
---

# LSPS2 Receive Review Screen with Fee Disclosure

## Enhancement Summary

**Deepened on:** 2026-05-06 (post-ultrathink review pass)
**Reviewers run in parallel:** architecture-strategist, code-simplicity-reviewer, julik-frontend-races-reviewer, performance-oracle, security-sentinel, pattern-recognition-specialist.

### Material changes from the original plan

| Change | Why | Driver |
|---|---|---|
| **State names switched to Send-style prefix discriminators** (`jit-quoting`, `jit-review`, `jit-buying`, `jit-error`) | Original `'review-jit'` inverted Send.tsx's `'oc-review'` / `'ln-review'` convention | pattern-recognition |
| **Cancellation primitive: `AbortController` instead of `requestCounterRef`** | Three async sites (initial quote, re-quote, buy) is too many for a shared monotonic counter; AbortSignal composes and is testable | architecture-strategist, julik |
| **Eager pre-warm of Phase A on numpad input (300ms debounce)** | Biggest UX win identified — converts perceived Phase A latency to ~0ms in the common case | performance-oracle |
| **Tightened freshness buffer 120s → 60s, per-LSP timeout 15s → 7s, total 30s → 14s** | 120s buffer triggered re-quote on routine reading dwell; 15s wait crosses "app froze" threshold | performance-oracle, julik |
| **Added `'jit-error'` step variant mirroring Send's error pattern** (`{ step; message; retryStep }`) | Plan was distributing error UI inline; Send uses a shared error shell | pattern-recognition |
| **Phase B fee-bound enforcement** in the LDK event handler: assert HTLC delta ≤ `openingFeeMsat`, reject otherwise | `accept_underpaying_htlcs=true` is unbounded otherwise — disclosure could be lied to at claim time | security-sentinel |
| **`executeJitBuy` asserts the params hash matches the displayed quote** | Prevents post-display fee inflation from making the disclosure stale on commit | security-sentinel |
| **Pinned `Date.now()` per render via `useMemo` for `valid_until` checks** | Render-time and tap-time were uncoordinated — a 50ms gap could disagree | julik |
| **Disabled `Generate invoice` CTA during `reQuoting` AND `jit-buying`** | Double-tap on slow re-quote could let an older response paint over a newer one | julik |
| **Banner persists until next user action; no 8000ms timer** | Self-imposed timer was racy and contradicted a11y criteria | julik, simplicity |
| **`visibilitychange` / `pageshow` listener** to clear stale banners and revalidate quotes after PWA backgrounding | iOS Safari freezes timers; resume can show stale state | julik |
| **`<link rel="preconnect">` to LSP proxy on Receive route** | One-line latency win | performance |

### Cuts (YAGNI-driven)

- **Cross-device "channel becomes usable mid-review" handling** — moved to Future Considerations. The real fix is a reactive `useChannelState` subscriber that all flows consume; ad-hoc polling on Generate-tap is duct tape.
- **Telemetry events (six `console.info` calls)** — moved to Future. No consumer pipeline; dead code today.
- **IndexedDB persistence of `buyResponse`** — in-memory ref only. Plan already admits durable crash recovery is out of scope; persistence added a failure mode for zero shipped benefit.
- **`Receive on-chain instead` secondary CTA on Phase B failure** — Zinqq is Lightning-first per durable memory; on-chain escape hatch from a Lightning-failure UI is wrong default.
- **B-integer audit as a phase deliverable** — collapsed into a one-line task in Phase 1 (it's a `grep formatBtc` pass; expected zero changes).
- **`lastQuoteChangedAt` field + 8000ms timer** — banner persists until next user action; one fewer state field.
- **Defensive guards for impossible LSPS2 states** (`proportional ≥ 1_000_000`) — removed.

### Phase reorganization

Original 6 phases → 5 phases over **2 PRs**:

- **PR 1 — ship the disclosure**: Phase 1 (split + AbortController) → Phase 2 (Review UI) → Phase 3 (minimum block).
- **PR 2 — polish**: Phase 4 (stale re-quote + lifecycle) → Phase 5 (Phase B retry + fee-bound enforcement).

---

## Overview

Insert a Review screen between the Lightning receive numpad and BOLT11 invoice generation, but **only when an LSPS2 just-in-time (JIT) channel open is required**. The Review screen discloses the LSPS2 setup fee and the net amount the user will actually receive *before* the wallet commits the LSP-side channel reservation. When the requested amount is too small to net more than zero after the fee, the screen blocks Confirm and surfaces an actionable minimum.

This plan also resolves an open question from the brainstorm: the wallet's `formatBtc` utility **already** outputs the agreed `₿10,000` integer-bitcoin form. Feature B ("app-wide B-integer denomination") collapses from a formatter rewrite to a one-line `grep` audit, folded into Phase 1.

## Problem Statement

Today the receive flow is single-screen with no preview step (see brainstorm: `docs/brainstorms/2026-05-06-lsps2-receive-fee-disclosure-brainstorm.md`):

1. `Receive.tsx` opens the numpad automatically when no usable channels exist (`needsAmount`, `Receive.tsx:64–77`).
2. User types an amount and taps Done.
3. The single big `useEffect` at `Receive.tsx:95–177` immediately fires `requestJitInvoice`.
4. The fee is shown **only after** invoice generation, as a single line under the QR (`Setup fee: <amount>`, `Receive.tsx:494`).
5. The displayed BOLT11 amount equals the user's input, but LDK has been told to expect `amount − openingFee` via `accept_underpaying_htlcs` (`context.tsx:253`). The wallet credits less than the QR says, with no prior disclosure.
6. There is no warning when the amount is below the LSP's `minPaymentSizeMsat` or below the fee itself; failure surfaces only as a thrown error → on-chain fallback.

This produces the "I asked for ₿10,000, where's my ₿2,500?" support load, prevents the user from backing out before LSP-side commitment, and silently drops users into on-chain mode when they tried to receive too small an amount.

## Proposed Solution

Add a `'review-jit'` step to the Receive state machine, mirroring the existing Send-flow `'oc-review'` / `'ln-review'` discriminants (`Send.tsx:25–72`). Render the Review when phase A of LSPS2 negotiation succeeds; route directly to QR when no JIT is needed.

```
  Numpad → Done
            │
            ├─ no JIT needed ──────────────────────────────► Standard QR
            │
            └─ JIT needed
                 │
                 ├─ Phase A (quote, failover-aware) ─ failure ─► on-chain fallback
                 │
                 ▼
              Review screen (Amount / Setup fee / You'll receive)
                 │
                 ├─ Back ──► Numpad (amount preserved, in-flight cancelled)
                 │
                 ▼ Generate invoice
                 │
                 ├─ stale quote? ──► silent re-quote
                 │                     │
                 │                     ├─ unchanged ──► proceed
                 │                     └─ changed ────► update Review + "Fee updated" banner + require second tap
                 │
                 ▼ Phase B (buyChannel + create_inbound_payment + createJitInvoice)
                 │
                 ├─ buyChannel fails ──► error state, retry button, on-chain escape hatch
                 │
                 ├─ post-buyChannel local LDK fails ──► retry the local steps (idempotent), no re-buy
                 │
                 └─ success ──► QR
```

## Technical Approach

### Architecture

**State machine extension** — `Receive.tsx`

Today's `ReceiveState` (`Receive.tsx:19–24`) has three variants. Extend to (state names use Send-style prefix discriminator for consistency with `Send.tsx:25–72`):

```ts
type ReceiveState =
  | { step: 'ready'; invoicePath: InvoicePath }
  | { step: 'jit-quoting' }                                            // NEW (Phase A in flight)
  | { step: 'jit-review';                                              // NEW
      amountSats: bigint;
      params: OpeningFeeParams;
      lspContact: LspContact;
      openingFeeMsat: bigint;
      quoteStatus: 'fresh' | 'reQuoting' | 'updated';                  // tagged sub-state (no separate timer field)
    }
  | { step: 'jit-buying' }                                             // NEW (Phase B in flight)
  | { step: 'jit-error'; message: string; retryStep: 'jit-quoting' }   // NEW (mirrors Send.tsx:70 error variant)
  | { step: 'success'; amountSats: bigint };
```

The `quoteStatus` sub-state replaces the original plan's correlated `reQuoting: boolean` + `lastQuoteChangedAt: number | null` fields — one source of truth for what the banner should render.

**LDK context split** — `src/ldk/context.tsx`

Split `attemptJitInvoiceWithLsp` (`context.tsx:196–280`) into two LSP-scoped phases. Failover policy lives in the orchestrator, not in the phase signatures (per architecture-strategist):

```ts
// Phase A — quote against ONE LSP. Pure RPC: connect → get_info → selectCheapestParams + validUntil.
// Returns params + calculated opening fee. The orchestrator chooses which LSP to call.
async function getJitQuote(
  lsp: LspContact,
  amountMsat: bigint,
  signal: AbortSignal,
): Promise<JitQuote>;

// Phase B — buy + invoice against the LSP whose quote was displayed.
// NOT failover-eligible: buyChannel commits LSP-side liquidity.
// Asserts quote.params hash matches what the LSP returns at buy time (no post-display fee inflation).
async function executeJitBuy(
  quote: JitQuote,
  amountMsat: bigint,
  signal: AbortSignal,
): Promise<JitInvoiceResult>;
```

`runJitInvoiceFlow` (`context.tsx:108–189`) keeps its failover loop, calling `getJitQuote` per LSP. The Phase A loop has a 14s overall budget (7s per LSP, two LSPs); each LSP attempt splits into 5s `connect` + 5s RPC sub-budgets so a slow handshake doesn't starve the protocol call (per security-sentinel). Once a quote is in hand and the user confirms, the chosen LSP is locked in for `executeJitBuy`.

**Cancellation: AbortController, not requestCounterRef.** The original plan extended a monotonic counter across three async sites; reviews flagged this as fragile. Replace with a single `useRef<AbortController | null>` per Receive flow. Increment is replaced by `controller.abort()` followed by `new AbortController()`. Both `getJitQuote` and `executeJitBuy` accept `AbortSignal` and propagate it into `fetch` / WASM bridges. Phase B is non-cancellable post-`buyChannel`: `executeJitBuy` checks `signal.aborted` only between RPC steps and after `buyChannel` ignores the signal until completion (otherwise we'd leave an orphaned LSP commitment). Document this contract on the function.

**Quote freshness re-check** — bLIP-52 `valid_until` is currently checked once with a 120s buffer (`context.tsx:240–243`). Tighten and coordinate:

- `getJitQuote` rejects quotes with `<30s` remaining as the internal sanity gate.
- On `Generate invoice` tap, evaluate `valid_until` against a **single pinned `Date.now()`** (captured at the start of the handler — see julik review). If `pinned_now + 60s ≥ valid_until`, set `quoteStatus: 'reQuoting'` and call `getJitQuote(currentLsp, amountMsat, signal)` against the same LSP. Compare to displayed fee:
  - **Same fee** (exact `openingFeeMsat` match): proceed silently to `executeJitBuy` in the same handler.
  - **Different fee** (any change): set `quoteStatus: 'updated'` with the new params and fee. Render a `Fee updated` banner using the established amber tokens from `Backup.tsx` (`border-amber-500/30 bg-amber-500/10 text-amber-400`, `role="status" aria-live="polite"`). The banner persists until the next user action (next tap, Back, or unmount). User must tap Generate again — that second tap commits unconditionally if `quoteStatus === 'updated'`.

The render-time freshness check is removed — only the tap-time check matters because the user can't act without tapping. This eliminates the render-vs-tap disagreement window.

**Lifecycle hooks.** Subscribe to `visibilitychange` and `pageshow` on the Receive page. On visibility change to "visible", if `step === 'jit-review'` and `quoteStatus === 'updated'`, force-clear the banner (set to `'fresh'`) — the user has paused long enough that the previous "updated" signal is stale. If `quoteStatus === 'reQuoting'` and the in-flight signal has been aborted by a backgrounding-induced `pagehide`, transition to `'jit-quoting'` and re-fetch.

**Failure handling — Phase A**

Phase A failures fall back to on-chain receive (current behavior, brainstorm decision). The Review screen never renders if no LSP returned a usable quote. Specific cases:

| Cause | Behavior |
|---|---|
| Both LSPs unreachable / `get_info` fails | On-chain fallback. Same as today (`context.tsx:144–151`). |
| Both LSPs return menus where `selectCheapestParams` is null because `amount > maxPaymentSizeMsat` for every entry | On-chain fallback. (Future: surface "Amount too large for Lightning" copy — out of scope.) |
| Both LSPs return menus where every entry has `fee ≥ amount` for the requested amount | On-chain fallback (current behavior preserved; `selectCheapestParams` already filters at `types.ts:102`). |
| Phase A total timeout exceeds 14s (7s per LSP attempt: 5s connect + 5s RPC) | On-chain fallback. Add timeout to `runJitInvoiceFlow`. Reuses existing on-chain fallback path (no new typed error class needed). |

**Failure handling — Phase B**

Phase B is post-Confirm and after LSP-side liquidity reservation (`buyChannel`). Recovery rules:

| Failure step | Recovery |
|---|---|
| `buyChannel` returns a clear protocol rejection (e.g. `INVALID_PARAMS`, `EXPIRED`) | Transition to `'jit-error'` with `retryStep: 'jit-quoting'`. `Try again` CTA re-runs Phase A (fresh quote). No double-buy: prior `buyChannel` was rejected, so no commitment exists. **No on-chain escape hatch** — Zinqq is Lightning-first; "Try again" is enough. |
| `buyChannel` ambiguous failure (network timeout, connection drop after send) — LSP may have committed | Treat as orphan. Transition to `'jit-error'` with retry. The next Phase A attempt may produce a fresh quote, but the prior commitment may be wasted on the LSP side. Document this as a known gap; full crash recovery is out of scope (see Future). |
| `create_inbound_payment` fails after `buyChannel` succeeded | Retry up to 3x with exponential backoff (200ms / 500ms / 1.5s) using the same `buyResponse`, in-memory only. Wrap the retry in the same `AbortSignal` so Back cancels mid-retry. The LDK call is local and idempotent. |
| `createJitInvoice` (BOLT11 sign) fails | Same retry-with-same-`buyResponse` policy. |
| All retries exhausted | Surface "Couldn't finish setup. Try again later." in `'jit-error'`. Keep `buyResponse` in memory only — durable resume is out of scope. |

**LSP failover UX during Phase A**

A single undifferentiated spinner. Don't surface "Trying LQwD…" → "Trying Megalith…" — failover should complete in seconds and naming LSPs leaks plumbing. If failover-during-quote consistently exceeds ~5s in production telemetry, revisit.

**Quote-drift threshold** — Any change in `openingFeeMsat` triggers the soft re-confirm. No "absorb 1-sat changes silently" threshold; the user explicitly looked at a number, so any difference is surprising.

**Re-quote anti-griefing rate-limit (security-sentinel)** — Cap consecutive upward re-quotes at 2 per Receive session. If a third upward re-quote arrives, transition to `'jit-error'` with the message "Fee changed too many times — try again later." Prevents an LSP from gradually escalating fees through repeated soft re-confirms.

**`buyChannel` params hash assertion (security-sentinel)** — Before issuing `buyChannel`, `executeJitBuy` snapshots `quote.params` (the exact `OpeningFeeParams` displayed to the user, including `promise` signature). The LSPS2 client passes those params verbatim; if the LSP returns a `buyResponse` whose effective fee differs from `calculateOpeningFee(amountMsat, quote.params)`, raise `LSPS2ProtocolError('Fee mismatch at buy time')` and transition to `'jit-error'`. This closes the post-display fee inflation gap.

**Phase B HTLC fee-bound enforcement (security-sentinel)** — `accept_underpaying_htlcs=true` is unbounded by default: the LSP could deduct more than `openingFeeMsat` at HTLC time and the wallet would silently accept the underpayment. The LDK event handler that processes the post-`buyChannel` `PaymentClaimable` event must compare the actual claimable amount to `expected = invoiceAmountMsat - openingFeeMsat`. If `actual < expected`, **reject the HTLC** rather than silently underpay. Verify whether `src/ldk/event-handler.ts` already enforces this bound; if not, this is a Phase 5 deliverable (referenced in `docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md`).

**Back semantics** — Tap Back from Review:

1. Call `controller.abort()` on the active `AbortController` to cancel any in-flight Phase A re-quote. The handler's `signal.aborted` short-circuits before any state mutation.
2. Return to numpad with the amount preserved (do not clear `amountDigits`).
3. Suppress the header Copy / Share button while in `'jit-review'` (see `Receive.tsx:366` `showHeaderCopy` predicate — must include `step.step !== 'jit-review' && step.step !== 'jit-quoting' && step.step !== 'jit-buying' && step.step !== 'jit-error'`).
4. Back is **hidden / disabled** in `'jit-buying'` (non-cancellable; the LSP commitment is already in flight).

**Minimum-receive computation**

Per bLIP-52 fee math (`types.ts:85–92`):
```
proportionalFee_msat = ceil(amountMsat * proportional / 1_000_000)
fee_msat = max(proportionalFee_msat, minFeeMsat)
```

`selectCheapestParams` already filters menu entries where `fee_msat ≥ amountMsat` (`types.ts:102`). The smallest amount that yields net > 0 for a given menu entry is:

```
minSatForNet_msat = ceil(minFeeMsat / (1 - proportional / 1_000_000))   // when proportional < 1_000_000
```

Computed per menu entry; take the minimum across selectable entries. Final displayed minimum:

```
displayMinMsat = max(LSP.minPaymentSizeMsat, minSatForNet_msat across selectable entries) + 1_000_msat   // +1 sat margin so net ≥ 1 sat
```

Round up to whole sats for display (B-integer formatter expects `bigint` sats).

When `requestedAmountSats < displayMinSats`:
- Disable the `Generate invoice` button.
- Render: `Minimum receive: ₿X` directly under the breakdown, in `text-sm text-zinc-400`.
- The minimum is `aria-describedby` the disabled button (a11y).

### Implementation Phases

> **PR boundaries:** Phase 1+2+3 ship together as **PR 1** ("ship the disclosure"). Phase 4+5 ship as **PR 2** ("polish: stale-quote + retry + fee-bound").

#### Phase 1: Refactor `attemptJitInvoiceWithLsp` into quote + buy phases

Pure refactor. No UX change. Lays the foundation for the Review screen and proves the split in isolation.

- `src/ldk/context.tsx`
  - Extract `getJitQuote(lsp, amountMsat, signal)` covering: `connect` (5s budget) → `getOpeningFeeParams` (5s budget) → `selectCheapestParams` → `validUntil` `<30s` rejection.
  - Extract `executeJitBuy(quote, amountMsat, signal)` covering: param-hash snapshot → `buyChannel` → `calculateOpeningFee` (use the quote's fee value) → param-hash assertion against the buy response → `create_inbound_payment` → `createJitInvoice`.
  - Reshape `runJitInvoiceFlow` (`:108–189`) to call `getJitQuote` per-LSP in the failover loop with a 14s overall budget, then `executeJitBuy` once on the winning LSP.
  - **AbortController plumbing**: both functions take `AbortSignal`. `getJitQuote` checks `signal.aborted` between sub-steps; `executeJitBuy` checks before `buyChannel` only — once the buy is in flight, the signal is ignored.
  - **Promote the `validUntil` plain `Error` to a typed `JitQuoteFreshnessError`** and extend `classifyJitError` (`context.tsx:75`) to return a new `'quote_freshness'` tag. Mirrors existing `JitPeerConnectError` / `JitPaymentSizeOutOfRangeError` siblings.
  - **B-integer audit (one-line task):** `grep -n 'formatBtc\b' src/` and verify each caller passes `bigint`/`number` sats (not msat or BTC-decimal). Expected zero changes; document in PR description.
- `src/ldk/lsp/jit-failover.test.ts`
  - Update tests to reflect the split. Add tests:
    - Quote phase fails on primary, succeeds on fallback → `runJitInvoiceFlow` returns fallback's quote.
    - Quote phase succeeds on primary; `executeJitBuy` does not failover even on phase-B failure.
    - 14s total Phase A timeout enforced.
    - `AbortSignal` triggered between `connect` and `get_info` → `getJitQuote` rejects with `AbortError` and no RPC fires.
    - Param-hash mismatch between displayed quote and `buyResponse` → `executeJitBuy` raises `LSPS2ProtocolError('Fee mismatch at buy time')`.

#### Phase 2: Add `'jit-review'` step + Review screen UI + eager pre-warm

- `src/pages/Receive.tsx`
  - Extend `ReceiveState` per the architecture section. Use the prefix-discriminator state names (`'jit-quoting'`, `'jit-review'`, `'jit-buying'`, `'jit-error'`) for consistency with `Send.tsx`.
  - **Eager Phase A pre-warm (performance-oracle)**: as the user types on the numpad, debounce 300ms after the last keypress and speculatively call `runJitInvoiceFlow` for `getJitQuote` only (not buy). Cancel/refire via `AbortController` on each digit change. By the time the user taps Done, the quote is in hand and Review renders instantly. Cost: 1–2 wasted quote RPCs per session — `getOpeningFeeParams` is cheap and LSPs handle this fine.
  - On `handleConfirmAmount` (`:272`): if a pre-warmed quote is fresh (`validUntil > now + 60s` and matches `amountSats`), transition directly to `'jit-review'`. Otherwise transition to `'jit-quoting'` and await the quote. On Phase A failure → existing on-chain fallback path.
  - Build the Review JSX inline (no separate component until a second caller exists, per simplicity reviewer): mirror `Send.tsx:861–907` styling exactly:
    - `<ScreenHeader title="Review" onBack={handleReviewBack} />`
    - three-row layout: `Amount` / `Setup fee` (− prefix) / `You'll receive`, with `<hr className="border-dark-border" />` divider after the Setup fee row
    - row labels use `text-[var(--color-on-dark-muted)]` (matches Send's row labels at `:868, :874, :878`)
    - primary `Generate invoice` CTA mirrors `Send.tsx:891–903`: `bg-accent ... text-white ... disabled:cursor-not-allowed disabled:opacity-70`, with the spinner-inline-children pattern when `step === 'jit-buying'` or `quoteStatus === 'reQuoting'`
    - error red is `text-red-400` (codebase convention; not `text-red-500`)
    - no secondary button (Back lives in header)
  - **Skeleton during `'jit-quoting'`**: pre-render the Amount row immediately (already known from numpad). Reserve exact heights for Setup fee and You'll receive rows to avoid CLS when Phase A returns.
  - Use `formatBtc(satoshis)` (`src/utils/format-btc.ts:5`) for all three rows. Already produces `₿10,000` integer form.
  - Suppress `showHeaderCopy` on `'jit-quoting' | 'jit-review' | 'jit-buying' | 'jit-error'`.
  - **`<link rel="preconnect">`** to the LSP same-origin proxy origin on the Receive route mount (lightweight latency win per performance-oracle).
- `src/pages/Receive.test.tsx`
  - Add tests: numpad → review render with correct numbers; eager pre-warm fires after debounce; Back returns to numpad with amount preserved AND aborts in-flight `getJitQuote`; Generate triggers Phase B.

#### Phase 3: Block + suggest minimum

- `src/ldk/lsps2/types.ts`
  - Add `computeMinReceiveSats(menu: OpeningFeeParams[], lspMinPaymentSizeMsat: bigint): bigint` per the math in the Architecture section. Pure function, unit-testable.
- `src/pages/Receive.tsx`
  - In `'jit-review'` state, compute `displayMin` from the quote's source menu. (Phase 1 must surface the menu, not just the picked params, into the quote object — adjust `JitQuote` shape: `{ params: OpeningFeeParams; menu: OpeningFeeParams[]; ... }`.)
  - When `amountSats < displayMin`: disable CTA, render `Minimum receive: ₿X` (`text-sm text-zinc-400`) with `aria-describedby` wired to the button.
- Tests
  - `types.test.ts`: `computeMinReceiveSats` with min-fee-only, proportional-only, mixed menus.
  - `Receive.test.tsx`: too-small input → CTA disabled, minimum rendered, button is `aria-describedby` the minimum copy.

#### Phase 4: Stale quote re-fetch + lifecycle hooks

- `src/pages/Receive.tsx`
  - On `Generate invoice`: pin `const now = Date.now()` at handler start. Read `params.validUntil`. If `now + 60s ≥ validUntil`, set `quoteStatus: 'reQuoting'` and call `getJitQuote(currentLsp, amountMsat, signal)`. Compare `openingFeeMsat`:
    - Match → call `executeJitBuy` in the same handler.
    - Differ → set `quoteStatus: 'updated'` with new params/fee. Do NOT call `executeJitBuy`. Re-tap commits unconditionally.
  - **CTA disable rules** (julik): `Generate invoice` is `disabled` when `quoteStatus === 'reQuoting' || step === 'jit-buying'`. Prevents double-tap from letting an older response paint over a newer one.
  - Render `Fee updated` banner when `quoteStatus === 'updated'` using the established amber tokens from `Backup.tsx:82, :135` (`border-amber-500/30 bg-amber-500/10 text-amber-400`, `role="status" aria-live="polite"`). Banner persists until next user action — no auto-dismiss timer.
  - **Re-quote anti-griefing**: track `consecutiveUpwardReQuotes` in `'jit-review'` state. Reset on Back. On the third consecutive upward re-quote, transition to `'jit-error'` ("Fee changed too many times — try again later.").
  - **Lifecycle hooks**: subscribe to `visibilitychange` and `pageshow`. On visible-resume:
    - If `step === 'jit-review'` and `quoteStatus === 'updated'` and the resume gap exceeds 5s, force-clear the banner (`'fresh'`).
    - If `step === 'jit-quoting'` and the in-flight signal was aborted by `pagehide`, re-fetch.
    - If `step === 'jit-review'` and `validUntil` is now expired, transition back to `'jit-quoting'` and re-fetch.
- Tests
  - Mock `Date.now()` and `validUntil` to force a stale state. Assert silent proceed when fee matches; soft re-confirm when fee differs; banner persists across multiple renders until next action.
  - Simulate `visibilitychange` with stale `validUntil` → assert re-fetch transition.
  - Three consecutive upward re-quotes → assert `'jit-error'`.

#### Phase 5: Phase B retry + HTLC fee-bound enforcement + a11y

- `src/ldk/context.tsx`
  - In `executeJitBuy`, retry `create_inbound_payment` and `createJitInvoice` up to 3x on local LDK errors with exponential backoff (200ms / 500ms / 1.5s) using the same `buyResponse`. Each retry checks `signal.aborted` first — Back during retry cancels the loop. Distinguish LSP-side `buyChannel` rejection (no retry; transition to `'jit-error'`) from local LDK errors (retry).
  - Hold `buyResponse` in an in-memory `useRef` only — no IndexedDB. Cleared on success, on `'jit-error'` final-failure render, or on Receive-page unmount.
- `src/ldk/event-handler.ts` (or wherever `PaymentClaimable` is handled)
  - **HTLC fee-bound enforcement (security-sentinel)**: when claiming a JIT-channel payment, compare actual claimable amount to `expected = invoiceAmountMsat - openingFeeMsat`. If `actual < expected`, reject the HTLC. Verify whether this enforcement already exists per `docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md`; if not, add it as a Phase 5 deliverable.
- `src/pages/Receive.tsx`
  - In `'jit-error'`, render the same shell as `Send.tsx:790–816`: red icon + `message` + `Try again` CTA that uses `retryStep` to route back. No on-chain escape hatch.
- **A11y** (split out so it doesn't get lost in a broader phase):
  - Add `aria-live="polite"` region announcing the Review on render (use the existing pattern from `Receive.tsx:406`, `OpenChannel.tsx:300`).
  - Set default focus on the `Generate invoice` button (or the screen heading if CTA is disabled by below-minimum).
  - Add `aria-label="<sats> satoshis"` to each `formatBtc` rendered amount on the Review — the `₿` glyph is not consistently spoken by screen readers.
  - Wire `aria-describedby` from disabled CTA to minimum-receive copy.
  - jest-axe pass on each Review state variant (happy, below-minimum, fee-updated, error).
- Tests
  - Mock LDK to throw on `create_inbound_payment` first call → assert retry → success. Mock all 3 → assert `'jit-error'` rendered.
  - Mock `signal.abort()` mid-retry-loop → assert no further retries.
  - Mock LSP claim with delta exceeding `openingFeeMsat` → assert HTLC rejection.

## Alternative Approaches Considered

1. **Live disclosure on the numpad screen** (no separate Review step). Rejected: numpad jitters as the user types; "block + suggest minimum" affordance is awkward inline; the user's brainstorm answer explicitly chose the Review form.
2. **After-invoice expanded copy under QR** (status quo, with more detail). Rejected: by the time the QR exists, the LSP-side `buyChannel` has committed liquidity. The user can't actually back out, so the disclosure is fake choice.
3. **Auto-gross-up the invoice** (user types ₿10,000, wallet invoices ₿12,600 so net = 10,000). Rejected per brainstorm: changes what the user typed; the QR amount no longer matches the request; introduces a mode toggle. Revisit only if requested.
4. **Bundle channel reserve into the Setup fee number**. User's initial inclination, then resolved against in brainstorm. Reserve is the user's own sats locked in their own channel — locked, not lost — so showing it as a cost overstates the price.
5. **Always show Review (even when no JIT)**. Rejected: nothing to disclose when no fee; one extra tap for the happy path of subsequent receives.

## System-Wide Impact

### Interaction Graph

During numpad input, a 300ms-debounced effect calls `runJitInvoiceFlow` (quote-only) speculatively, scoped by an `AbortController` that is aborted on every digit change. On Done, `handleConfirmAmount` (Receive.tsx) consumes the pre-warmed quote if fresh, else transitions to `setReceiveState({ step: 'jit-quoting' })` → `runJitInvoiceFlow` per-LSP loop → `connect(peerManager, ...)` → `lsps2Client.getOpeningFeeParams` → `selectCheapestParams` → `validUntil` 30s gate → returns `JitQuote` → `setReceiveState({ step: 'jit-review', quoteStatus: 'fresh', ... })` → render Review. On `Generate invoice` tap, the handler pins `Date.now()` and optionally calls `getJitQuote` (re-quote) against the same LSP. On commit: `setReceiveState({ step: 'jit-buying' })` → `executeJitBuy` snapshots `quote.params` → `buyChannel` → asserts buy-response fee matches `calculateOpeningFee(amountMsat, snapshot)` → `channelManager.create_inbound_payment` (with up to 3 backed-off retries) → `lsps2Client.createJitInvoice` → BOLT11 returned → `setReceiveState({ step: 'success', ... })`. The post-`buyChannel` event handler (`event-handler-multi-lsp-trust-set.md` pattern) consumes the `PaymentClaimable` and **enforces `actual ≥ invoiceAmountMsat - openingFeeMsat`** before claiming. `AbortController.abort()` on Back propagates into all RPC layers via `signal`.

### Error & Failure Propagation

| Source | Propagated as | Handled at |
|---|---|---|
| `connect` failure | `JitPeerConnectError` (existing, `context.tsx:62`) | `runJitInvoiceFlow` (failover) |
| `getOpeningFeeParams` failure (HTTP / malformed) | `LSPS2ProtocolError` | `runJitInvoiceFlow` (failover) |
| `selectCheapestParams` returns null | `JitPaymentSizeOutOfRangeError` (existing, `context.tsx:67–69`) | `runJitInvoiceFlow` (failover) |
| `validUntil` < 30s remaining at quote time | `JitQuoteFreshnessError` (new — Phase 1 promotes from plain `Error`) | `runJitInvoiceFlow` (failover); `classifyJitError` extended with `'quote_freshness'` tag |
| Phase A 14s overall timeout | `AbortError` (from `AbortController`) | `runJitInvoiceFlow` → on-chain fallback (no new typed error class) |
| `buyChannel` clear protocol rejection | `LSPS2ProtocolError` | `'jit-error'` (no failover) |
| `buyChannel` ambiguous failure (timeout, dropped connection) | `LSPS2NetworkError` | `'jit-error'` — note that LSP commitment may be orphaned (Future) |
| `buyChannel` returns fee differing from displayed quote | `LSPS2ProtocolError('Fee mismatch at buy time')` (new in Phase 1) | `'jit-error'` |
| `create_inbound_payment` LDK error | LDK exception → `LdkError` | `executeJitBuy` retry loop (3x with backoff) → `'jit-error'` |
| `createJitInvoice` failure | `BOLT11EncodeError` | `executeJitBuy` retry loop → `'jit-error'` |
| Post-claim HTLC underpayment beyond `openingFeeMsat` | `LSPS2ProtocolError('HTLC underpayment exceeds disclosed fee')` (Phase 5) | LDK event handler — reject the HTLC |

Retry strategy alignment: Phase A retries are LSP-level failovers (try next LSP). Phase B retries are call-level (re-issue local LDK calls with the same `buyResponse`). They never overlap.

### State Lifecycle Risks

- **`buyResponse` orphan**: `buyChannel` succeeded, app crashes before `create_inbound_payment` completes. Phase 5 retries up to 3x with backoff using an in-memory ref. If the app is closed mid-retry, the LSP commitment is wasted — same as today. Durable resume tracked in Future.
- **Stale `'jit-review'` state on backgrounding**: PWA backgrounded for hours. On resume via `visibilitychange`/`pageshow` listener, the lifecycle hook re-evaluates `validUntil` against a fresh `Date.now()`; if expired, transition back to `'jit-quoting'` and re-fetch. If a `'jit-review'` had `quoteStatus: 'updated'` and the resume gap exceeds 5s, banner is force-cleared (the prior "updated" signal is no longer relevant).
- **AbortController race after Back**: User taps Back during in-flight `getJitQuote`. `controller.abort()` fires → handler short-circuits via `signal.aborted` before any state mutation → response is dropped on arrival. Phase 1 plumbs `AbortSignal` through both `getJitQuote` and `executeJitBuy` (the latter ignoring abort post-`buyChannel`).
- **Pre-warm cancellation chains**: numpad keypresses produce overlapping pre-warm requests. Each keypress aborts the previous controller and creates a new one; only the most recent in-flight request can land. Closure capture on the controller reference (not its abort signal value) prevents stale handlers from seeing the wrong instance.

### API Surface Parity

- **Receive.tsx is the only receive surface.** No second receive entry point that needs the same disclosure.
- **`requestJitInvoice` (`context.tsx:483`)** is exposed on the LDK context. Replace with two new exports: `getJitQuote`, `executeJitBuy`. Old name removed. Check call sites — only `Receive.tsx` consumes it (verified by repo research).
- **BOLT12 receive flow** (`docs/brainstorms/2026-04-20-bolt12-online-receive-brainstorm.md`) is a separate future surface that may or may not need similar disclosure. Not in scope; revisit when BOLT12 lands.

### Integration Test Scenarios

1. **Happy path with disclosure**: numpad → ₿10,000 → Done → review renders with `Setup fee: ₿2,500`, `You'll receive: ₿7,500` → Generate → QR with ₿10,000 BOLT11. Assert `AbortController` instance scoped the work and was not aborted.
2. **Eager pre-warm hits**: type `1`, `0`, `0`, `0`, `0` with sub-300ms intervals → only one `getOpeningFeeParams` call fires (debounce); on Done, review renders without an additional RPC call.
3. **Stale quote, fee changed**: numpad → Done → review → wait until `validUntil − 60s` boundary crossed → Generate → silent re-quote returns higher fee → review updates with `quoteStatus: 'updated'`, banner persists across renders → second Generate tap → QR. Assert two `getJitQuote` calls, only one `executeJitBuy`.
4. **CTA disabled during re-quote**: stale-quote branch in flight → assert Generate CTA has `disabled` attribute and `aria-disabled="true"`.
5. **Below minimum**: numpad → ₿1,000 → Done → review renders with disabled CTA + `Minimum receive: ₿3,000`. Assert button is `aria-describedby` the min copy.
6. **Phase B local failure recovery with backoff**: mocks throw on first `create_inbound_payment`, succeeds after 200ms → assert no second `buyChannel` call, exactly one `buyResponse` reused, QR eventually rendered.
7. **Back during retry cancels loop**: mocks throw on every `create_inbound_payment`; user taps Back at retry attempt 2 → assert no third attempt, return to numpad with amount preserved.
8. **Param-hash mismatch**: mocks return a `buyResponse` with effective fee differing from displayed quote → assert `'jit-error'` rendered with mismatch message; no `create_inbound_payment` call.
9. **HTLC fee-bound enforcement**: post-claim event with `actual < expected` delta → assert HTLC rejection (event-handler test).
10. **Back from review during in-flight re-quote**: stale-quote branch starts re-fetch → user taps Back → assert `AbortController.abort()` called, dropped response on arrival, numpad shown with amount preserved.
11. **LSP failover during Phase A is invisible to UI**: primary fails, fallback succeeds → review renders with fallback's fee. UI doesn't expose primary attempt.
12. **`visibilitychange` re-fetch**: Review shown → tab hidden 10 minutes → tab visible → `validUntil` now expired → assert transition back to `'jit-quoting'` and re-fetch.
13. **Anti-griefing cap**: three consecutive upward re-quotes on Generate → assert transition to `'jit-error'` with anti-griefing message.

## Acceptance Criteria

### Functional Requirements

- [ ] `Receive.tsx` adds `'jit-quoting'`, `'jit-review'`, `'jit-buying'`, `'jit-error'` steps to `ReceiveState`. Names follow Send.tsx prefix-discriminator convention.
- [ ] `'jit-review'` carries `quoteStatus: 'fresh' | 'reQuoting' | 'updated'` (single source of truth, no separate timer field).
- [ ] When `needsJitChannel === true` after Done, the wallet runs Phase A and renders the Review on success. Eager pre-warm during numpad input (300ms debounce) makes the common case render instantly.
- [ ] When `needsJitChannel === false`, current behavior is preserved (no Review).
- [ ] Review shows three rows: `Amount`, `Setup fee` (− prefix), `You'll receive`. All three use `formatBtc`. Skeleton during `'jit-quoting'` reserves exact row heights (no CLS).
- [ ] Row labels use `text-[var(--color-on-dark-muted)]`, divider is `<hr className="border-dark-border" />`, primary CTA mirrors `Send.tsx:891–903` exactly.
- [ ] Setup fee = LSPS2 opening fee only. Channel reserve is not included and not displayed.
- [ ] Tapping Back returns to numpad with the amount preserved; in-flight Phase A work is cancelled via `AbortController.abort()`.
- [ ] Back is hidden / disabled in `'jit-buying'` (non-cancellable; LSP commitment in flight).
- [ ] Header Copy / Share is suppressed in `'jit-quoting' | 'jit-review' | 'jit-buying' | 'jit-error'`.
- [ ] When `amountSats < displayMin`, the Generate CTA is disabled and `Minimum receive: ₿X` is rendered.
- [ ] On Generate tap, the handler pins `Date.now()` once and uses it for both freshness and post-re-quote checks. If `pinned_now + 60s ≥ validUntil`, silently re-quote. Same fee → proceed. Different fee → `quoteStatus: 'updated'` + `Fee updated` banner (amber tokens from `Backup.tsx`, `role="status"` `aria-live="polite"`); user must tap Generate again.
- [ ] Generate CTA is `disabled` while `quoteStatus === 'reQuoting'` or `step === 'jit-buying'`.
- [ ] Three consecutive upward re-quotes transition to `'jit-error'` with anti-griefing copy.
- [ ] `executeJitBuy` snapshots `quote.params` and asserts the `buyResponse` fee matches `calculateOpeningFee(amountMsat, snapshot)`; mismatch transitions to `'jit-error'`.
- [ ] LDK event handler enforces `actual ≥ invoiceAmountMsat - openingFeeMsat` on JIT-channel HTLC claim; underpayment beyond the disclosed fee is rejected.
- [ ] Phase B `buyChannel` rejection renders `'jit-error'` with `Try again`. No `Receive on-chain instead` (Lightning-first). No double-buy on retry (Phase A re-fetches first).
- [ ] Phase B local LDK failures retry up to 3x with backoff (200ms / 500ms / 1.5s) using the same `buyResponse`. `signal.aborted` short-circuits the retry loop.
- [ ] Phase A enforces a 14s total timeout (7s per LSP attempt: 5s connect + 5s RPC) before falling back to on-chain.
- [ ] LSP failover during Phase A is invisible to the UI; a single spinner is shown.
- [ ] Receive page subscribes to `visibilitychange` and `pageshow`. On visible-resume: stale `'updated'` banner cleared after 5s gap; expired `'jit-review'` re-fetches; aborted `'jit-quoting'` re-fetches.
- [ ] `<link rel="preconnect">` to LSP same-origin proxy origin on Receive route mount.

### Non-Functional Requirements

- [ ] Phase A median latency ≤ 500ms in the common case (eager pre-warm hits) and ≤ 3s when pre-warm misses. p95 bounded by the 14s total timeout.
- [ ] Review screen renders without layout shift after Phase A completes (skeleton/spinner sized to match the Review layout).
- [ ] No regression in QR-rendered time when no JIT is needed (existing happy path).

### Accessibility

- [ ] Review render announces the step via `aria-live="polite"`.
- [ ] Each `formatBtc` value on Review has an `aria-label` with the spelled-out sat amount (e.g. `aria-label="10,000 satoshis"`) — the `₿` glyph is not consistently spoken.
- [ ] Default focus on Review lands on the Generate CTA (or the screen heading if CTA is disabled).
- [ ] When CTA is disabled by below-minimum, the minimum copy is `aria-describedby` the button.
- [ ] `Fee updated` banner uses `role="status"` and `aria-live="polite"`; it persists until the next user action (no auto-dismiss timer) so screen readers reliably announce it.
- [ ] jest-axe passes on each Review state variant (happy, below-minimum, fee-updated, error).

### Quality Gates

- [ ] `vitest` unit test coverage on `getJitQuote`, `executeJitBuy`, `computeMinReceiveSats` ≥ 90%.
- [ ] Integration tests cover all seven scenarios listed above.
- [ ] Manual test pass on iOS Safari PWA: backgrounded during Phase A, locked during Review, low-battery mode.
- [ ] Pre-PR audit confirms no remaining BTC-decimal user-facing string from `bip321.ts` or stale code paths.

## Success Metrics

- **Reduction in "where's my missing sats?" support contacts** — measured via informal review of Discord / GitHub issues post-ship.
- **Below-minimum block rate** — proportion of Receive attempts that hit the disabled CTA. High rate (>10%) signals copy or amount-suggestion needs work.
- **Back-from-review rate** — proportion of users who back out after seeing the fee. Some back-out is healthy (informed consent); high rates (>30%) signal fees are mispriced or framed wrong.
- **Phase B failure rate** — should be near-zero. Any sustained failure rate (>0.5%) indicates LSP-side issues to investigate.
- **Quote-drift events** — fraction of stale re-quotes where the fee changed. If high, consider shortening the freshness buffer.

## Dependencies & Risks

### Dependencies

- LDK Node WASM bindings remain stable for `create_inbound_payment` and `accept_underpaying_htlcs`.
- LSPS2 LSP partners (LQwD primary, Megalith fallback) honor `valid_until` semantics consistently with bLIP-52.
- No upstream changes needed to `runJitInvoiceFlow`'s failover policy (PR #148 already merged).

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `buyResponse` orphan after app crash mid-Phase-B | LSP-side fee committed; user perceives wasted setup fee | In-memory ref + bounded in-app retry (Phase 5). Durable crash recovery tracked in Future Considerations. |
| `AbortController` not threaded through all async sites | Stale Phase A response races a new one | Phase 1 explicitly takes `AbortSignal` in both phase functions and propagates into RPC layers. Integration test scenario 6 enforces cancel-on-Back. |
| Quote drift creates "Fee updated" loops if LSP rapidly republishes | User sees a flash of new numbers repeatedly | Limit to one re-quote per Generate tap; second tap commits. Anti-griefing cap: 3 consecutive upward re-quotes → `'jit-error'`. |
| Phase A pre-warm fires too aggressively, hammering the LSP | LSP rate limits / DoS detection | 300ms debounce + cancellation on every digit change keeps active requests ≤1 per Receive flow. `getOpeningFeeParams` is a cheap RPC. |
| HTLC underpayment beyond disclosed fee | Silent value loss; disclosure becomes a lie | Phase 5 event-handler enforces `actual ≥ expected`; reject otherwise. |
| LSP returns inflated fee at `buyChannel` time vs. displayed quote | User commits at a different price than they saw | `executeJitBuy` snapshots `quote.params` and asserts `buyResponse` fee matches `calculateOpeningFee(amountMsat, snapshot)`; mismatch transitions to `'jit-error'`. |
| `formatBtc` audit reveals a caller passing msat or BTC-decimal | Wrong displayed amount | Phase 1 grep audit. Expected zero changes. Add a typed wrapper `formatSats(sats: bigint)` in a follow-up if drift becomes a concern. |

## Resource Requirements

- **One engineer**, ~3–5 days for Phase 1–4, ~2 days for Phase 5–6 including manual PWA testing on iOS Safari and Android Chrome.
- **No infrastructure changes.** All work is client-side.
- **No design review needed** — UI mirrors Send review screen patterns. A look-and-feel pass after Phase 2 is recommended.

## Future Considerations

- **`buyResponse` durable resume**: persist across app restart so a crashed Phase B can be picked up next launch, avoiding wasted LSP commitments. Out-of-scope today (in-memory only); revisit if Phase B failure rate warrants it.
- **Reactive `useChannelState` subscriber**: the cross-device "channel becomes usable mid-review" concern is a symptom of channel state being polled rather than observed. The durable answer is a single observer that all flows (Send, Receive, balance) consume. Cut from this plan as out-of-scope tactical work; tracked as a separate refactor.
- **Telemetry pipeline**: ship telemetry events when a real metrics pipeline (PostHog / similar) is integrated. Today there is no consumer, so emitting events is dead code. Suggested events when the pipeline lands: `jit_quote_ms`, `review_dwell_ms`, `back_from_review`, `below_minimum_blocked`, `quote_drift_msat`, `phase_b_failure`.
- **LSP `get_info` cache** (60s TTL keyed by LSP pubkey): if Phase A latency telemetry shows it matters, add a short cache so re-entering Receive within the window skips the round-trip (still revalidates `valid_until` before commit).
- **Per-LSP fee transparency**: surface "via LQwD" or "via Megalith" on Review for power-user mode. Default off; debug toggle.
- **BOLT12 receive disclosure**: when the BOLT12 online-receive brainstorm lands, evaluate whether the same Review pattern applies (probably yes — same JIT mechanics).
- **Auto-gross-up mode**: explicit opt-in toggle in settings, "Receive net amount", which inverts the math so the user nets the amount they typed. Brainstorm explicitly deferred this; revisit only on user request.
- **Channel-reserve disclosure on the home screen**: a "spendable vs. capacity" breakdown for the wallet balance. Out of scope here; lives in a future balance-UX brainstorm.
- **Above-max-payment-size UX**: today, when both LSPs cap below the requested amount, we silently fall back to on-chain. A future surface could explain "Amount too large for Lightning" with a richer disclosure.

## Documentation Plan

- **`docs/solutions/integration-issues/lsps2-jit-quote-buy-phase-split.md`** — write post-merge documenting the Phase 1 split rationale, especially the failover-only-on-quote constraint and the `requestCounterRef` extension.
- **No user-facing docs** — UX is self-explanatory from the Review screen copy.
- **CHANGELOG entry** if/when one exists; today, PR description suffices.

## Sources & References

### Origin

- **Brainstorm document:** `docs/brainstorms/2026-05-06-lsps2-receive-fee-disclosure-brainstorm.md`
  - Carried-forward decisions: Review screen between numpad and invoice (only when JIT); Setup fee = LSP opening fee only (no reserve); block + suggest minimum when fee ≥ amount; silent re-quote on stale; on-chain fallback for Phase A failure; "Setup fee" label; B-integer denomination (already done at formatter level).

### Internal References

- **Receive flow:** `src/pages/Receive.tsx:19–24` (state), `:64–77` (`needsAmount`), `:95–177` (JIT effect), `:272` (`handleConfirmAmount`), `:366` (`showHeaderCopy`), `:494` (current `Setup fee` line).
- **Send flow review pattern (mirror):** `src/pages/Send.tsx:25–72` (`SendStep`), `:861–907` (review JSX), `:891–903` (primary CTA), `:573–581` (`handleReviewBack`), `:790–816` (error pattern).
- **LDK context:** `src/ldk/context.tsx:108–189` (`runJitInvoiceFlow`), `:196–280` (`attemptJitInvoiceWithLsp`), `:240–243` (`validUntil` 120s check), `:483–497` (`requestJitInvoice` wrapper), `:67–69` (`JitPaymentSizeOutOfRangeError`).
- **LSPS2 primitives:** `src/ldk/lsps2/types.ts:34` (`validUntil`), `:37–38` (`min/maxPaymentSizeMsat`), `:85–92` (`calculateOpeningFee`), `:94–107` (`selectCheapestParams`), `:60, 70–71` (`PAYMENT_SIZE_TOO_SMALL`).
- **LSPS2 client:** `src/ldk/lsps2/client.ts:30` (`getOpeningFeeParams`), `:50` (`min_payment_size_msat` log), `:56` (`buyChannel`), `:99` (`createJitInvoice`).
- **Formatter:** `src/utils/format-btc.ts:5–16` (already produces `₿N` integer form), `src/utils/format-btc.test.ts`.
- **Tests:** `src/pages/Receive.test.tsx:236–340`, `src/ldk/lsp/jit-failover.test.ts`, `src/ldk/lsps2/types.test.ts`.

### Solutions Docs (Prior Gotchas)

- **`docs/solutions/integration-issues/lsps2-jit-receive-react-effect-dependencies.md`** — `requestCounterRef` pattern. Critical: must extend to both new phases.
- **`docs/solutions/integration-issues/lsps2-jit-receive-channel-config.md`** — `accept_underpaying_htlcs` + 100% in-flight cap. Establishes that LDK accepts post-fee amount; Review's "You'll receive" matches this reality.
- **`docs/solutions/integration-issues/ldk-event-handler-multi-lsp-trust-set.md`** — multi-LSP trust set pattern (PR #148). Failover policy reused.
- **`docs/solutions/integration-issues/anchor-channels-lsp-compatibility.md`** — confirms reserve is not a cost; reaffirms brainstorm decision.
- **`docs/solutions/integration-issues/ldk-anchor-channel-feerate-floor-fix.md`** — feerate floor context (not blocking, informational).
- **`docs/solutions/design-patterns/react-send-flow-amount-first-state-machine.md`** — established two-phase validation pattern; mirror for Review.
- **`docs/solutions/ui-bugs/empty-to-field-lightning-review-screen.md`** — use `||` not `??` for WASM-binding strings in Review.

### Related Plans

- `docs/plans/2026-05-04-001-feat-lsp-failover-lqwd-primary-plan.md` — most recent JIT-touching plan; established `runJitInvoiceFlow` shape.
- `docs/plans/2026-04-02-004-fix-lsps2-jit-invoice-payment-failures-plan.md` — JIT payment claiming.
- `docs/plans/2026-03-31-001-feat-lsps2-default-receive-flow-plan.md` — original LSPS2 default receive.

### External References

- **bLIP-52** (LSPS2): JIT channel negotiation spec; `valid_until` ISO 8601, fee math formulas.
- **BIP 177** (informal, integer-bitcoin denomination concept). Already applied at the formatter level.
