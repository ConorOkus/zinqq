---
status: complete
priority: p1
issue_id: '189'
tags: [code-review, security, lsps2]
---

# Remove sensitive data from console logs

## Problem Statement

Payment secrets, full protocol payloads, and node secret-adjacent data are logged to the browser console in plaintext. Anyone with console access (browser extensions, error monitoring, debugging tools) can extract this data.

## Findings

- **Security sentinel CRITICAL-2:** `paymentSecret` logged in hex at `context.tsx:288-294`. Combined with the payment hash (also logged), an attacker could construct a valid HTLC claim.
- **Security sentinel HIGH-3 / TS reviewer / Simplicity reviewer:** `message-handler.ts` has 15+ `console.log` calls logging message payloads (up to 200 chars), internal state, and pending request counts. `socket-descriptor.ts` logs on every `send_data` call.
- **Context.tsx:243-249:** LSPS0 `list_protocols` debug probe logs full JSON response and adds an unnecessary network round-trip to every JIT invoice request.
- **Context.tsx:287-294, 307:** Full parameter dump and invoice string logged.

## Proposed Solutions

1. **Remove all sensitive log statements** — Delete `paymentSecret` from the log at context.tsx:288, remove the LSPS0 probe entirely (context.tsx:243-249), and remove the `sendRawRequest` method from LSPS2Client that only exists for this probe.
   - Pros: Simplest, removes latency from debug probe
   - Cons: Less debugging visibility
   - Effort: Small
   - Risk: Low

2. **Gate behind `import.meta.env.DEV`** — Wrap all debug logs in a dev-only check.
   - Pros: Keeps debugging capability in development
   - Cons: Still logs secrets in dev mode; more code
   - Effort: Small
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/context.tsx`, `src/ldk/lsps2/message-handler.ts`, `src/ldk/peers/socket-descriptor.ts`, `src/ldk/lsps2/client.ts`
- **Effort:** Small

## Acceptance Criteria

- [ ] `paymentSecret` never appears in any console.log
- [ ] LSPS0 `list_protocols` probe removed from `requestJitInvoice`
- [ ] `sendRawRequest` method removed from LSPS2Client
- [ ] message-handler.ts logs reduced to warnings/errors only
- [ ] socket-descriptor.ts debug logs removed

## Resources

- Branch: feat/lsps2-jit-channel-receive
