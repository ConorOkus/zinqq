---
status: cancelled
priority: p2
issue_id: '262'
tags: [code-review, payjoin, telemetry]
dependencies: []
---

# Initial POST timeout misclassified as `backgrounded`

## Problem Statement

`payjoin.ts:208` for the initial POST does NOT distinguish `timeout` from `backgrounded`:

```ts
if (composed.signal.aborted) {
  throw new PayjoinFallback('backgrounded', 'aborted during initial POST')
}
```

The poll loop at line 235 correctly does:

```ts
ctx.signal.aborted ? 'backgrounded' : 'timeout'
```

If the composed (45s session ceiling) timer fires _during_ the initial POST — rare but possible if PDK is slow to construct the request, or if the relay holds the connection — it gets misclassified as `backgrounded` even though the parent never aborted.

## Findings

- **kieran-typescript-reviewer P2 #7**: same logic should apply to both POST and poll paths.

## Proposed Solutions

### Option 1 — Apply the same discrimination

```ts
if (composed.signal.aborted) {
  throw new PayjoinFallback(
    ctx.signal.aborted ? 'backgrounded' : 'timeout',
    'aborted during initial POST'
  )
}
```

One-line fix.

- Pros: telemetry accuracy; matches the poll-loop behavior.
- Cons: the user-visible bucketing (per todo #257 it's all `fallback_transient` anyway) is unchanged. Mostly a debug-clarity fix.

## Recommended Action

Option 1. Apply now while in the area.

## Technical Details

- Affected file: `src/onchain/payjoin/payjoin.ts:207-210`

## Acceptance Criteria

- [ ] Initial POST timeout reports `timeout` reason
- [ ] Initial POST user-abort reports `backgrounded` reason

## Work Log

## Resources

- PR #143

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
