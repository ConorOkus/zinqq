---
status: complete
priority: p3
issue_id: '232'
tags: [code-review, payjoin, quality, config]
dependencies: []
---

# Narrow eslint `vendor/**` ignore to `vendor/rust-payjoin/**`

## Problem Statement

`eslint.config.js:10` now has `vendor/**` in the ignores list. That silences lint on every current and future vendored subproject. If we later vendor a hand-written TypeScript shim under `vendor/`, it won't be lint-checked by default.

## Findings

- `eslint.config.js:10` — `vendor/**`.

Flagged by `kieran-typescript-reviewer` (P3).

## Proposed Solution

```js
{ ignores: ['dist/**', 'node_modules/**', 'proxy/**', 'design/**', 'api/**', 'vendor/rust-payjoin/**'] },
```

Same change needed in `.prettierignore` (keep `vendor/rust-payjoin` or narrow to each submodule explicitly).

- Effort: Small.
- Risk: None.

## Technical Details

- Affected files: `eslint.config.js`, `.prettierignore`

## Acceptance Criteria

- [ ] Lint and prettier ignores scoped per-submodule
- [ ] `pnpm lint` + `pnpm format:check` still green

## Work Log

## Resources

- PR #140
