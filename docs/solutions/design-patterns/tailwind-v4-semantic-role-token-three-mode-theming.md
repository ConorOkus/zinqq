---
title: 'Three-Mode Theming via Re-Pointed Semantic Role Tokens in Tailwind v4'
problem_type: design_pattern
date: 2026-07-26
category: design-patterns
module: src/index.css
component: frontend_stimulus
severity: medium
applies_when:
  - 'Adding light/dark/hybrid theme modes to a Tailwind CSS v4 app without editing component class names'
  - 'Naming color tokens — prefer role names (field, cta, on-dark) over value names so modes can re-point them'
  - "A strict CSP (script-src 'self') forbids the classic inline <head> script for pre-paint theme application"
  - 'Alpha/rgba color values are needed but are not usable inside the Tailwind v4 @theme block'
  - 'Replacing hardcoded translucents (bg-black/15, hover:bg-white/10) that break under theme inversion'
related_components: [src/index.css, src/utils/theme.ts, src/main.tsx, vite.config.ts]
tags:
  [
    theming,
    tailwind-v4,
    semantic-tokens,
    css-custom-properties,
    dark-mode,
    csp,
    pwa-manifest,
    design-system,
  ]
---

# Three-Mode Theming via Re-Pointed Semantic Role Tokens in Tailwind v4

## Context

Until PR #184, Zinqq had exactly one look, and it was hardcoded: a purple accent (`#7c3aed`) flooding Home/Activity/TabBar via `bg-accent`, near-black "room" screens (Send/Receive/Settings), and raw values — `text-white`, `bg-black/15`, `red-400` — scattered through the screens. A design exploration on claude.ai/design ("Zinqq Color Schemes") landed on a bone (`#E4D7BE`) + ember (`#D9481F`) scheme with an unusual requirement: three appearance modes, not two. **Hybrid** (the default) floods the "field" screens (Home/Activity/tab bar) with bone while the rooms stay warm near-black; **dark** is near-black everywhere; **light** is warm paper everywhere. Tailwind's `dark:` variant is binary and per-element, so it cannot express a third mode, and a component rewrite was off the table. PR #184 (merged 2026-07-26) shipped the scheme by making CSS variables the theming seam: components reference _roles_, and each mode re-points what the roles mean.

An extra constraint shaped the bootstrap: the app is a Vite PWA whose CSP declares `script-src 'self' 'wasm-unsafe-eval'` (index.html:13), so the classic inline `<head>` script that sets the theme attribute before first paint is blocked.

## Guidance

**1. Declare semantic role tokens in `@theme`; give each mode a `:root[data-theme='…']` block that re-points them.**

`src/index.css` declares the roles in Tailwind v4's `@theme` block with the hybrid/base values — `--color-field`, `--color-on-field`, `--color-field-cta`, `--color-cta`/`--color-on-cta`, `--color-hot`, `--color-amount`, `--color-pill`, `--color-badge`, `--color-qr-tile`, and status tokens (src/index.css:74–125). Tailwind v4 generates utilities like `bg-field` that compile to `var(--color-field)`, so overriding the variable is enough to restyle every consumer. The mode blocks re-point values only:

```css
/* src/index.css:145–159 */
:root[data-theme='dark'] {
  --color-field: #12100c;
  --color-on-field: #f6f0e4;
  --color-field-cta: #d9481f;
  --color-cta: #d9481f;
  --color-on-cta: #ffffff;
  --color-amount: #d9481f;
  /* … */
}
```

The attribute selector `:root[data-theme='dark']` outranks the bare `:root` where Tailwind emits the `@theme` variables, so no `!important` or ordering tricks are needed. Components carry zero conditional theme logic — e.g. `src/components/TabBar.tsx:17` is just `bg-field`, `:22` is `text-on-field`, and `src/pages/Home.tsx:45` is `bg-field … text-on-field`; none of them know which mode is active.

**2. Name tokens by role, not value — even when the name looks like a value.**

The pre-existing `--color-dark*`/`--color-on-dark*` family (used by dozens of `bg-dark`/`text-on-dark` call sites in room screens) was kept and re-pointed. The comment in src/index.css:85–86 makes the contract explicit: _"In light mode these re-point to warm paper — 'dark' names the role, not the value."_ Light mode does exactly that (src/index.css:162–168: `--color-dark: #f6f1e5`, `--color-on-dark: #1a140a`), so every existing room screen inverted with no component edits.

**3. Keep alpha tokens outside `@theme`; express translucency as opacity modifiers on semantic tokens.**

rgba() values live in a plain `:root` block (src/index.css:136–142, comment: "rgba not supported in @theme") and are consumed via arbitrary-value classes like `text-[var(--color-on-field-muted)]` (src/components/TabBar.tsx:31). Separately, hardcoded translucents (`bg-black/15`, `hover:bg-white/10`) became opacity modifiers on role tokens — `bg-on-field/10` (src/pages/Home.tsx:68), `hover:bg-on-dark/10` (src/components/ScreenHeader.tsx:27) — which Tailwind compiles with `color-mix()`, so a 10% wash automatically flips from black-on-bone to cream-on-near-black per mode.

**4. Under a `script-src 'self'` CSP, apply the theme at the top of the entry module, not in an inline head script.**

`src/main.tsx:12` runs `applyTheme(getStoredTheme())` before `createRoot(...).render(...)`. Because `#root` is empty until React mounts, nothing themed has painted yet — no flash of the wrong mode, no CSP exception. `src/utils/theme.ts` owns the whole surface: the `'theme'` localStorage key wrapped in try/catch (theme.ts:15–23, 31–38), the `data-theme` attribute, and updating `meta[name="theme-color"]` per mode so browser chrome matches (theme.ts:9–13, 25–29: bone `#E4D7BE` / paper `#F6F1E5` / near-black `#12100C`). The PWA manifest carries matching `theme_color: '#E4D7BE'` / `background_color: '#12100C'` (vite.config.ts:69–70).

**5. Sweep hardcoded values to tokens, and darken status colors for light mode.**

All whites/blacks/reds/ambers in room screens moved to tokens; the light block re-points status tokens to darker, paper-legible values (`--color-danger: #b42318`, `--color-warning: #b45309`, `--color-success: #1b7a3d` — src/index.css:185–187). Intentional survivors of the sweep: camera-overlay whites in src/pages/Scan.tsx (e.g. `text-white/70` at Scan.tsx:109 — text over live video is mode-independent), the BottomSheet scrim `bg-black/50` (src/components/BottomSheet.tsx:53), and white text on ember/red buttons.

**6. Give users the switch as data, not branching.**

Settings renders an Appearance segmented control (`role="radiogroup"`) by mapping `THEME_MODES` (src/pages/Settings.tsx:140–160); selecting calls `setTheme`, which applies and persists (theme.ts:31–38). Adding a fourth mode would mean one more entry in `THEME_MODES`/`THEME_COLORS` and one more CSS block.

## Why This Matters

- **Zero component-level theme logic.** No component reads the theme; there is no `theme === 'dark' ? … : …` anywhere in the render tree. The theming surface is one CSS file plus one 38-line utility module, which keeps every future screen automatically theme-correct as long as it uses role tokens.
- **The migration was mostly mechanical.** Because role tokens map one-to-one onto old value classes (`bg-accent` → `bg-field`, `bg-white` → `bg-cta`, `bg-black/15` → `bg-on-field/10`), the PR was a rename sweep rather than a redesign of components — low-risk, easy to review, easy to verify.
- **Additional modes are token-block-sized.** The third (hybrid) mode cost nothing beyond choosing the base values; dark and light are 13 and 25 variable re-points respectively (src/index.css:145–188). A `dark:`-variant approach would have required touching every themed element per mode and still could not express three modes; parallel stylesheets drift.
- **The CSP stays strict.** No `'unsafe-inline'` for scripts, no nonce plumbing — the entry-module bootstrap gets flash-free theming for free because an empty `#root` means there is nothing to flash.

Per the session, verification covered `pnpm lint`, `pnpm typecheck`, the 721-test vitest suite, a production build with the compiled CSS grepped to confirm all three override blocks survive Tailwind's output, and Playwright screenshots (390x780) of Home, Send amount, and Settings in all three modes.

## When to Apply

Apply this pattern when:

- You need **more than binary light/dark** — any N-mode scheme (hybrid, high-contrast, seasonal) where Tailwind's `dark:` variant cannot enumerate the modes.
- You catch the **value-vs-role smell**: class names like `text-white`, `bg-black/15`, or a color family named for its current value (`--color-dark`) being consumed where a _role_ is meant. Rename to the role first; re-pointing then becomes possible.
- You're in a **CSP-constrained PWA** (`script-src 'self'`) and need pre-paint theme application — the entry-module bootstrap works whenever first paint of app UI can't happen before the entry module runs (empty `#root`).
- Modes differ **only in color values**, so the whole difference fits in variable blocks.

Do **not** apply when:

- Themes are **structurally different** — different layouts, different components shown, different imagery. Variable re-pointing can't change structure; that genuinely needs component branching or separate render paths.
- A surface is **mode-independent by nature** (content over live camera video, scrims, text on a fixed brand color). Forcing those onto tokens adds indirection with no payoff — leave them as literal values, as Scan.tsx and BottomSheet.tsx do.
- You server-render meaningful HTML before the entry module executes; then the empty-`#root` trick doesn't hold and you need a nonce'd inline script or server-set attribute instead.

## Examples

**1. Translucent wash: hardcoded black → opacity modifier on a role token.**

Before (pre-#184): `bg-black/15` on Home's bone background — invisible-ish on dark modes, wrong hue on paper.

After (src/pages/Home.tsx:68):

```tsx
<div className="mx-auto max-w-xs rounded-xl bg-on-field/10 p-4 text-center text-sm text-on-field backdrop-blur-sm">
```

`on-field` is near-black in hybrid/light and cream in dark, so the 10% wash adapts per mode with no component change.

**2. Light mode by re-pointing the "dark" family — zero call-site edits.**

Base (src/index.css:87–91) vs. light override (src/index.css:162–167):

```css
@theme {
  --color-dark: #12100c;
  --color-dark-surface: #1c1913;
  --color-on-dark: #f6f0e4;
}
:root[data-theme='light'] {
  --color-dark: #f6f1e5;
  --color-dark-surface: #efe8d8;
  --color-on-dark: #1a140a;
}
```

Every `bg-dark` / `bg-dark-surface` / `text-on-dark` in Send/Receive/Settings inverts to warm paper without touching a single component — "dark" names the role (room background), not the value.

**3. CSP-safe pre-paint theme bootstrap.**

The classic approach — an inline `<script>` in `<head>` setting the attribute — is blocked by `script-src 'self'` (index.html:13). Instead (src/main.tsx:12):

```tsx
// CSP forbids inline scripts, so the theme attribute is set here — before
// first render, while #root is still empty.
applyTheme(getStoredTheme())
```

`applyTheme` (src/utils/theme.ts:25–29) sets `document.documentElement.dataset.theme` and syncs `meta[name="theme-color"]` so browser chrome matches the mode; `getStoredTheme` validates the localStorage value and falls back to `'hybrid'` inside try/catch.

## Related

- [Standalone HTML design prototype workflow](../design-patterns/standalone-html-design-prototype-workflow.md) — origin of the CSS design-token approach; its open "CSS Strategy Before Porting" decision (extend Tailwind theme vs CSS Modules) is resolved by this pattern: semantic role tokens in Tailwind v4 `@theme`.
- [QR scanner camera/send-flow integration](../integration-issues/qr-scanner-camera-send-flow-integration.md) — a prior instance of the strict CSP forcing an implementation change (Permissions-Policy / worker-src there, script-src here).
- PR #184 — the implementing change (squash-merged to main, 2026-07-26).
