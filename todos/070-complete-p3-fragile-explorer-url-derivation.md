---
status: pending
priority: p3
issue_id: "070"
tags: [code-review, quality]
dependencies: []
---

# Explorer URL derived by fragile string replacement

## Problem Statement

`ONCHAIN_CONFIG.esploraUrl.replace('/api', '')` is used to construct the block explorer URL. This could break if the URL contains '/api' elsewhere, and it's computed on every render even though it's only used in the success step.

## Findings

**Location:** `src/pages/Send.tsx`, line 185

Flagged by: code-simplicity-reviewer

## Proposed Solutions

### Option A: Add explorerUrl to ONCHAIN_CONFIG
```typescript
explorerUrl: 'https://mutinynet.com'
```

- Effort: Small
- Risk: Low

## Acceptance Criteria

- [ ] Explorer URL is a config constant, not derived from esploraUrl
