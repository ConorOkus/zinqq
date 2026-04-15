---
status: complete
priority: p3
issue_id: '162'
tags: [code-review, quality]
dependencies: []
---

# resolveBip353 should propagate AbortError like resolveLnurlPay

## Problem Statement

`resolveBip353` swallows all fetch errors including AbortError (returns null). `resolveLnurlPay` correctly re-throws AbortError. This inconsistency means a cancelled BIP 353 fetch falls through to an unnecessary LNURL attempt before the abort check in resolveAddress fires.

**File:** `src/ldk/resolve-bip353.ts` lines 32-35

## Acceptance Criteria

- [ ] resolveBip353 re-throws AbortError (DOMException with name 'AbortError')
- [ ] Other fetch errors still return null
