---
status: pending
priority: p2
issue_id: '281'
tags: [code-review, infra, typescript, architecture]
dependencies: []
---

# Split `tsconfig.api.json` from `tsconfig.node.json`

## Problem Statement

Commit `3b33e19` added `api/**/*.ts` to `tsconfig.node.json`, which previously held only build-time tooling configs (`vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `playwright.config.ts`). The Vercel serverless functions in `api/` are runtime artifacts shipped to Vercel's serverless runtime — different lifecycle, different deploy boundary, different module-resolution expectations. Co-mingling them invites a future config-drift bug where `api/` compiles fine locally but breaks at deploy because tooling-flavored options leaked in.

Today everything passes (`pnpm typecheck` clean), so this is architectural hygiene, not a runtime bug.

## Findings

- `tsconfig.node.json:11` — `moduleResolution: bundler` (correct for `noEmit` typecheck, but Vercel resolves at deploy time).
- `tsconfig.node.json:8` — `lib: ["ES2023"]` (no DOM); `@types/node` provides Web Fetch globals at runtime, so api files happen to typecheck. Coupling.
- Flagged by `architecture-strategist`.

## Proposed Solution

Create `tsconfig.api.json` extending a shared base, with `include: ["api/**/*.ts"]`, `types: ["node"]` (or `@vercel/node`), and a module-resolution explicitly aligned with Vercel's runtime. Reference both `tsconfig.app.json`, `tsconfig.node.json`, and the new `tsconfig.api.json` from the root `tsconfig.json`. Drop `api/**/*.ts` from `tsconfig.node.json` includes.

**Effort:** 30 min.
**Risk:** Low.

## Acceptance Criteria

- [ ] `tsconfig.api.json` exists and is referenced from root `tsconfig.json`.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass.
- [ ] Vercel preview deploy still passes after the change.

## Resources

- **PR:** #147
- **Reviewer:** `architecture-strategist`

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** architecture-strategist
