---
status: pending
priority: p3
issue_id: "042"
tags: [code-review, quality]
dependencies: []
---

# Add config test for wsProxyUrl field

## Problem Statement

`src/ldk/config.test.ts` tests `esploraUrl` and `network` but does not assert on the newly added `wsProxyUrl` field. A simple assertion guards against accidental breakage.

## Findings

- **Source:** Architecture Strategist
- **Location:** `src/ldk/config.test.ts`

## Proposed Solutions

### Option A: Add assertion for wsProxyUrl
Assert it is a string starting with `wss://`.

- **Effort:** Small

## Acceptance Criteria

- [ ] Config test includes assertion for `wsProxyUrl`
