# UI/UX Design System & Prototyping Workflow

**Date:** 2026-03-15
**Status:** Draft

## What We're Building

A mobile-first, payments-app UI for the browser wallet, inspired by **Payy's** design language. The goal is to make the wallet feel like a modern payments app (Cash App, Venmo, Payy) rather than a technical node dashboard.

Alongside the redesign, we're establishing an **in-browser prototyping workflow** using a `design/` folder with static HTML/CSS/JS — no build tools, no Figma, just open-in-browser-and-iterate.

### Core Screens (First Pass)

1. **Home** — Unified balance (on-chain + Lightning combined), SEND and RECEIVE action buttons. Bold accent-color background. Activity lives on a separate tab.
2. **Send** — Amount entry with custom numpad, review step, broadcasting/success states
3. **Receive** — QR code display in dark modal overlay, address copy

## Why This Approach

### Design Direction: Payy-Inspired with Unique Identity

We're adopting Payy's structural patterns:
- **Bold, oversized typography** for balance and amounts
- **Minimal chrome** — no card shadows, no heavy borders, generous whitespace
- **Bottom tab navigation** (Wallet / Activity)
- **Large rectangular CTAs** for primary actions (Send / Receive)
- **Custom numpad** for amount entry (not native keyboard)
- **Progressive disclosure** for multi-step flows
- **Full-screen dark QR modal** for receive
- **Hidden balance** with show/hide toggle for privacy

But with a **distinctive, non-Bitcoin-orange accent color** — something bold that carves out its own identity rather than defaulting to #F7931A or generic dark-mode neutral. The specific color will be explored during prototyping.

### Unified Balance, Hidden Rails

Users see a single balance and single send/receive flow. The wallet automatically selects the best payment rail (on-chain vs Lightning) without exposing the distinction. This is a payments app, not a node manager.

### Prototyping Workflow: Single-Page Hash Router

**Structure:**
```
design/
  index.html     -- All screens as <section> elements, hash-router navigation
  styles.css     -- Shared styles, design tokens (colors, typography, spacing)
  app.js         -- Minimal vanilla JS: hash routing, screen transitions, numpad logic
  assets/        -- Icons, images if needed
```

**Why this approach:**
- Feels like a real app when demoing (no page reloads)
- Shared styles stay DRY across all screens
- Zero build tools — open `index.html` in a browser and start iterating
- Easy to screenshot or screen-record for feedback
- Designs can later inform React component extraction

**Workflow:**
1. Open `design/index.html` in browser
2. Edit HTML/CSS, refresh to see changes
3. Use browser DevTools responsive mode (375px width) for mobile-first
4. When a screen feels right, port the patterns into React components

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Design inspiration | Payy | Bold, modern payments-app feel — not a crypto dashboard |
| Color identity | Bold & unique (TBD) | Stand apart from generic Bitcoin orange branding |
| Mobile-first | Yes | Primary use case is mobile browser / PWA |
| Balance display | Unified (on-chain + Lightning) | Payments UX — users shouldn't think about rails |
| Prototype format | Single-page HTML with hash router | App-like feel, no build tools, fast iteration |
| First screens | Home, Send, Receive | Core payment loop — the 80% use case |
| Prototyping tool | Browser + text editor | Design-in-browser philosophy, no external tools |
| Color base | Mixed (like Payy) | Bold accent on home, dark for sub-flows — creates visual layers |
| Activity feed | Separate tab | Home stays clean: balance + actions only. Activity gets its own tab. |
| Typography | Display font for headings | Explore Space Grotesk, Clash Display, or Satoshi for amounts/headings. Inter for body. |

## Open Questions

1. **Accent color** — What specific bold color to use? Explore during prototyping (electric blue? deep purple? coral?). Consider contrast on both dark and light backgrounds.

## Reference Screenshots

Source: Payy app (13 screenshots captured 2026-03-15)

Key screens analyzed:
- Home/wallet view (neon yellow-green, hidden balance, VISA card, SEND/REQUEST buttons)
- Send flow (dark, custom numpad, large centered amount)
- Request flow (light bg, circle amount display, VIA QR / VIA LINK options, numpad)
- Receive QR (dark full-screen modal)
- Deposit drill-down (category > specific option, icon + label + subtitle rows)
- Withdraw (simple list with time/fee info)
- Blockchain selector (large bold question heading, icon rows)
- Activity feed (scrolling transaction list with directional arrows, amounts, timestamps)
- Settings/More (icon + label + right-aligned detail text)
