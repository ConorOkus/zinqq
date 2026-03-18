---
status: complete
priority: p3
issue_id: "028"
tags: [code-review, quality, simplicity]
dependencies: []
---

# Dead code and YAGNI cleanup

## Problem Statement

Several pieces of dead code and premature abstractions identified across the PR.

## Findings

- **Source:** Simplicity Reviewer, TypeScript Reviewer
- **Items to remove/fix:**
  1. `getBlockHashAtHeight` in `esplora-client.ts` — defined but never called (~5 LOC)
  2. `networkGraphPersistIntervalTicks` in `config.ts` — defined but chain-sync hardcodes `10` (~1 LOC)
  3. Post-sync tip verification in `chain-sync.ts` — extra HTTP request per tick with no corrective action (~5 LOC)
  4. Redundant `is_ok()` check before `instanceof` in `init.ts` node ID derivation (~3 LOC)
  5. Inline `import('lightningdevkit').ChannelMonitor[]` type in `init.ts` — use named import instead
  6. `SyncStatus` type has unused `'synced' | 'stale'` variants (covered by todo 021)

## Acceptance Criteria

- [ ] Dead methods/config removed
- [ ] Redundant checks collapsed
- [ ] Inline import types replaced with named imports

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-11 | Created | From PR #3 code review |
