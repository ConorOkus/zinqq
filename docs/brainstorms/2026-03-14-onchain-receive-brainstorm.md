# Brainstorm: On-Chain Receive

**Date:** 2026-03-14
**Status:** Draft

## What We're Building

A dedicated Receive page (`/receive`) that lets the user receive on-chain bitcoin so they can later fund outbound Lightning channels. The page displays the wallet's current unused address as a QR code and copyable text, along with the on-chain balance (confirmed + pending). The Home page also gets an on-chain balance display with a "Receive" navigation button.

### User Flow

1. User navigates to Home and sees their on-chain balance (confirmed + pending sats)
2. User taps "Receive" button, navigating to `/receive`
3. Receive page shows:
   - QR code encoding a `bitcoin:<address>` URI
   - Address text with copy-to-clipboard button
   - Current on-chain balance (confirmed + pending)
4. User shares/scans the address externally to receive funds
5. Balance updates automatically via the existing 30-second sync loop
6. User navigates back to Home and sees updated balance

## Why This Approach

- **Separate page over modal:** Simpler component, no overlay state management, deep-linkable, consistent with existing routing pattern (Home, Settings)
- **Same unused address until funded:** BDK's `next_unused_address()` already returns the same address until it receives funds — no custom logic needed
- **QR code + copy:** Standard wallet UX; QR for mobile scanning, copy for desktop/CLI sends
- **Balance on Home:** Lets user monitor incoming funds without navigating away; signals when they're ready to open a channel

## Key Decisions

1. **Dedicated `/receive` route** — not a modal or drawer
2. **QR code library** — use a lightweight JS QR generator (e.g., `qrcode` npm package)
3. **Address reuse** — leverage BDK's `next_unused_address()` which returns the same address until it's seen on-chain
4. **Balance display on Home** — show confirmed + pending on-chain sats alongside existing LDK node status
5. **Scope** — receive only; channel opening is a separate future feature
6. **No amount request** — just a bare address for now (no BIP21 amount parameter)

## What Already Exists

- `generateAddress()` in `OnchainProvider` — calls `wallet.next_unused_address('external')`, fully implemented but no UI consumes it
- `OnchainBalance` (confirmed, trustedPending, untrustedPending) tracked in sync loop and available via `useOnchain()` hook
- `OnchainProvider` with `status: 'ready'` discriminated union exposing wallet, balance, and generateAddress
- 30-second sync loop that auto-updates balance
- React Router with existing Home and Settings routes

## Open Questions

None — scope is well-defined and backend is already in place.
