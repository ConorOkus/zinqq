---
status: complete
priority: p2
issue_id: "046"
tags: [code-review, security, ux]
dependencies: []
---

# Mnemonic import uses prompt() and lacks input normalization

## Problem Statement

Two issues with mnemonic import:
1. `prompt()` shows the mnemonic in plaintext with no masking. Clipboard managers, extensions, and screen recording can capture it.
2. No whitespace/case normalization before validation — leading/trailing spaces or double spaces could cause valid mnemonics to fail.

## Findings

- **prompt():** `src/wallet/wallet-gate.tsx:28`
- **No normalization:** `src/wallet/context.tsx:29` — `importWallet` passes mnemonic directly to `validateMnemonic` without `.trim().toLowerCase().replace(/\s+/g, ' ')`
- **Agent:** security-sentinel (HIGH-1, MEDIUM-2)

## Proposed Solutions

Replace `prompt()` with a custom React modal containing masked input. Add normalization before validation:
```typescript
const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
if (!validateMnemonic(normalized)) { ... }
```
- **Effort:** Small | **Risk:** Low

## Acceptance Criteria
- [ ] Mnemonic import uses a custom input form, not `prompt()`
- [ ] Input is normalized (trimmed, lowercased, deduplicated spaces) before validation
