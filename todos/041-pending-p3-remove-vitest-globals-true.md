---
status: pending
priority: p3
issue_id: "041"
tags: [code-review, quality, proxy]
dependencies: []
---

# Remove `globals: true` from vitest config — redundant with explicit imports

## Problem Statement

`vitest.config.ts` sets `globals: true` but both test files explicitly import `describe`, `it`, `expect` from `vitest`. The setting has no effect and is misleading.

## Findings

- **Source:** TypeScript Reviewer, Simplicity Reviewer
- **Location:** `proxy/vitest.config.ts` line 5

## Proposed Solutions

### Option A: Remove globals: true
- **Effort:** Small — one-line removal

## Acceptance Criteria

- [ ] `globals: true` removed from vitest config
- [ ] Tests still pass with explicit imports
