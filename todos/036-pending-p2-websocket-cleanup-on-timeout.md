---
status: complete
priority: p2
issue_id: "036"
tags: [code-review, reliability]
dependencies: []
---

# WebSocket resource cleanup on timeout and provider teardown

## Problem Statement

1. Connection timeout calls `ws.close()` but not `peerManager.socket_disconnected(descriptor)` — relies on async `onclose`
2. Provider unmount cleanup doesn't disconnect existing peers or close WebSockets

## Findings

- **Source:** Security Sentinel (Finding 3, 6)
- **Location:** `src/ldk/peers/peer-connection.ts` timeout handler, `src/ldk/context.tsx` cleanup

## Acceptance Criteria

- [ ] Timeout handler calls `socket_disconnected` when descriptor is non-null
- [ ] Provider cleanup disconnects peers

## Work Log

| Date | Action | Details |
|------|--------|---------|
| 2026-03-12 | Created | From PR #4 code review |
