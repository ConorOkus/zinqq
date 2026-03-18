---
status: complete
priority: p3
issue_id: "078"
tags: [code-review, performance, architecture]
dependencies: []
---

# Broadcaster lacks in-flight deduplication — overlapping retry chains under Esplora outage

## Problem Statement

`rebroadcast_pending_claims()` fires every 30 seconds. Each invocation spawns a new `broadcastWithRetry` chain per transaction (up to 31 seconds total retry time). Under sustained Esplora outage, overlapping retry chains accumulate unboundedly. Each chain holds timers and fetch promises. The "txn-already-known" short-circuit handles duplicates safely, but the resource leak is a concern.

## Findings

- **Identified by:** architecture-strategist (Risk 1)
- Solution: Add a `Set<string>` of in-flight txHex values to skip duplicates

## Acceptance Criteria

- [ ] `broadcastWithRetry` skips if txHex is already in-flight
- [ ] In-flight set is cleaned up in finally block
