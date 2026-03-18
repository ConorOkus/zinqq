---
status: pending
priority: p3
issue_id: "141"
tags: [code-review, ux]
---

# Surface QR scan parse errors instead of swallowing silently

## Problem Statement

When `classifyPaymentInput(raw)` returns `type: 'error'` in the QR scanner useEffect, the effect returns silently with no user feedback. The user sees the recipient screen as if nothing was scanned.

## Findings

- Flagged by Agent-native reviewer
- `src/pages/Send.tsx` line 141: `if (parsed.type === 'error') return`

## Proposed Solutions

Set `inputValue` and `inputError` before returning so the user sees what was scanned and why it failed:

```typescript
if (parsed.type === 'error') {
  setInputValue(raw)
  setInputError(parsed.message)
  return
}
```

- Effort: Small
- Risk: None
