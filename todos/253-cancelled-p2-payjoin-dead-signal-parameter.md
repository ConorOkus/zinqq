---
status: cancelled
priority: p2
issue_id: '253'
tags: [code-review, payjoin, architecture, yagni]
dependencies: []
---

# Dead `signal` parameter on `buildSignBroadcast`

## Problem Statement

`context.tsx:190` adds an optional 4th parameter `signal?: AbortSignal` to `buildSignBroadcast`. It is used at line 213 to fall back to `new AbortController().signal` (a never-aborted signal) when the caller doesn't pass one. **No caller passes one** — `sendToAddress` (`context.tsx:330-368`) doesn't accept or forward a signal, and `Send.tsx` instead builds its own `payjoinAbort` and composes it inside the `transformPsbt` closure (`Send.tsx:622-635`), bypassing this parameter entirely.

## Findings

- **kieran-typescript-reviewer P1 #5**: dead code dressed as defense-in-depth. The fallback `new AbortController().signal` is worse than no signal — it teaches hooks to treat `ctx.signal` as a real abort source when it isn't.
- **architecture-strategist #2**: two paths to abort the same operation — future readers won't know which is authoritative.
- **code-simplicity-reviewer #7**: 5 LOC saved with simpler interface.

## Proposed Solutions

### Option 1 (recommended) — Drop the parameter

Remove `signal?: AbortSignal` from `buildSignBroadcast` and from the `signal` field on the `transformPsbt` ctx object. The hook can capture whatever it needs via closure (which `Send.tsx` already does correctly).

- Pros: single source of truth for abort plumbing; no misleading API.
- Cons: hook authors who don't capture get no signal.

### Option 2 — Plumb end-to-end

Add `signal?: AbortSignal` to `sendToAddress` and `OnchainContextValue.sendToAddress`; pass from `Send.tsx` directly. Stop composing inside the closure.

- Pros: cleaner architecture (signal is part of the contract).
- Cons: more API surface change; touches `OnchainContextValue` type.

## Recommended Action

Option 1. The simplification reviewer's instinct lines up — closure capture is already the working pattern and is enough.

## Technical Details

- Affected file: `src/onchain/context.tsx:190, 213`
- Type: `src/onchain/onchain-context.ts` — `TransformPsbtHook`'s `ctx` type (drop `signal`)
- Caller: `src/pages/Send.tsx:622-635` — closure already provides the real signal

## Acceptance Criteria

- [ ] `buildSignBroadcast` signature is `(buildPsbt, feeRateSatVb?, transformPsbt?)`
- [ ] `TransformPsbtHook` ctx type no longer includes `signal`
- [ ] Send.tsx still aborts on visibility/beforeunload via closure capture
- [ ] All payjoin tests pass

## Work Log

## Resources

- PR #143

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
