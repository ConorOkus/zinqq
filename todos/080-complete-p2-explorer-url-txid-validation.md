---
status: complete
priority: p2
issue_id: "080"
tags: [code-review, security, defense-in-depth]
dependencies: []
---

# Validate txid before constructing explorer URL

## Problem Statement

The Send success screen interpolates `sendStep.txid` directly into an `<a href>` without validating it is a well-formed 64-character hex string. While the value comes from trusted WASM code today, defense-in-depth matters in a wallet app.

## Findings

- **File:** `src/pages/Send.tsx`, success screen explorer link
- **Identified by:** security-sentinel (MEDIUM-1)

```tsx
href={`${ONCHAIN_CONFIG.explorerUrl}/tx/${sendStep.txid}`}
```

## Acceptance Criteria

- [ ] Add a `TXID_RE = /^[0-9a-f]{64}$/i` guard before constructing the URL
- [ ] Render the link only if txid matches the pattern; otherwise show the raw txid as text without a link
