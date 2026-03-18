---
status: pending
priority: p3
issue_id: "138"
tags: [code-review, quality]
---

# Fix misleading indentation in processRecipientInput try block

## Problem Statement

The `try { ... } finally { ... }` block in `processRecipientInput` has the body at the same indentation level as the `try` keyword, making it look like the code is outside the try block when it's actually inside.

## Findings

- Flagged by TypeScript reviewer (HIGH)
- `src/pages/Send.tsx` lines 192-298

## Proposed Solutions

Indent the body of the try block one level deeper. Pure formatting change.

- Effort: Small
- Risk: None
