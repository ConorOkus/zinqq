---
status: complete
priority: p3
issue_id: '384'
tags: [code-review, lsps2, typescript, pr-167]
dependencies: []
---

# `LspLabel` widened from a union to `string` — restore typo safety

## Problem Statement

To let the generic failover tests use arbitrary fixture labels after LQwD removal,
`LspLabel` was changed from `'lqwd' | 'megalith'` to `string`
(`src/ldk/lsp/contacts.ts`). Only `'megalith'` is ever produced now, so the literal
at the construction site is no longer typo-checked — a mistyped label would compile.
Flagged by TypeScript (P3-a), simplicity (#4), and architecture (#4) reviewers.

## Findings

- `label: 'megalith'` in `resolveLspContacts` is checked against nothing.
- Labels are free-form telemetry/display tags, so full `string` is defensible — but
  the safety loss is avoidable at zero cost.

## Proposed Solutions

### Option A: `type LspLabel = 'megalith' | (string & {})`

Preserves autocomplete + typo-catching for the known label while still accepting
arbitrary strings (so test fixtures like `'primary-lsp'` still typecheck). Effort:
Trivial.

### Option B: `type LspLabel = 'megalith'` + update test fixtures

Tightest, but forces the failover-test fixtures onto the single label (they need two
distinct labels), so not viable without reworking those tests. Not recommended.

## Recommended Action

(Triage) Option A.

## Technical Details

- **Affected files**: `src/ldk/lsp/contacts.ts`.

## Acceptance Criteria

- [ ] Known label `'megalith'` is typo-checked; arbitrary strings still allowed.
- [ ] `pnpm typecheck` + `jit-failover.test.ts` pass.

## Work Log

- 2026-07-07: Filed from `/ce:review` (delta review) of PR #167.
- 2026-07-07: Fixed (Option A). `LspLabel = 'megalith' | (string & {})` in
  `contacts.ts`. Typecheck + failover tests pass.
