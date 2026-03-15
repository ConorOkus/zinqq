---
title: "feat: Implement design prototype UI in React"
type: feat
status: completed
date: 2026-03-15
origin: docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md
---

# feat: Implement design prototype UI in React

## Overview

Port the Payy-inspired design prototype (`design/`) into the production React/TypeScript/Tailwind v4 codebase. This transforms the wallet from a developer-style dashboard into a mobile-first payments app with bold typography, mixed accent/dark color scheme, custom numpad send flow, and bottom tab navigation.

**Screens in scope**: Home, Send (address + numpad + review + success), Receive (overlay-styled route), Activity (mock data), Settings, Advanced Settings, Peers.

## Problem Statement / Motivation

The current UI uses raw Tailwind utility classes with a default blue-600/gray aesthetic and top nav links. It looks like a developer prototype, not a payments app. The design prototype (merged in PR #12) establishes the visual identity -- this plan ports those patterns into the live React app.

(see brainstorm: [docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md](../brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md))

## Proposed Solution

### Navigation Architecture

```
Bottom Tab Bar: [ Scan | Wallet | Activity | Settings ]

Wallet tab (/):
  Home screen (accent bg, unified balance, SEND + REQUEST CTAs)
  └── SEND → /send → /send/amount → /send/review → /send/success
  └── REQUEST → /receive (full-screen overlay-styled route)

Activity tab (/activity):
  Transaction list (mock data, accent bg)

Settings (/settings → /settings/advanced → /settings/advanced/peers):
  Sub-flow screens (dark bg, back arrow header, tab bar hidden)
```

### File Structure (New/Modified)

```
src/
  index.css                          # MODIFY: Add design tokens to @theme
  components/
    Layout.tsx                       # REWRITE: Bottom tab bar, route-aware hiding
    Numpad.tsx                       # NEW: Reusable custom numpad component
    BalanceDisplay.tsx               # NEW: BIP 177 balance with hide/show toggle
    ScreenHeader.tsx                 # NEW: Back arrow + title header for sub-flows
    TabBar.tsx                       # NEW: Bottom tab bar component
  pages/
    Home.tsx                         # REWRITE: Accent bg, unified balance, CTAs
    Send.tsx                         # REWRITE: Multi-step with address input + numpad
    Receive.tsx                      # REWRITE: Full-screen dark overlay styling
    Activity.tsx                     # NEW: Mock transaction list
    Settings.tsx                     # REWRITE: Settings list with icons
    Advanced.tsx                     # NEW: Advanced settings list
    Peers.tsx                        # NEW: Peer list + connect form
  utils/
    format-btc.ts                    # NEW: BIP 177 formatter (₿ + comma-separated sats)
    format-btc.test.ts               # NEW: Formatter tests
  routes/
    router.tsx                       # MODIFY: Add Activity, Advanced, Peers routes
```

### Send Flow (Resolved Gap)

The prototype has no address input. Adding a dedicated address screen:

```
SEND button → /send (address entry) → /send/amount (numpad) → /send/review → /send/success
```

- **Address screen**: Dark bg, text input for address, paste support with BIP21 parsing, NEXT button
- **Amount screen**: Custom numpad, BIP 177 display, "available" balance shown
- **Review screen**: To/Amount/Fee/Total breakdown, Confirm Send button
- **Success screen**: Checkmark, amount, explorer link, Done button

### Receive (Route Styled as Overlay)

Keep `/receive` as a proper route (preserves direct URL access, test structure). Render with full-screen dark overlay styling matching the prototype. X button navigates back to `/`.

## Technical Considerations

### Design Token Migration

Port prototype's CSS custom properties into Tailwind v4's `@theme` directive in `src/index.css`:

```css
@import 'tailwindcss';

@font-face {
  font-family: 'Space Grotesk';
  /* self-hosted font files */
}

@theme {
  --font-sans: 'Inter', system-ui, sans-serif;
  --font-display: 'Space Grotesk', system-ui, sans-serif;

  --color-accent: #7C3AED;
  --color-dark: #0a0a0a;
  --color-dark-surface: #141414;
  --color-dark-elevated: #1a1a1a;
  --color-dark-border: #2a2a2a;
  --color-on-accent: #0a0a0a;
  --color-on-accent-muted: rgba(0, 0, 0, 0.5);
  --color-on-dark: #ffffff;
  --color-on-dark-muted: rgba(255, 255, 255, 0.45);

  --spacing-tab-bar: 64px;
  --spacing-header: 56px;
}
```

### Typography

- **Self-host Space Grotesk** (avoid Google Fonts CDN for privacy -- this is a Bitcoin wallet)
- Hero balance: `clamp(2.5rem, 12vw, 5rem)`, display font, weight 700
- Numpad keys: `1.5rem`, display font, weight 600
- Body: Inter (already loaded)

### BIP 177 Amount Formatting

New utility: `src/utils/format-btc.ts`

```typescript
export function formatBtc(satoshis: bigint | number): string {
  return '\u20BF' + BigInt(satoshis).toLocaleString('en-US')
}
```

- Replaces all `"X sats"` display patterns
- Handles BigInt inputs (production wallet layer uses `bigint`)
- No decimals, no "sats" terminology
- Zero displays as "₿0"

### Tab Bar Visibility

The prototype uses CSS `:has()` to hide the tab bar on sub-flows. In React, use route matching:

```typescript
// In Layout.tsx
const location = useLocation()
const isSubFlow = ['/send', '/receive', '/settings', '/settings/advanced', '/settings/advanced/peers']
  .some(path => location.pathname.startsWith(path) && location.pathname !== '/')
```

Sub-flow routes (Send steps, Settings, Advanced, Peers) hide the tab bar. Home and Activity show it.

### Balance Composition

- **Hero balance**: `confirmed + trustedPending` (unified number)
- **Pending indicator**: If `untrustedPending > 0`, show small secondary text below balance
- **Hide/show toggle**: Persisted in `localStorage`, eye icon button
- Lightning balance included when LDK context is ready

### Activity Tab (Mock Data)

Ship with hardcoded mock transactions matching the prototype's 7 entries. Clear `// TODO: integrate with BDK transaction history` comment. Empty state: "No transactions yet" centered text.

### Existing Test Impact

All 3 test files (`Home.test.tsx`, `Send.test.tsx`, `Receive.test.tsx`) will break due to:
- Changed heading text ("Browser Wallet" → removed, "Send Bitcoin" → "Send")
- Changed amount format ("100000 sats" → "₿100,000")
- Changed UI structure (form inputs → numpad, top nav → bottom tab bar)
- New components to mock (BalanceDisplay, Numpad)

Tests updated per-phase as components are rewritten.

### Accessibility

- Semantic HTML: `<nav>`, `<main>`, `<button>`, `<h1>`
- `aria-label` on icon-only buttons (back, close, copy, balance toggle, scan)
- Numpad: each key gets `aria-label`, amount display uses `aria-live="polite"`
- Empty numpad spacer: `aria-hidden="true"`, not a `<button>`
- Receive overlay: focus trap, return focus to REQUEST button on dismiss
- `focus-visible` styles on all interactive elements
- WCAG AA contrast ratios verified for text on accent background

### Mobile-First Constraints

- Primary viewport: 375px (iPhone SE)
- Max-width: 430px, centered with dark side gutters
- All interactive elements: minimum 44x44px touch targets
- Tab bar: fixed bottom, 64px height
- Safe area insets via `env(safe-area-inset-bottom)`

## Acceptance Criteria

### Foundation
- [x]Design tokens ported to `@theme` in `src/index.css`
- [x]Space Grotesk self-hosted (no Google Fonts CDN)
- [x]`formatBtc()` utility with tests, handles `bigint`, zero, and large values
- [x]App shell: 430px max-width, dark side gutters, mobile-first viewport

### Layout & Navigation
- [x]Bottom tab bar with 4 slots: Scan (placeholder), Wallet (active), Activity, Settings
- [x]Tab bar hidden on sub-flow routes (Send, Receive, Settings, Advanced, Peers)
- [x]Active tab indicator (dark pill on accent background)
- [x]Scan icon shows "Coming soon" feedback on tap
- [x]Back arrow header on all sub-flow screens

### Home Screen
- [x]Accent (violet) background
- [x]Unified balance in BIP 177 format (₿ + comma-separated, display font, hero size)
- [x]Balance hide/show toggle with eye icon, persisted in localStorage
- [x]SEND and REQUEST CTA buttons (large, side-by-side)
- [x]Loading state while wallet initializes
- [x]Error state for wallet failures
- [x]Pending balance secondary indicator when untrusted pending > 0

### Send Flow
- [x]Address screen: text input, BIP21 paste support, NEXT button
- [x]Amount screen: custom numpad (1-9, 0, backspace), BIP 177 live display
- [x]Amount screen: "available" balance shown, NEXT disabled when amount is 0
- [x]Review screen: To (truncated), Amount, Fee, Total breakdown
- [x]Review screen: Confirm Send triggers broadcast
- [x]Broadcasting state: spinner + "Sending..." text
- [x]Success screen: checkmark, amount, explorer link, Done → Home
- [x]Error screen: error message, "Your funds are safe", Try Again
- [x]Back navigation between all steps
- [x]Send Max support (tap "available" text or dedicated button)
- [x]Dust limit validation (294 sats minimum)

### Receive
- [x]Full-screen dark overlay styling (route at `/receive`)
- [x]QR code (existing `qrcode.react` library)
- [x]Truncated address with Copy button
- [x]X dismiss button → navigate to Home
- [x]Focus trap within overlay

### Activity
- [x]Accent background, "Activity" heading
- [x]Mock transaction list (7 entries matching prototype)
- [x]Each row: direction icon, label, amount (BIP 177), relative time
- [x]Sent amounts prefixed with `-`, received with `+`
- [x]Empty state: "No transactions yet"
- [x]TODO comment for BDK integration

### Settings & Advanced
- [x]Settings list: Wallet Backup, Recover Wallet, Advanced, How It Works, Get Help
- [x]Each item: icon, label, detail text
- [x]Non-functional items show "Coming soon" or no-op
- [x]Advanced: Open Channel (placeholder), Close Channel (placeholder), Peers (functional)
- [x]Peers screen: connected peer list, peer address input, connect button

### Tests
- [x]`format-btc.test.ts`: BigInt inputs, zero, large numbers, comma formatting
- [x]`Home.test.tsx`: updated for new UI (balance format, CTAs, no peer UI)
- [x]`Send.test.tsx`: updated for numpad interaction, address screen, multi-step flow
- [x]`Receive.test.tsx`: updated for overlay styling, truncated address
- [x]New test files for Activity, Settings as needed

## Implementation Phases

### Phase 1: Foundation (design tokens, utils, app shell)

**Files**: `src/index.css`, `src/utils/format-btc.ts`, `src/utils/format-btc.test.ts`, `public/fonts/`

- Port CSS custom properties from `design/styles.css` into `@theme`
- Self-host Space Grotesk font files
- Create `formatBtc()` utility with BigInt-safe formatting
- Set up app shell (430px max-width container, dark body background)
- No visual changes to existing pages yet

### Phase 2: Layout & Tab Bar

**Files**: `src/components/Layout.tsx`, `src/components/TabBar.tsx`, `src/components/ScreenHeader.tsx`, `src/routes/router.tsx`

- Rewrite Layout.tsx: remove top nav, add bottom tab bar
- Create TabBar component with route-aware active state and visibility
- Create ScreenHeader component (back arrow + title)
- Add routes: `/activity`, `/settings/advanced`, `/settings/advanced/peers`
- Tab bar hidden on sub-flow routes

### Phase 3: Home Screen

**Files**: `src/pages/Home.tsx`, `src/components/BalanceDisplay.tsx`, `src/pages/Home.test.tsx`

- Rewrite Home with accent background, unified balance, hide/show toggle
- Create BalanceDisplay component (BIP 177, eye icon toggle, localStorage)
- SEND and REQUEST CTA buttons
- Remove peer connection UI (moves to Peers page in Phase 7)
- Loading and error states
- Update tests

### Phase 4: Send Flow

**Files**: `src/pages/Send.tsx`, `src/components/Numpad.tsx`, `src/pages/Send.test.tsx`

- Add address input screen as first step
- Create Numpad component (3x4 grid, key handlers, backspace)
- Amount display with live BIP 177 formatting
- Review screen with fee breakdown
- Broadcasting spinner, success screen, error screen
- Back navigation, dust validation, send max
- Update tests for numpad interaction

### Phase 5: Receive

**Files**: `src/pages/Receive.tsx`, `src/pages/Receive.test.tsx`

- Restyle as full-screen dark overlay (still a route)
- QR code centered, white bg, rounded corners
- Truncated address with copy button
- X dismiss button, focus trap
- Update tests

### Phase 6: Activity

**Files**: `src/pages/Activity.tsx`

- Accent background, Activity heading
- Mock transaction list (7 hardcoded entries)
- Direction icons, BIP 177 amounts, relative timestamps
- Empty state text
- TODO comment for BDK integration

### Phase 7: Settings, Advanced & Peers

**Files**: `src/pages/Settings.tsx`, `src/pages/Advanced.tsx`, `src/pages/Peers.tsx`

- Settings list with SVG icons
- Advanced settings list
- Peers page: connected peers list + connect form (migrated from current Home.tsx)
- Non-functional items show "Coming soon"

## Dependencies & Risks

| Risk | Mitigation |
|------|-----------|
| Space Grotesk self-hosting adds build complexity | Download woff2 files, add to `public/fonts/`, use `@font-face` in CSS |
| Send flow is a fundamental rewrite (form → numpad) | Phase 4 is the largest phase — can be split into sub-PRs if needed |
| All existing tests break | Update tests per-phase, not all at once |
| Activity has no real data source | Ship with mock data, documented TODO |
| Numpad digit limit (8) prevents sending >= 1 BTC | Acceptable for signet wallet; raise limit in follow-up if needed |
| `:has()` CSS selector not used in React | Route-based tab bar visibility via `useLocation()` |
| Muted text on accent bg may fail WCAG AA contrast | Verify contrast ratios during implementation, adjust `--on-accent-muted` opacity if needed |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md](../brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md)
  - Key decisions carried forward: Payy-inspired aesthetic, unified balance hiding payment rails, mixed accent/dark color scheme, custom numpad, display font for headings, BIP 177 formatting

### Internal References

- Design prototype: `design/index.html`, `design/styles.css`, `design/app.js`
- Design prototype plan: `docs/plans/2026-03-15-001-feat-ui-ux-design-prototype-plan.md`
- Porting checklist: `docs/solutions/design-patterns/standalone-html-design-prototype-workflow.md`
- Current Home page: `src/pages/Home.tsx`
- Current Send flow: `src/pages/Send.tsx` (5-step state machine)
- Current Receive page: `src/pages/Receive.tsx` (QR + copy)
- BIP21 parser: `src/onchain/bip21.ts`
- On-chain config: `src/onchain/config.ts` (explorer URL)
- Layout shell: `src/components/Layout.tsx`
- Router: `src/routes/router.tsx`

### Design References

- Payy app (13 screenshots captured 2026-03-15)
- [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) (display font)
- [BIP 177](https://github.com/bitcoin/bips/blob/master/bip-0177.mediawiki) (₿ symbol usage)

### Related Work

- Design prototype PR: #12
- Bugfix batch PR: #11
