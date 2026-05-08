---
status: pending
priority: p2
issue_id: '321'
tags: [code-review, error-handling, observability, lsps2, typescript]
dependencies: []
---

# `JitPeerConnectError` discards underlying `Error.cause`, telemetry loses stack

## Problem Statement

In `src/ldk/context.tsx`, the new `getJitQuote` Step 0 wraps connect
failures with `JitPeerConnectError`, formatting the cause via
`String(firstErr)` / `String(secondErr)`:

```ts
throw new JitPeerConnectError(`peer_connect (${contact.label}): ${String(firstErr)}`)
// ...
throw new JitPeerConnectError(`peer_connect (${contact.label}, retry): ${String(secondErr)}`)
```

This pattern was inherited from the prior implementation and isn't
introduced by the fix — but it has two issues worth addressing while
the surrounding code is being touched:

1. **Stack trace lost**. `String(err)` on an `Error` yields
   `"Error: <message>"` and silently drops the stack. Telemetry
   captureError downstream gets a flattened message with no chain to
   the originating throw site (`peer-connection.ts:60` /
   `:82` / `:101` / `:132` / `:143`).
2. **Non-Error rejections produce `[object Object]`**. The
   `peer-connection.ts` reject sites currently all pass `Error`
   instances, so this is theoretical today, but the contract isn't
   enforced anywhere.

The standard `Error.cause` slot (ES2022) was designed for this case
and is supported in all our targets.

## Findings

- Identified by: kieran-typescript-reviewer during /ce:review of
  LSPS2 fix (2026-05-07)
- Severity P2: existing diagnostic loss, not a regression. Worth
  fixing while the file is being touched.
- Affected throw sites: 2 in `getJitQuote` (lines ~250 and ~261 in
  the post-fix layout). Pattern likely also exists at
  `JitPaymentSizeOutOfRangeError` and `JitQuoteFreshnessError`
  call sites — audit while in there.

## Proposed Solutions

### Option A — Use `Error.cause` + narrow message extraction (recommended)

Update `JitPeerConnectError` to accept a cause:

```ts
export class JitPeerConnectError extends Error {
  readonly trigger = 'peer_connect' as const
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JitPeerConnectError'
  }
}
```

Update throw sites to extract `.message` only when the cause is a
real `Error`, and pass the original through `cause`:

```ts
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
// ...
throw new JitPeerConnectError(`peer_connect (${contact.label}): ${errMsg(firstErr)}`, {
  cause: firstErr,
})
```

`captureError` (and any future telemetry sink) can walk
`error.cause` to recover the full chain.

- **Pros**: Standard ES2022 pattern; preserves stack; non-invasive
  for callers (the `instanceof JitPeerConnectError` checks in
  `runJitQuoteFlow` and `Receive.tsx` still work).
- **Cons**: Requires audit of `captureError` to confirm it traverses
  `cause` (or accepts the loss for now and we improve telemetry
  later).
- **Effort**: Small (~30 minutes including audit + tests).
- **Risk**: Low.

### Option B — Leave as-is

The `peer-connection.ts` reject sites all pass `Error`, so the
flattening is acceptable. Document the assumption in a comment and
move on.

- **Pros**: Zero work.
- **Cons**: Stack loss persists; non-Error rejection still produces
  `[object Object]` if anyone ever changes peer-connection.ts to
  reject with non-Error.
- **Effort**: None.
- **Risk**: Low (current behavior).

## Recommended Action

Option A. The file is already touched in this PR; folding the cause
fix in costs ~30 minutes and aligns the JIT error hierarchy with
modern Error.cause semantics. Audit the other two `Jit*Error` types
in the same pass.

## Technical Details

- **Affected files**:
  - `src/ldk/context.tsx` (error class definitions + throw sites)
  - Possibly `src/storage/error-log.ts` (if `captureError` needs to
    learn `cause` traversal)
- **Tests**:
  - Extend `src/ldk/lsp/jit-failover.test.ts` (or add a
    `getJitQuote.test.ts`) with a test asserting
    `(thrown as JitPeerConnectError).cause === underlyingError`
  - One assertion that the message format `peer_connect (lqwd):
<msg>` and `peer_connect (lqwd, retry): <msg>` are preserved —
    these are observable to telemetry classifiers and shouldn't drift

## Acceptance Criteria

- [ ] `JitPeerConnectError` accepts and stores `cause` via the
      standard ES2022 `Error(message, { cause })` constructor
- [ ] Both throw sites in `getJitQuote` Step 0 thread `cause`
- [ ] Audit pass: `JitPaymentSizeOutOfRangeError` and
      `JitQuoteFreshnessError` either follow the same pattern or
      have a comment explaining why not
- [ ] One unit test asserting cause is preserved end-to-end
- [ ] One unit test pinning the `(${label})` vs `(${label}, retry)`
      message-suffix distinction so a future cleanup doesn't quietly
      drop the diagnostic
- [ ] `pnpm test` and `pnpm lint` pass

## Work Log

(Empty)

## Resources

- ES2022 `Error.cause`: https://tc39.es/proposal-error-cause/
- Identified during: /ce:review of in-progress LSPS2 + LQwD-port fix
  (2026-05-07)
