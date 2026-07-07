---
status: pending
priority: p3
issue_id: '381'
tags: [code-review, lsps2, naming, docs, pr-167]
dependencies: []
---

# LSPS2 naming-parity follow-through: stale `buyChannel` comments + private-method vocab

## Problem Statement

PR #167 is explicitly about mirroring LDK's vocabulary, but a few spots still use the old
names, undercutting the parity story. Cosmetic; no behavior impact.

## Findings

- Stale doc comments referencing the removed `buyChannel` method:
  - `src/ldk/context.tsx:331` and `:334`
  - `src/ldk/ldk-context.ts:62-63`
    The method is now `selectOpeningParams`.
- The private transport method retains old vocabulary while the public API adopted
  `counterpartyNodeId`: `src/ldk/lsps2/client.ts:99-100` (`sendLsps2Request(lspNodeId, …)`)
  and `:108` (`hexToBytes(lspNodeId)`).

## Proposed Solutions

### Option A: Sweep the remaining names

`s/buyChannel/selectOpeningParams/` in the three comment sites; rename `lspNodeId` →
`counterpartyNodeId` in `sendLsps2Request`. Effort: Trivial.

## Recommended Action

(Triage) Option A — bundle with any other small cleanup on this module.

## Technical Details

- **Affected files**: `src/ldk/context.tsx`, `src/ldk/ldk-context.ts`,
  `src/ldk/lsps2/client.ts`.

## Acceptance Criteria

- [ ] No references to `buyChannel` remain in comments.
- [ ] `sendLsps2Request` uses `counterpartyNodeId`.
- [ ] `pnpm typecheck` passes.

## Work Log

- 2026-07-07: Filed from `/ce:review` of PR #167.
