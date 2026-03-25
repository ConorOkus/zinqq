---
status: complete
priority: p2
issue_id: '172'
tags: [feature, vss, recovery]
dependencies: []
---

# Persist known peers to VSS for recovery

## Problem Statement

After recovering channel state from VSS on a new device, the app has channels but no peer addresses. The counterparty node ID is in the recovered ChannelMonitor, but the network address (host:port) needed to reconnect is only stored in `ldk_known_peers` in IDB — it's not persisted to VSS.

This means recovered channels remain `usable=0` until the peer happens to connect to us or the user manually re-adds the peer.

## Findings

- Discovered during manual testing of VSS recovery (PR #37)
- `ldk_known_peers` is an IDB-only store, not included in VSS migration or recovery
- The reconnection logic in `context.tsx` reads from `ldk_known_peers` to find addresses for disconnected channel peers

## Acceptance Criteria

- [ ] Known peers (node ID + address) are persisted to VSS alongside channel state
- [ ] Recovery downloads known peers from VSS and writes them to IDB
- [ ] After recovery, automatic peer reconnection works without manual intervention
