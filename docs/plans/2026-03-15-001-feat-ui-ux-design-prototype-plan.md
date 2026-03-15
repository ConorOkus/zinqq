---
title: "feat: Create mobile-first UI/UX design prototypes"
type: feat
status: active
date: 2026-03-15
origin: docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md
---

# feat: Create mobile-first UI/UX design prototypes

## Overview

Build a `design/` folder containing a single-page HTML/CSS/JS prototype of the wallet's core payment flows (Home, Send, Receive). The prototype uses a Payy-inspired design language — bold typography, minimal chrome, payments-app UX — with a distinctive accent color and mixed color scheme. No build tools; open `index.html` in a browser and iterate.

This is a **standalone design exploration** with mock/hardcoded data. It will serve as a visual reference for porting patterns into the existing React codebase. It does not replace or integrate with the current `src/` code.

## Problem Statement / Motivation

The current wallet UI uses raw Tailwind utility classes with no design system, no extracted components, and a default blue-600/gray aesthetic. It looks like a developer prototype, not a payments app. The goal is to establish a visual identity and interaction patterns that make the wallet feel like Cash App or Payy — bold, confident, and simple — before investing effort in React component extraction.

(see brainstorm: [docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md](../brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md))

## Proposed Solution

### File Structure

```
design/
  index.html       -- All screens as <section> elements, hash-router navigation
  styles.css       -- Design tokens (colors, typography, spacing), screen styles
  app.js           -- Hash routing, screen transitions, numpad logic, balance toggle
  assets/          -- Icons (SVG), placeholder QR image
```

### Screens in Scope

| Screen | Hash Route | Color Mode | Description |
|--------|-----------|------------|-------------|
| **Home (Wallet tab)** | `#home` | Accent bg | Unified balance, hide/show toggle, SEND + RECEIVE CTAs |
| **Send: Amount** | `#send` | Dark bg | Custom numpad, large centered amount in sats, balance remaining |
| **Send: Review** | `#send-review` | Dark bg | Recipient address, amount, fee, confirm button |
| **Send: Success** | `#send-success` | Dark bg | Checkmark, amount sent, explorer link |
| **Receive** | `#receive` | Dark modal overlay | Full-screen QR code, copyable address, dismiss X button |
| **Activity tab** | `#activity` | Accent bg | Transaction list: direction arrow, label, amount, time ago |

### Screens Explicitly Out of Scope (v1)

- Onboarding (create/import wallet, mnemonic backup) — existing `wallet-gate.tsx` handles this
- Settings — currently a stub, will design later
- Send: Error state — keep simple, just show error text on review screen
- Send: Broadcasting state — simple spinner, no custom animation

### Navigation Model

```
Bottom Tab Bar: [ Wallet | Activity ]

Wallet tab (#home):
  └── SEND button → #send → #send-review → #send-success
  └── RECEIVE button → #receive (modal overlay on top of home)

Activity tab (#activity):
  └── Transaction list (tap does nothing in prototype)

Back navigation:
  └── ← arrow in header for sub-flows (send steps, etc.)
  └── Browser back also works via hash history
  └── Receive modal: X button dismisses, returns to #home
```

## Technical Considerations

### Typography

- **Display font** for headings and amounts: Try Space Grotesk, Clash Display, or Satoshi. Load from Google Fonts CDN. Final choice made visually during prototyping.
- **Body font**: Inter (already in use in production app). Load from Google Fonts CDN.
- **Balance amount**: ~72-96px, display font, extra bold
- **Page headings**: ~24-28px, display font, bold
- **Body/labels**: 14-16px, Inter, regular/medium

### Color System

**Mixed scheme** (see brainstorm: accent for home, dark for sub-flows):

| Token | Home/Activity screens | Send/Receive sub-flows |
|-------|----------------------|----------------------|
| Background | Bold accent color (TBD) | `#0a0a0a` (near-black) |
| Primary text | `#0a0a0a` (dark on accent) | `#ffffff` |
| Secondary text | `rgba(0,0,0,0.5)` | `rgba(255,255,255,0.5)` |
| CTA buttons | `#0a0a0a` fill, white text | White outline, white text |
| Tab bar | Dark (`#1a1a1a`) | Same dark |

**Accent color** is the one open question from the brainstorm. The prototype will start with 2-3 candidates (e.g., electric blue `#2563EB`, violet `#7C3AED`, coral `#F97316`) defined as CSS custom properties so they can be swapped in one line.

### Custom Numpad

- Grid: 3 columns × 4 rows (1-9, dot, 0, backspace)
- Keys: large touch targets (min 64×64px, ideally 72×72px)
- Display: centered amount in display font, scales down as digits increase
- Denomination: **sats** (integer only, no decimal). Dot key can be hidden or disabled for v1.
- Backspace: delete last digit. Long-press clears all (nice-to-have).

### Balance Display

- **Unified**: Single number combining on-chain + Lightning balances
- **Format**: Comma-separated sats (e.g., `1,234,567`)
- **Hide/show toggle**: Default shown. Tap eye icon to toggle. Hidden state shows `••••••`. Persisted in `localStorage`.
- Denomination is sats for v1. Fiat conversion is out of scope.

### Receive Screen

- Generates/displays an **on-chain address** (matching current implementation)
- QR code: use a placeholder/static QR image in the prototype
- Below QR: truncated address with "Copy" button
- Dismissal: X button top-right, browser back button via hash

### Activity Tab

- Scrolling list of mock transactions
- Each row: direction icon (↗ sent / ↙ received), label/address, amount in sats, relative time
- Sent amounts prefixed with `-`, received with `+`
- Empty state: "No transactions yet" centered text

### Mobile-First Constraints

- Primary viewport: **375px** width (iPhone SE / small Android)
- Max-width: **430px**, centered on larger screens with dark side gutters
- All interactive elements: minimum 44×44px touch targets
- Bottom tab bar: fixed position, ~60px height

### Accessibility Baselines

- WCAG AA contrast ratios (4.5:1 for text, 3:1 for large text)
- Semantic HTML (`<nav>`, `<main>`, `<button>`, `<h1>`)
- `aria-label` on icon-only buttons (back arrow, close X, copy, balance toggle)
- Focus-visible styles on all interactive elements
- QR code: adjacent copyable address text serves as screen reader alternative

## Acceptance Criteria

- [x] `design/index.html` opens in browser with no build step, no server required
- [x] Home screen displays unified balance with hide/show toggle on accent-color background
- [x] SEND and RECEIVE CTAs navigate to respective flows
- [x] Send flow: numpad → amount display → review screen → success screen, all navigable
- [x] Receive: full-screen dark QR modal with X dismiss
- [x] Activity tab: mock transaction list with direction, amount, timestamp
- [x] Bottom tab bar switches between Wallet and Activity
- [x] Back navigation works (← button and browser back)
- [x] All screens look correct at 375px viewport width
- [x] CSS custom properties for accent color — swappable in one line
- [x] At least 2 display font candidates loaded for visual comparison
- [x] Prototype uses mock/hardcoded data throughout (no real wallet integration)

## Implementation Phases

### Phase 1: Foundation (`design/styles.css` + `design/app.js` + shell)

- CSS reset and custom properties (colors, fonts, spacing)
- Google Fonts import (Inter + 2-3 display font candidates)
- Hash router in vanilla JS (show/hide sections based on `location.hash`)
- App shell: viewport meta, max-width container, bottom tab bar
- Files: `design/index.html`, `design/styles.css`, `design/app.js`

### Phase 2: Home Screen

- Balance display (large display font, comma-formatted sats)
- Hide/show toggle with eye icon
- SEND and RECEIVE CTA buttons (large, side-by-side)
- Accent-color background
- Bottom tab bar (Wallet active state)

### Phase 3: Send Flow

- Send: Amount screen with custom numpad
- Send: Review screen (mock address, amount, fee breakdown, confirm button)
- Send: Success screen (checkmark, amount, explorer link placeholder)
- Back navigation between steps
- Hash route progression: `#send` → `#send-review` → `#send-success`

### Phase 4: Receive Modal

- Full-screen dark overlay
- Placeholder QR code (centered, white bg, rounded corners)
- Truncated address with copy button
- X dismiss button
- Overlay on top of home (not a separate page)

### Phase 5: Activity Tab

- Tab switching (Wallet ↔ Activity)
- Mock transaction list (6-8 entries)
- Direction arrows, labels, amounts, timestamps
- Active tab indicator in bottom bar

## Dependencies & Risks

| Risk | Mitigation |
|------|-----------|
| Accent color indecision stalls work | Start with CSS custom properties + 3 candidates; swap and compare |
| Display font doesn't match Payy's boldness | Load 3 options, evaluate visually before committing |
| Prototype diverges from what's feasible in React | Keep HTML structure close to React component boundaries (each `<section>` = one component) |
| Scope creep into production code | This is explicitly a design artifact — `design/` folder is gitignored from Vite build |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md](../brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md)
  - Key decisions carried forward: Payy-inspired aesthetic, unified balance hiding payment rails, mixed color scheme (accent home / dark sub-flows), single-page HTML prototype with hash router, custom numpad, display font for headings

### Internal References

- Current Home page: `src/pages/Home.tsx`
- Current Send flow: `src/pages/Send.tsx` (5-step state machine pattern)
- Current Receive page: `src/pages/Receive.tsx` (QR + copy pattern)
- Layout shell: `src/components/Layout.tsx`
- Tailwind theme: `src/index.css` (`@theme` directive)
- Router structure: `src/routes/router.tsx`

### Design References

- Payy app screenshots (13 screens captured 2026-03-15, stored locally)
- Display font candidates: [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk), [Clash Display](https://www.fontshare.com/fonts/clash-display), [Satoshi](https://www.fontshare.com/fonts/satoshi)
