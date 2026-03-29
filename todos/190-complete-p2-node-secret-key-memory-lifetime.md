---
status: complete
priority: p2
issue_id: '190'
tags: [code-review, security, lsps2]
---

# Node secret key persists in memory without cleanup

## Problem Statement

The `nodeSecretKey` (32-byte private key for signing invoices) is stored as a field on the `LdkNode` object and remains in memory for the entire session. It is never zeroed. In dev mode, it is also exposed on `window.__ldkNode`.

## Findings

- **Security sentinel CRITICAL-1:** Key is accessible to browser extensions, XSS, or malicious dependencies via the JS heap. In dev mode, `window.__ldkNode.nodeSecretKey` is directly readable.
- **TS reviewer finding 1:** Teardown in context.tsx:845-863 never zeroes the key. The comment says "Don't destroy LSPS handler or zero key here" due to StrictMode.
- **Architecture reviewer R1:** Inherent to the architecture since the key is needed for every JIT invoice signing. Acceptable for a browser wallet but worth addressing.

## Proposed Solutions

1. **Derive on-demand, zero after use** — Instead of storing `nodeSecretKey` on `LdkNode`, derive it from seed only when signing a JIT invoice, then immediately `fill(0)`.
   - Pros: Minimal exposure window
   - Cons: Adds ~1ms derivation per invoice; needs seed access in the signing path
   - Effort: Medium
   - Risk: Low

2. **Exclude from window debug export** — Remove `nodeSecretKey` from `window.__ldkNode` in dev mode. Add `beforeunload` handler to zero the key on page exit.
   - Pros: Simpler, reduces exposure
   - Cons: Key still in heap during session
   - Effort: Small
   - Risk: Low

## Technical Details

- **Affected files:** `src/ldk/init.ts` (lines 78, 217, 631-647), `src/ldk/context.tsx` (line 494, 845-863)
- **Effort:** Medium

## Acceptance Criteria

- [ ] `nodeSecretKey` not exposed on `window.__ldkNode`
- [ ] Key is zeroed on page unload or after each signing operation
- [ ] Tests still pass

## Resources

- Branch: feat/lsps2-jit-channel-receive
