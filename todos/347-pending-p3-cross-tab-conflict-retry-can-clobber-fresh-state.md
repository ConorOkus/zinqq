---
status: pending
priority: p3
issue_id: '347'
tags: [code-review, vss, multi-tab, broadcastchannel, pr-157]
dependencies: []
---

# Cross-tab conflict retry can clobber a fresher tab's CM state

## Problem Statement

`src/ldk/storage/persist-cm.ts:38-44` (pre-existing, not changed in PR #157):

```ts
if (isVssConflict(err)) {
  const serverObj = await vssClient.getObject(CM_VSS_KEY)
  const correctedVersion = serverObj ? serverObj.version : 0
  versionRef.current = correctedVersion
  const newVersion = await vssClient.putObject(CM_VSS_KEY, data, correctedVersion)
  versionRef.current = newVersion
}
```

User opens wallet in two tabs. Each has its own scheduler (one per tab).

1. Tab A successfully writes CM `v5` to VSS (e.g., after claiming an HTLC →
   stored preimage in CM state).
2. Tab B's `cmVersionRef` is stale at 4. Tab B mutates its CM (different
   event), tries `putObject(B's data, 4)` → 409.
3. Conflict path runs: Tab B refetches server version (5), then writes its
   own bytes at version 5 → server now `v6`, but contents are **Tab B's CM**
   that doesn't know about Tab A's preimage.
4. Tab A's preimage write is silently overwritten on VSS.
5. If Tab A's IDB is ever cleared (private mode) or user never reopens it,
   the preimage is lost forever → funds receivable but unspendable.

Pre-existing. Not introduced by PR #157, but the new scheduler doesn't
address it either, and the inline retry's docstring undersells the danger.

## Findings

- security-sentinel P3-7.
- architecture-strategist also flagged in the context of the inline retry (#345).

## Proposed Solutions

### Option A — `BroadcastChannel`-based leader election

Only one tab is allowed to persist CM at a time; other tabs queue or fail
fast. Project memory notes a wallet-takeover BroadcastChannel already exists
(`src/ldk/context.tsx:1449-1459`) — extend that to a persist-leader.

- Pros: structurally prevents the clobber.
- Cons: bigger design; needs takeover handshake.
- Effort: Large.
- Risk: Medium.

### Option B — Detect-and-refuse

On 409, check whether this tab still holds the wallet lock. If not, refuse to
overwrite; surface "another tab is active" UX.

- Pros: smaller change.
- Cons: lock-state coupling.
- Effort: Medium.
- Risk: Low.

### Option C — Defer to mainnet GA prep

Project memory notes mainnet GA prep is upcoming (Blockstream creds flip).
This is a known-multi-tab footgun but no incident reports yet. Track for GA
gate.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/storage/persist-cm.ts`, `src/ldk/context.tsx` (BroadcastChannel)
- **Pre-existing:** yes (not introduced by PR #157)

## Acceptance Criteria

- [ ] Decision before mainnet GA on whether to ship as-is, add detect-and-refuse, or full leader election

## Work Log

_(empty)_

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/157
- Related: #345 (inline retry scope)
- Wallet-takeover code: `src/ldk/context.tsx:1449-1459`
