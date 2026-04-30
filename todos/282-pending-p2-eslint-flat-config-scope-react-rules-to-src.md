---
status: pending
priority: p2
issue_id: '282'
tags: [code-review, lint, infra]
dependencies: []
---

# Scope React-flavored eslint rules to `src/**` only; add `api/**` block for Node handlers

## Problem Statement

Commit `3b33e19` re-included `api/**/*.ts` in eslint by removing it from ignores. The existing eslint flat-config block targets `**/*.{ts,tsx}` and applies React-flavored plugins (`react`, `react-hooks`, `react-refresh`, `jsx-a11y`) to *every* TS file — including the three Vercel serverless handlers under `api/`. The handlers are non-JSX Node code; React rules are wasted work and risk false positives (notably `react-refresh/only-export-components`, since Vercel handlers *are* default exports).

Today no lint findings surface (`pnpm lint` exit 0), so this is hygiene, not a bug.

## Findings

- `eslint.config.js:38` — `files: ['**/*.{ts,tsx}']` block configures all React plugins.
- `api/esplora-proxy.ts`, `api/lnurl-proxy.ts`, `api/vss-proxy.ts` — non-JSX, default-export Node handlers.
- Flagged by `architecture-strategist`.

## Proposed Solution

Either:
- **Option A:** Scope the React block to `src/**/*.{ts,tsx}`, add a new flat-config block targeting `api/**/*.ts` with Node-appropriate rules (no React plugins).
- **Option B:** Keep one block, add `files: ['api/**/*.ts']` overrides that disable react/jsx-a11y plugins and `react-refresh/only-export-components`.

Option A is structurally cleaner.

**Effort:** 30 min.
**Risk:** Low.

## Acceptance Criteria

- [ ] React rules no longer apply to `api/**/*.ts`.
- [ ] `pnpm lint` exits 0.
- [ ] No false-positive lint warnings on serverless handlers.

## Resources

- **PR:** #147
- **Reviewer:** `architecture-strategist`

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** architecture-strategist
