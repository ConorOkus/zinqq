---
status: complete
priority: p3
issue_id: '160'
tags: [code-review, quality]
dependencies: []
---

# Remove dead `bip353Result.type !== 'error'` guard in resolveAddress

## Problem Statement

`resolveBip353` never returns `{ type: 'error' }` — it returns null or a valid ParsedPaymentInput. The guard `bip353Result && bip353Result.type !== 'error'` is dead code. Simplify to `if (bip353Result)`.

**File:** `src/pages/Send.tsx` line 178

## Acceptance Criteria

- [ ] Guard simplified to `if (bip353Result)`
