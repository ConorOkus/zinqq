# Brainstorm: Payment Detail Screen

**Date:** 2026-04-08
**Status:** Complete

## What We're Building

A read-only payment detail screen that users navigate to by tapping a payment in the Activity list. The screen uses an "Amount-Hero" layout: the amount and direction are displayed prominently at the top, followed by key-value detail rows below a divider.

This applies to both sent and received payments, on-chain and Lightning, using the same layout for all.

## Why This Approach

- **Amount-Hero layout** chosen over flat key-value (Strike-style) and card-based layouts. It gives the most important info (how much, which direction) maximum visual weight while keeping detail rows clean and scannable.
- **Receipt-style simplicity** — no technical details (payment hash, txid, fee breakdown). Just the essentials: date, time, status, amount, type (lightning/on-chain).
- **BIP 177 formatting** — use the `₿` symbol with integer amounts (e.g. `₿52,500`) instead of "sats". Aligns with the base-unit-as-bitcoin philosophy. Applied with `₿` symbol style, not full "bitcoins" prose.
- **No description/title** for now — invoice memos and on-chain labels are omitted. Can be added later.
- **Info only** — no action buttons (copy, share, chat). Purely informational.
- **Same layout for sent and received** — only the amount sign and direction indicator change.

## Key Decisions

1. **Layout:** Amount-Hero — large amount + direction indicator at top, divider, then detail rows
2. **Detail rows:** Date, Time, Status, Type (lightning/on-chain)
3. **Amount format:** BIP 177 style — `₿` symbol with integer amounts (₿52,500), no fiat, no "sats" — applied **app-wide**
4. **No description field** — omitted for now
5. **No actions** — read-only, no copy/share buttons
6. **Unified for all payment types** — same screen for sent/received, lightning/on-chain
7. **Route:** `/activity/:id` following existing react-router patterns
8. **Navigation:** Tap activity list item → navigate to detail screen; use `ScreenHeader` with back arrow

## Design Mockup

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

## Additional Scope

- **BIP 177 app-wide migration:** As part of this work, update all amount displays throughout the app (balance, activity list, send/receive flows) to use `₿` symbol with integer formatting. This replaces all "sats" references.

## Open Questions

None — all questions resolved during brainstorm.
