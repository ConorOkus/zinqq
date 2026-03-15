---
status: complete
priority: p2
issue_id: "035"
tags: [code-review, quality]
dependencies: []
---

# Duplicated bytesToHex + unsafe ArrayBuffer cast

## Problem Statement

1. `bytesToHex` logic inlined in `peer-connection.ts:83-85` and `Home.tsx:17-19` instead of using shared `utils.ts`
2. `event.data as ArrayBuffer` in `peer-connection.ts:65` is an unsafe cast — should use `instanceof` guard

## Findings

- **Source:** TypeScript Reviewer (P1-1, P1-3), Simplicity Reviewer
- **Location:** `src/ldk/peers/peer-connection.ts`, `src/pages/Home.tsx`

## Acceptance Criteria

- [ ] Both inline hex conversions replaced with `bytesToHex` import
- [ ] `as ArrayBuffer` replaced with `instanceof ArrayBuffer` guard

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-12 | Created | From PR #4 code review |
