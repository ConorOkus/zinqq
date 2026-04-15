---
status: complete
priority: p3
issue_id: '171'
tags: [code-review, quality]
dependencies: []
---

# Rename recoveredMonitorKeys and simplify else branch

## Problem Statement

The variable `recoveredMonitorKeys` is misleading — in the `else` branch (line 194-199) it is populated from existing IDB monitors, not recovered ones. Additionally, the loop can be replaced with a spread.

**Files:** `src/ldk/init.ts:169, 194-199`

## Acceptance Criteria

- [ ] Rename `recoveredMonitorKeys` to `initialMonitorKeys` (matches the `PersisterOptions` field name)
- [ ] Replace `for (const key of idbMonitors.keys()) { ... push(key) }` with `[...idbMonitors.keys()]`
