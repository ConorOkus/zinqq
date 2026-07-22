---
title: 'QR Scanner: Camera Integration & Send Flow Data Passing'
category: integration-issues
date: 2026-03-18
severity: LOW
module: src/pages/Scan.tsx, src/pages/Send.tsx
tags: [qr-scanner, camera, getUserMedia, location-state, send-flow, bip321, csp, permissions-policy]
---

# QR Scanner: Camera Integration & Send Flow Data Passing

## Problem

Adding a camera-based QR code scanner that feeds scanned payment data into the existing Send flow state machine. Key challenges: (1) passing parsed payment data between routes when LDK WASM class instances (`Bolt11Invoice`, `Offer`) cannot survive `structuredClone` serialization, (2) integrating with the amount-first Send flow when QR codes may or may not contain amounts, (3) security headers blocking camera access.

## Root Cause

Three distinct integration hurdles:

1. **Serialization**: React Router's `location.state` uses the History API's `structuredClone`, which strips methods and prototype chains from WASM class instances. `bigint` values also don't serialize.
2. **State machine mismatch**: The Send flow is amount-first (`amount → recipient → review`), but QR codes provide the recipient first, optionally with an amount.
3. **Security headers**: Both `Permissions-Policy: camera=()` and missing `worker-src` in CSP blocked camera access and the qr-scanner Web Worker.

## Solution

### 1. Pass raw string, re-parse on the other side

Instead of passing the parsed `ParsedPaymentInput` object, pass only the raw QR string via `location.state` and re-parse with `classifyPaymentInput()` in Send.tsx:

```typescript
// Scan.tsx — navigate with raw string only
void navigate('/send', { state: { scannedInput: result.data } })

// Send.tsx — re-parse from raw string
const state = location.state as Record<string, unknown> | null
const raw = typeof state?.scannedInput === 'string' ? state.scannedInput : null
if (!raw) return
const parsed = classifyPaymentInput(raw)
```

This avoids serialization issues entirely. The double-parse also provides defense-in-depth validation.

### 2. No amount-presence fork needed — recipient-first flow made it unnecessary

**Update:** The original design forked the state machine based on whether the scanned QR embedded an amount. That fork no longer exists. The Send flow is recipient-first now (see the [state-machine doc](../design-patterns/react-send-flow-amount-first-state-machine.md) for current framing), so a scanned input is always routed through the same single call regardless of amount presence.

Current implementation (`src/pages/Send.tsx`, ~549-571) uses two effects: one consumes `location.state.scannedInput` and stashes it in an intermediate `pendingQrInput` state; a second waits until `onchain.status === 'ready'` before processing it:

```typescript
// Effect 1: consume scannedInput from location.state, clear it, stash it
useEffect(() => {
  const state = location.state as Record<string, unknown> | null
  const raw = typeof state?.scannedInput === 'string' ? state.scannedInput : null
  if (!raw) return
  if (raw.length > 2000) {
    setInputError('Scanned input is too long')
    return
  }
  void navigate('/send', { replace: true, state: null })
  setPendingQrInput(raw)
}, [])

// Effect 2: process the pending QR input once the wallet is ready
useEffect(() => {
  if (!pendingQrInput) return
  if (onchain.status !== 'ready') return
  const raw = pendingQrInput
  setPendingQrInput(null)
  setInputValue(raw)
  void processRecipientInput(raw, 'recipient')
}, [pendingQrInput, onchain.status, processRecipientInput])
```

`processRecipientInput` gained a second parameter — `fromStep: 'recipient' | 'amount'` — tagging where the call originated (recipient-input vs. amount-step re-entry after "Next"). The scanned-input path always passes `'recipient'`; `processRecipientInput` itself still branches internally on whether the parsed input carries an embedded amount to decide whether to go straight to review or fall through to the amount step.

### 3. Security headers

```
// Permissions-Policy (vite.config.ts + vercel.json)
camera=(self)    // was camera=()

// CSP (index.html) — add worker-src for qr-scanner's blob-based Web Worker
worker-src 'self' blob:;
```

`getUserMedia` does NOT require CSP changes — it's governed by Permissions-Policy only. The `worker-src blob:` is specifically for the qr-scanner library's Web Worker architecture.

### 4. Library choice: qr-scanner (nimiq/qr-scanner)

- ~16 kB gzipped (5.6 kB with native BarcodeDetector)
- Built-in camera management — no manual `getUserMedia` code needed
- Web Worker decoding keeps mobile UI smooth
- Safari workarounds baked in
- Camera cleanup via `scanner.stop()` + `scanner.destroy()` in useEffect cleanup

## Prevention / Best Practices

- **Never pass WASM class instances through `location.state`** — they lose their prototype chain. Pass raw strings and re-parse.
- **Never use `setTimeout` to "wait for state to settle"** in React — it doesn't actually wait for a re-render. If a callback needs fresh state, either pass data as arguments or use a separate effect that watches the state.
- **Always clear `location.state` after consuming it** — `navigate(path, { replace: true, state: null })` prevents re-processing on browser back/forward.
- **Always validate `location.state` at runtime** — use `typeof` checks, not `as` casts, since state comes from an untrusted boundary.
- **Use a ref guard (`hasNavigatedRef`) for camera callbacks** — QR decoders fire rapidly and can trigger duplicate navigations.
- **Clear one-shot state after consumption** — `pendingQrInput` should be nulled once the ready-gated effect consumes it, or it persists on retry.

## Related

- [BIP 321 Unified URI Generation](bip321-unified-uri-bolt11-invoice-generation.md) — receive-side QR code generation
- [Send Flow Amount-First State Machine](../design-patterns/react-send-flow-amount-first-state-machine.md) — Send.tsx state machine design
- PR #33: feat: Add camera QR code scanner
