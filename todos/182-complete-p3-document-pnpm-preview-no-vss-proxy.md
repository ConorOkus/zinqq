---
status: complete
priority: p3
issue_id: '182'
tags: [code-review, documentation]
dependencies: []
---

# Document that pnpm preview lacks VSS proxy

## Problem Statement

`pnpm preview` serves the production build locally but does not run Vite's dev server proxy. Since `config.ts` now defaults to `/__vss_proxy/vss` in all environments (no dev/prod branch), running `pnpm preview` will result in 404s for VSS requests because there's no rewrite handler. This works correctly on Vercel (rewrite rules) and in dev (Vite proxy), but `pnpm preview` is a gap.

**Files:** `src/ldk/config.ts:11`

## Findings

- Flagged by TypeScript reviewer (PR #46 review)
- `pnpm preview` uses Vite's preview server which does NOT run `server.proxy` config
- The old code had `https://vss.mutinynet.com/vss` as the production fallback, but that was already broken by CORS
- Impact is low: `pnpm preview` is rarely used and VSS was already broken in that scenario

## Proposed Solutions

### Option A: Add a comment in config.ts

Note that the `/__vss_proxy/vss` path requires a proxy (Vite dev or Vercel rewrite) and won't work with `pnpm preview`.

- **Effort:** Small
- **Risk:** None

### Option B: Document in README (when one exists)

Include deployment prerequisites in project documentation.

- **Effort:** Small
- **Risk:** None
