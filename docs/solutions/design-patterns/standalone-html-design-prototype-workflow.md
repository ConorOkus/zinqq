---
title: "Standalone HTML Design Prototype Workflow with BIP 177 Amount Formatting"
category: design-patterns
date: 2026-03-15
severity: p3
tags:
  - ui-ux
  - design-system
  - prototyping
  - bip177
  - mobile-first
  - payments-ux
  - hash-router
  - css-custom-properties
modules_affected:
  - design/index.html
  - design/styles.css
  - design/app.js
related_pr: https://github.com/ConorOkus/browser-wallet/pull/12
---

# Standalone HTML Design Prototype Workflow

## Problem

The wallet's React UI used raw Tailwind utility classes with no design system, no extracted components, and a generic blue/gray aesthetic — it looked like a developer prototype rather than a consumer payments app. There was no rapid-iteration workflow for exploring visual identity (color, typography, layout) without incurring build-tool overhead or switching to an external design tool like Figma. Additionally, amounts were displayed inconsistently with no adherence to BIP 177's standardized ₿-only format.

## Solution Overview

A standalone `design/` folder at the project root containing a single-page HTML prototype with vanilla CSS and JS. All screens are `<section>` elements toggled by a hash router — no build step, no server, just open `index.html` in a browser at 375px width and iterate. Design inspired by Payy's payments-app aesthetic with a mixed color scheme (bold accent home, dark sub-flows).

## Key Patterns

### 1. File Structure

```
design/
  index.html   -- All screens as <section> elements; single HTML document
  styles.css   -- Design tokens + all screen styles
  app.js       -- Hash router, numpad state, balance toggle
```

Zero build tools. Each `<section id="...">` maps 1:1 to a future React component. The folder is invisible to the Vite build pipeline since `vite.config.ts` only references `src/` and `public/`.

### 2. Hash Router

Every screen is a `<section class="screen">` present in the DOM. Only one has `.active` (sets `display: flex`; others are `display: none`). Navigation is driven by `window.location.hash`.

```js
const routes = ['home', 'send', 'send-review', 'send-success', 'activity',
                'settings', 'advanced', 'open-channel', 'close-channel', 'peers']
const overlays = ['receive']

function navigate(hash) {
  window.location.hash = hash
}

function updateScreen() {
  const route = window.location.hash.slice(1) || 'home'

  // Overlays float above the current screen
  overlays.forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('active', route === id)
  })
  if (overlays.includes(route)) return

  // Toggle screens
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.toggle('active', screen.id === route)
  })
}

window.addEventListener('hashchange', updateScreen)
```

Browser back/forward works for free via the hash history stack. Sub-flow screens auto-hide the tab bar via `:has()`: `.app:has(.screen--sub-flow.active) .tab-bar { display: none; }`.

### 3. CSS Design Tokens (One-Line Theme Swap)

All design decisions captured as CSS custom properties. Change one line to re-theme the entire prototype:

```css
:root {
  /* Swap this one line to change the entire vibe */
  --accent: #7C3AED;          /* violet */
  /* --accent: #2563EB; */    /* electric blue */
  /* --accent: #06B6D4; */    /* cyan */
  /* --accent: #E11D48; */    /* rose */

  --on-accent: #0a0a0a;
  --on-accent-muted: rgba(0, 0, 0, 0.5);
  --dark: #0a0a0a;
  --on-dark: #ffffff;
  --on-dark-muted: rgba(255, 255, 255, 0.45);

  --font-display: 'Space Grotesk', 'Satoshi', system-ui, sans-serif;
  --font-body: 'Inter', system-ui, sans-serif;
  --text-hero: 5rem;
  /* ... full scale from --text-xs (12px) to --text-hero (80px) */
}
```

Two screen modes reference these tokens:
- `.screen--accent` — bold accent background for Home/Activity
- `.screen--dark` — near-black background for Send/Settings sub-flows

### 4. BIP 177 ₿-Only Amount Format

All amounts stored as integers (satoshis), displayed with ₿ prefix and comma grouping. No decimals, no "sats" terminology.

```js
function formatBtc(satoshis) {
  return '₿' + Number(satoshis).toLocaleString('en-US')
}
```

| Input (sats) | Display |
|---|---|
| 100000000 | ₿100,000,000 |
| 50000 | ₿50,000 |
| 245 | ₿245 |

Rules from [bitcoin.design BIP 177 guide](https://bitcoin.design/guide/designing-products/units-and-symbols/#-only-format):
- Integer representation only (base units)
- ₿ symbol prefix (or postfix per locale)
- Comma-separated digit grouping for readability
- No decimals, no "sats", no "satoshis", no "BTC"

### 5. Custom Numpad

State is a single string variable — no parsing until display time:

```js
let sendAmount = ''
const MAX_DIGITS = 8

function onNumpadKey(key) {
  if (key === 'backspace') {
    sendAmount = sendAmount.slice(0, -1)
  } else {
    if (sendAmount.length >= MAX_DIGITS) return
    if (sendAmount === '0' && key === '0') return
    if (sendAmount === '0') sendAmount = key
    else sendAmount += key
  }
  updateAmountDisplay()
}
```

HTML is a CSS Grid of 12 buttons with `data-key` attributes. Bottom-left is empty, bottom-right is backspace. No dot key — BIP 177 integers only.

## Pitfalls to Avoid When Porting

| Prototype Pattern | Production Fix |
|---|---|
| `innerHTML` for icon swap (XSS risk) | Use React SVG components |
| No `.catch()` on clipboard API | Always handle clipboard permission denial |
| Hardcoded balance/fee values | Wire to wallet service state |
| Module-level mutable `sendAmount` | React `useState` or `useReducer` |
| `:has()` selector for tab bar hiding | Conditionally render based on route in React |
| `parseFloat` for BTC-to-sats conversion | Use fixed-point string parsing (see `btcStringToSats` in `src/onchain/bip21.ts`) |

## Key Decision: CSS Strategy Before Porting

The prototype uses custom BEM classes with CSS custom properties. The production app uses Tailwind. Before porting, decide:

1. **Extend Tailwind theme** with prototype's tokens — lower friction, keeps Tailwind ecosystem
2. **CSS Modules with tokens** — direct lift of prototype CSS, more files
3. Extract the `:root` token block into a standalone `tokens.css` either way

## Related Documentation

- **Brainstorm:** `docs/brainstorms/2026-03-15-ui-ux-design-system-brainstorm.md`
- **Plan:** `docs/plans/2026-03-15-001-feat-ui-ux-design-prototype-plan.md`
- **PR:** [#12 — feat: add mobile-first UI/UX design prototype](https://github.com/ConorOkus/browser-wallet/pull/12)
- **BIP21 fixed-point parsing:** `docs/solutions/integration-issues/bdk-wasm-onchain-send-patterns.md` (Section 7)
- **Production send flow:** `docs/plans/2026-03-14-002-feat-onchain-send-page-plan.md`
- **Production receive flow:** `docs/plans/2026-03-14-001-feat-onchain-receive-page-plan.md`
- **Agent parity gap:** `todos/072-pending-p3-extract-onchain-service-for-agent-parity.md`

## Production formatBtc

When porting, accept `bigint` since the wallet layer uses it:

```typescript
function formatBtc(satoshis: bigint | number): string {
  return '\u20BF' + BigInt(satoshis).toLocaleString('en-US')
}
```

`BigInt.prototype.toLocaleString` is supported in all modern browsers and Node 10.4+.
