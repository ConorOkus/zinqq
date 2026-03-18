---
status: complete
priority: p3
issue_id: "059"
tags: [code-review, testing]
dependencies: []
---

# Add test for QR code uppercase BIP21 URI format

## Problem Statement

The Receive page encodes the QR code with an uppercase BIP21 URI (`BITCOIN:TB1Q...`) for optimal QR alphanumeric mode encoding. No test asserts this format — if someone changes it to lowercase, QR code density regresses silently.

## Findings

**Location:** `src/pages/Receive.tsx`, line 51 and `src/pages/Receive.test.tsx`

```tsx
const qrValue = address ? `BITCOIN:${address.toUpperCase()}` : ''
```

No test verifies the QR component receives the uppercase URI value.

Flagged by: kieran-typescript-reviewer

## Proposed Solutions

### Option A: Assert QR SVG value prop via test

Mock `QRCodeSVG` or inspect the rendered output to verify it receives the uppercase URI.

- **Pros:** Locks down the QR optimization
- **Cons:** May need to mock the QR component
- **Effort:** Small (10 min)
- **Risk:** None

## Acceptance Criteria

- [ ] Test verifies QR code value starts with `BITCOIN:` and contains uppercase address
