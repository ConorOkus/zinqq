---
status: pending
priority: p2
issue_id: '404'
tags: [code-review, agent-native, close-records, pr-172]
dependencies: []
---

# Agents can't enumerate channels in production — `__closeRecords.close/estimate/forceClose` inputs are unobtainable

## Problem Statement

`close`, `forceClose`, and `estimate` all take a `channelIdHex` an agent has no way to
discover: `__ldkNode` is DEV-only and no accessor exposes the channel list. A user can
browse Peers (balances, shutdown state) and pick a channel; an agent given "close my
channel" cannot see what exists. Sub-gap: a stalled cooperative close is visible to users
via shutdown state on Peers, but produces no record yet — so `getAll()` doesn't show the
one situation where `forceClose` is the prescribed remedy. Additionally, `getAll` omits the
tip height the detail page uses to derive confirmations and timelock countdowns.

## Findings

- agent-native-reviewer: 10/12 capabilities pass; this is the critical gap + the tip-height
  warning. Also noted: `getAll()` output contains bigint (JSON.stringify throws — the
  serializer exists at `close-record.ts:144`), close/forceClose failures return bare
  `false` with the reason only in captureError, and the needs-deposit join via
  `__recovery.getState()` is undocumented.

## Proposed Solutions

### Option A: Add read-only `listChannels()` to `__closeRecords` + tip height

Return primitives the Peers page already derives: `channelIdHex`, `counterpartyPubkey`,
`capacitySats`, `outboundCapacityMsat`, `isUsable`, `isShuttingDown`. Add
`tipHeight: getLastKnownTipHeight()` to `getAll()` items (or a `getTipHeight()`), and map
records through `serializeCloseRecord` for JSON-safety. Effort: Small. Risk: none —
read-only tier.

## Recommended Action

(Triage)

## Technical Details

- **Affected files**: `src/ldk/context.tsx` (accessor wiring), possibly a shared
  channel-summary helper reused by Peers.

## Acceptance Criteria

- [ ] An agent can go from zero knowledge → enumerate channels → estimate → close, all via
      `window.__closeRecords`
- [ ] `JSON.stringify(window.__closeRecords.getAll())` does not throw
- [ ] Stalled coop closes are detectable programmatically (isShuttingDown)

## Work Log

- 2026-07-21: Filed from /ce:review of PR #172 (agent-native-reviewer).
