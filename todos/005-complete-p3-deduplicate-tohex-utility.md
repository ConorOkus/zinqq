---
status: complete
priority: p3
issue_id: '005'
tags: [code-review, quality]
dependencies: []
---

# Duplicated toHex/bytesToHex across 3 files

## Problem Statement

Identical byte-to-hex conversion exists in `init.ts`, `broadcaster.ts`, and `persist.ts`.

## Proposed Solutions

Extract to `src/ldk/hex.ts` (4 lines), import everywhere.

## Acceptance Criteria

- [ ] Single `bytesToHex` function in one location
- [ ] All three files import from shared util
