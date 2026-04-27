---
status: pending
priority: p3
issue_id: '265'
tags: [code-review, payjoin, architecture, react]
dependencies: []
---

# Extract `usePayjoinTransform` hook from Send.tsx (lifecycle correctness)

## Problem Statement

`Send.tsx:594-650` (`handleOcConfirm`) now manages: send branching (sendMax / payjoin / plain), the `payjoinAbort` controller, two DOM event listeners (`visibilitychange` + `beforeunload`), `sendingRef` reentrancy, the `transformPsbt` closure builder, and listener teardown. ~50 lines of bookkeeping is a lot for a page component.

Subtle bug: if the user navigates _away_ from the Send page mid-Payjoin, `sendingRef` and the listeners are bound to the closure, but the page is unmounting. The `finally` block only fires when the promise settles. In the meantime a backgrounded send keeps event listeners alive on a dead component.

## Findings

- **architecture-strategist #4**: extract a hook so DOM event listeners are owned by `useEffect` cleanup (canonical mount/unmount discipline).

## Proposed Solutions

### Option 1 (recommended) — Extract `usePayjoinTransform`

```ts
// src/onchain/payjoin/use-payjoin-transform.ts
export function usePayjoinTransform(
  payjoinCtx: PayjoinContext | undefined
): TransformPsbtHook | undefined {
  // - Owns AbortController via useRef
  // - Registers visibility/beforeunload listeners in useEffect with cleanup on unmount
  // - Returns a stable transformPsbt closure or undefined
}
```

`Send.tsx:handleOcConfirm` collapses to:

```ts
const transformPsbt = usePayjoinTransform(
  sendStep.step === 'oc-review' ? sendStep.payjoin : undefined
)
// in try block:
txid = await onchain.sendToAddress(addr, amount, feeRate, transformPsbt)
```

- Pros: lifecycle correctness; Send.tsx no longer knows about tryPayjoinSend or AbortSignal.any; Payjoin becomes a self-contained vertical slice.
- Cons: small new file; one more piece of React idiom to learn.

## Recommended Action

Option 1, but P3 — defer until the listener-on-dead-component lifecycle bug becomes user-visible. Bundle with todo #254 (composeSignals helper) if both land together.

## Technical Details

- New file: `src/onchain/payjoin/use-payjoin-transform.ts`
- Removed code: `Send.tsx:604-650` event listener setup/teardown
- Test: React Testing Library mount/unmount test asserting listeners are cleaned up

## Acceptance Criteria

- [ ] `usePayjoinTransform` extracted with mount/unmount test
- [ ] Send.tsx imports nothing from `payjoin.ts` directly
- [ ] DOM event listeners cleaned up on unmount (verifiable via spy)

## Work Log

## Resources

- PR #143
- architecture-strategist agent report
