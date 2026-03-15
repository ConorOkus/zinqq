---
status: pending
priority: p3
issue_id: "071"
tags: [code-review, quality]
dependencies: []
---

# getFeeRate catch clause missing err: unknown annotation

## Problem Statement

The catch clause in getFeeRate uses `catch (err)` instead of `catch (err: unknown)`, inconsistent with the rest of the codebase which correctly annotates all catch clauses.

## Findings

**Location:** `src/onchain/context.tsx`, line 35

Flagged by: kieran-typescript-reviewer

## Proposed Solutions

Change `catch (err)` to `catch (err: unknown)`.

- Effort: Trivial

## Acceptance Criteria

- [ ] All catch clauses in context.tsx use err: unknown
