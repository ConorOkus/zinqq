---
status: pending
priority: p3
issue_id: '323'
tags: [code-review, tests, observability, lsps2]
dependencies: ['321']
---

# Pin `JitPeerConnectError` message suffix `(label)` vs `(label, retry)` with a unit test

## Problem Statement

`getJitQuote` in `src/ldk/context.tsx` throws `JitPeerConnectError`
with two distinct message suffixes depending on which connect
attempt failed:

- First attempt: `peer_connect (${contact.label}): ${err}`
- Retry (only when `opts.retryConnectOnce`): `peer_connect
(${contact.label}, retry): ${err}`

These suffixes are the only observable difference between
"primary-failed-no-retry" and "retry-also-failed" in the telemetry
stream. Any future cleanup that flattens the two throw sites into
one helper (kieran-typescript-reviewer suggested exactly this in
the /ce:review pass — see `ensureLspPeer` extraction proposal)
risks silently dropping the `, retry` suffix and erasing the
distinction.

There is currently no test pinning this contract.

## Findings

- Identified by: kieran-typescript-reviewer during /ce:review of
  LSPS2 fix (2026-05-07)
- Severity P3: defensive test, no behavior change, no current bug.
  Locks in a small but real diagnostic invariant for future
  refactors.

## Proposed Solutions

### Option A — Add a unit test in `getJitQuote` test file (recommended)

There is no dedicated test file for `getJitQuote` today (only
`jit-failover.test.ts` which mocks the `attempt` arg and never
exercises the inner connect path). Add a focused test:

- Mock `connect` to reject twice with a synthetic error
- Mock `peer_manager.list_peers()` to return empty (so the
  pre-check fails through to connect)
- Call `getJitQuote(..., opts: { retryConnectOnce: true }, signal)`
- Assert thrown error is `JitPeerConnectError` and `.message`
  contains `(${label}, retry):`
- Repeat with `retryConnectOnce: false` and `connect` rejecting once
- Assert thrown error message contains `(${label}):` and does NOT
  contain `, retry`

- **Pros**: Pins the diagnostic contract. Cheap to write.
- **Cons**: New test file (or extends an existing one); requires
  fakes for `node`, `peerManager`, `lsps2Client`, `connect`.
- **Effort**: Small (~45 minutes).
- **Risk**: None.

### Option B — Add to `jit-failover.test.ts` via the existing seam

The existing failover test passes a stub `attempt` that bypasses
`getJitQuote` entirely. Extending it to test message suffixes
would require restructuring — wrong tool for this job.

- **Effort**: Medium.
- **Risk**: Low.
- Not recommended.

### Option C — Skip the test

Rely on reviewers to catch any future suffix drift.

- **Pros**: Zero work.
- **Cons**: Silent regression risk.
- Not recommended.

## Recommended Action

Option A. If todo 321 (Error.cause threading) lands first, fold
this test into the same test file at the same time.

## Technical Details

- **Affected files**:
  - New: `src/ldk/get-jit-quote.test.ts` (or fold into
    `jit-failover.test.ts` with a new describe block — pick whichever
    fits the existing convention)
- **Test fakes needed**: `node` with `peerManager.list_peers()`
  returning configurable array; `connect` as `vi.fn` rejecting on
  call N; `lsps2Client.getOpeningFeeParams` not exercised since
  connect path fails first

## Acceptance Criteria

- [ ] Test exercises the no-retry path and asserts error message
      ends with `(${label}):`
- [ ] Test exercises the retry path and asserts error message
      ends with `(${label}, retry):`
- [ ] Tests still pass if implementation is unchanged
- [ ] Tests fail if a future refactor merges the two throw sites
      and drops the `, retry` suffix
- [ ] `pnpm test` passes

## Work Log

(Empty)

## Resources

- Sibling: `todos/321-pending-p2-jit-peer-connect-error-loses-cause.md`
  (likely landing together)
- Identified during: /ce:review of in-progress LSPS2 + LQwD-port
  fix (2026-05-07)
