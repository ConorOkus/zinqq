---
title: "feat: Add on-chain receive page with QR code and balance display"
type: feat
status: completed
date: 2026-03-14
origin: docs/brainstorms/2026-03-14-onchain-receive-brainstorm.md
---

# feat: Add on-chain receive page with QR code and balance display

## Overview

Add a dedicated `/receive` page that displays the wallet's current unused Bitcoin address as a QR code with copy-to-clipboard, and show the on-chain balance on the Home page. This enables the user to receive on-chain funds in preparation for opening outbound Lightning channels.

All backend pieces exist — `generateAddress()` and `OnchainBalance` are already wired up in `OnchainProvider`. This is purely a UI feature.

## Problem Statement / Motivation

The wallet can generate addresses and track on-chain balance, but there is no UI for either. Users cannot receive on-chain bitcoin, which blocks the channel funding flow. (See brainstorm: `docs/brainstorms/2026-03-14-onchain-receive-brainstorm.md`)

## Proposed Solution

1. **New `/receive` route** — a dedicated page with QR code, address text, copy button, and balance display
2. **Home page balance card** — show confirmed + pending sats with a "Receive" navigation button
3. **QR library** — add `qrcode.react` for SVG-based QR rendering
4. **Follow existing patterns** — discriminated union status handling, Tailwind styling, three-file context pattern

## Technical Considerations

### Balance Display

`OnchainBalance` has three fields: `confirmed`, `trustedPending`, `untrustedPending` (all `bigint` sats).

- **Primary display:** `confirmed` sats as the main balance
- **Pending line:** Show `trustedPending + untrustedPending` as a secondary "pending" amount, only when non-zero
- Rationale: On Signet, showing all pending gives useful mempool feedback. No risk of misleading users about real funds.

### QR Code Format

Use uppercase BIP21 URI in the QR data: `BITCOIN:TB1P...` (uppercase scheme + address). This triggers QR alphanumeric encoding mode, producing a smaller/simpler QR code that scans more reliably. Display the lowercase address in the text below the QR.

### Address Lifecycle

Call `generateAddress()` once on component mount via `useState` initializer. BDK's `next_unused_address('external')` returns the same address until it receives funds — no custom caching needed. The address is stable for the page visit lifetime.

### Copy-to-Clipboard

Use `navigator.clipboard.writeText()`. Show "Copied!" feedback for 2 seconds on success. On failure, fall back to displaying the full address text (which is already selectable).

### Loading/Error States

Follow the existing `Home.tsx` pattern with `useLdk()` — the Receive page will check `onchain.status`:
- `loading` → centered spinner
- `error` → error message with link back to Home
- `ready` → full receive UI

### Navigation

Add "Receive" link to the nav bar in `Layout.tsx` alongside Home and Settings. The Home page also gets a "Receive" button in the new balance card. No dedicated back button needed — existing nav is sufficient.

## Acceptance Criteria

- [x] On-chain balance (confirmed + pending) displays on Home page via `useOnchain()`
- [x] Home page has a "Receive" button/link that navigates to `/receive`
- [x] `/receive` route registered in router and "Receive" link added to nav bar
- [x] Receive page displays QR code encoding uppercase `BITCOIN:<address>` URI
- [x] Receive page displays full address text in monospace with `break-all` wrapping
- [x] Copy button copies address to clipboard with "Copied!" feedback
- [x] Receive page shows on-chain balance (confirmed + pending when non-zero)
- [x] Loading and error states handled on Receive page (spinner / error message)
- [x] QR code has appropriate `aria-label` for accessibility
- [x] Unit tests for Receive component covering ready, loading, and error states
- [x] Unit tests for Home page balance display

## Implementation

### 1. Install QR code library

```bash
pnpm add qrcode.react
```

### 2. Create `src/pages/Receive.tsx`

```tsx
// src/pages/Receive.tsx
// - useOnchain() hook, check status discriminated union
// - useState initializer calls generateAddress() once on mount
// - QRCodeSVG from qrcode.react with BITCOIN:<ADDRESS> (uppercased) value
// - aria-label on QR SVG wrapper: "QR code for Bitcoin address <address>"
// - Full address text in <p className="font-mono text-sm break-all">
// - Copy button with useState for "Copied!" feedback (2s timeout via useEffect cleanup)
// - Balance display: confirmed sats, plus pending line when > 0n
// - Loading state: centered spinner
// - Error state: error message + Link to Home
```

### 3. Create `src/pages/Receive.test.tsx`

```tsx
// src/pages/Receive.test.tsx
// - Mirror Home.test.tsx pattern with OnchainContext wrapper
// - Test ready state: QR code renders, address text displayed, copy button present, balance shown
// - Test loading state: spinner rendered
// - Test error state: error message rendered
// - Test copy button: mock navigator.clipboard.writeText, verify "Copied!" feedback
```

### 4. Update `src/routes/router.tsx`

```tsx
// Add: import { Receive } from '../pages/Receive'
// Add child route: { path: 'receive', element: <Receive /> }
```

### 5. Update `src/components/Layout.tsx`

```tsx
// Add "Receive" Link to nav bar alongside Home and Settings
```

### 6. Update `src/pages/Home.tsx`

```tsx
// - Add useOnchain() hook alongside existing useLdk()
// - When onchain.status === 'ready': show balance card with confirmed sats
//   and pending line (trustedPending + untrustedPending) when > 0n
// - Include Link to /receive ("Receive" button) in the balance card
// - When onchain.status === 'loading': show "Loading wallet..." text
// - When onchain.status === 'error': show error text
```

### 7. Update `src/pages/Home.test.tsx`

```tsx
// - Add OnchainContext wrapper to existing tests
// - Add tests for balance display with various OnchainBalance states
// - Test zero balance, confirmed only, confirmed + pending
```

## Dependencies & Risks

- **New dependency:** `qrcode.react` — well-maintained, 2M+ weekly downloads, React 19 compatible, SVG output (no canvas needed)
- **Risk: None significant** — all backend work exists, this is pure UI with established patterns
- **Network:** Mutinynet Signet only; no real funds at risk

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-14-onchain-receive-brainstorm.md](docs/brainstorms/2026-03-14-onchain-receive-brainstorm.md) — key decisions: dedicated /receive route, QR + copy, same unused address, balance on Home, receive-only scope
- **Existing patterns:** `src/pages/Home.tsx` (context consumption), `src/onchain/onchain-context.ts` (discriminated union), `src/components/Layout.tsx` (nav)
- **Institutional learnings:** `docs/solutions/integration-issues/bdk-wasm-onchain-wallet-integration-patterns.md` — React context patterns, provider nesting order
- **BIP21 URI:** Uppercase scheme for QR alphanumeric mode efficiency
