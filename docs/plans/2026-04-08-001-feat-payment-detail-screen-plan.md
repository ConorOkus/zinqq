---
title: "feat: Payment detail screen with BIP 177 cleanup"
type: feat
status: completed
date: 2026-04-08
origin: docs/brainstorms/2026-04-08-payment-detail-screen-brainstorm.md
---

# feat: Payment detail screen with BIP 177 cleanup

## Overview

Add a read-only payment detail screen accessible by tapping any transaction in the Activity list. Uses an Amount-Hero layout with the `₿` amount displayed prominently at the top, followed by key-value detail rows (date, time, status, type). Same layout for all payment types (sent/received, lightning/on-chain). Additionally, clean up remaining "sats" string references in user-facing error messages to use `formatBtc()` for full BIP 177 consistency (see brainstorm: `docs/brainstorms/2026-04-08-payment-detail-screen-brainstorm.md`).

## Proposed Solution

### Part 1: Payment Detail Screen

**New file: `src/pages/TransactionDetail.tsx`**

Amount-Hero layout with `ScreenHeader` (back to `/activity`):

```
┌─────────────────────────────┐
│  ←  Payment Details          │
│                             │
│         Sent ↑              │
│        -₿52,500             │
│                             │
│  ─────────────────────────  │
│                             │
│  Date        Sat, 1 Nov 25 │
│  Time            20:20:59  │
│  Status          Complete  │
│  Type           Lightning  │
│                             │
└─────────────────────────────┘
```

**Navigation approach:** Pass the full transaction object via `react-router` state (`useNavigate({ state: { tx } })`), with a fallback lookup from `useTransactionHistory()` by id+layer for direct URL access. This avoids the paymentHash/txid collision problem (both are 64-char hex) without needing query params or compound IDs.

- Route: `{ path: 'activity/:txId', element: <TransactionDetail /> }` in `src/routes/router.tsx`
- Activity list items become `<Link>` elements with `to={`/activity/${tx.id}`}` and `state={{ tx }}`

**States:**
- **Loading:** Show spinner while `useTransactionHistory` is loading (only hit on direct URL access)
- **Not found:** Show "Transaction not found" when loading completes but no match — handles bookmarked URLs for transactions that may have been pruned or never existed

**Edge cases:**
- `timestamp === 0` (unconfirmed on-chain with no `firstSeen`): Show "Pending" for date/time rows
- Zero-amount transactions (e.g., channel sweeps): Display `₿0` — `formatBtc` handles this already
- Failed payments: Not displayed — `useTransactionHistory` filters them at line 57, which is correct behavior for now (see brainstorm: no actions, info-only)

### Part 2: Make Activity List Items Clickable

Update `src/pages/Activity.tsx`:
- Replace `<div key={tx.id}>` row wrapper with `<Link to={`/activity/${tx.id}`} state={{ tx }}>` from react-router
- Style the link to preserve current appearance (no underline, same colors)
- Keyboard accessible by default via `<Link>` (no extra ARIA work needed)

### Part 3: BIP 177 Error Message Cleanup

Replace hardcoded "sats" in user-facing error strings with `formatBtc()`:

| File | Line(s) | Current | New |
|------|---------|---------|-----|
| `src/pages/OpenChannel.tsx` | 88 | `Minimum channel size is 20,000 sats` | `Minimum channel size is ${formatBtc(MIN_CHANNEL_SATS)}` |
| `src/pages/OpenChannel.tsx` | 93 | `Maximum channel size is 16,777,215 sats` | `Maximum channel size is ${formatBtc(MAX_CHANNEL_SATS)}` |
| `src/pages/Send.tsx` | 350 | `Amount must be at least 294 sats (dust limit)` | `Amount must be at least ${formatBtc(MIN_DUST_SATS)} (dust limit)` |
| `src/onchain/context.tsx` | 62 | `Available: ... sats, needed: ... sats` | Use `formatBtc()` for both values |
| `src/onchain/context.tsx` | 71 | `below the minimum (294 sats)` | `below the minimum (${formatBtc(294n)})` |
| `src/onchain/context.tsx` | 197 | `Fee too high: ... sats exceeds safety limit` | Use `formatBtc()` |
| `src/onchain/context.tsx` | 296, 345 | `reserving ... sats for Lightning channel safety` | Use `formatBtc(ANCHOR_RESERVE_SATS)` |

Console logs and internal variable names stay as-is (not user-facing). Test assertions in `Send.test.tsx:321` will need updating to match the new error text.

## Technical Considerations

- **Date/time formatting:** Use `Intl.DateTimeFormat` for the detail screen's absolute date and time display. The activity list keeps relative time; the detail screen shows full date (`Sat, 1 Nov 2025`) and time (`20:20:59`).
- **Navigation state vs URL lookup:** Router state is the fast path (instant render, no lookup). URL-based fallback scans `transactions` array by `id` — this is O(n) but the list is small (dozens to low hundreds). No index needed.
- **Accessibility:** `<Link>` elements are natively keyboard-accessible and screen-reader friendly. Direction indicator icon gets `aria-hidden="true"` since the text label ("Sent"/"Received") conveys the same info.

## Acceptance Criteria

- [x] Tapping a transaction in Activity navigates to `/activity/:txId`
- [x] Detail screen shows: direction indicator + label, amount in `₿` format, date, time, status, type
- [x] Back button returns to `/activity`
- [x] Loading state shown when navigating directly to URL
- [x] "Transaction not found" shown for invalid IDs
- [x] Pending transactions show "Pending" for date/time when timestamp is 0
- [x] Same layout for sent/received, lightning/on-chain
- [x] Activity list items are keyboard accessible
- [x] All user-facing "sats" strings replaced with `formatBtc()` calls
- [x] Existing tests updated for new error message format

## Files to Create/Modify

**Create:**
- `src/pages/TransactionDetail.tsx` — new detail screen component

**Modify:**
- `src/routes/router.tsx` — add `activity/:txId` route
- `src/pages/Activity.tsx` — make list items `<Link>` elements
- `src/pages/OpenChannel.tsx` — BIP 177 error messages (lines 88, 93)
- `src/pages/Send.tsx` — BIP 177 error message (line 350)
- `src/onchain/context.tsx` — BIP 177 error messages (lines 62, 71, 197, 296, 345)
- `src/pages/Send.test.tsx` — update error assertion (line 321)

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-04-08-payment-detail-screen-brainstorm.md](docs/brainstorms/2026-04-08-payment-detail-screen-brainstorm.md) — key decisions: Amount-Hero layout, BIP 177 `₿` symbol formatting app-wide, receipt-style simplicity, no actions
- **BIP 177 spec:** Redefine Bitcoin's base unit — `₿` symbol with integer amounts
- **Existing formatter:** `src/utils/format-btc.ts` — already BIP 177 compliant
- **Learnings:** Use `||` over `??` for WASM binding values that may be empty strings (`docs/solutions/ui-bugs/empty-to-field-lightning-review-screen.md`)
