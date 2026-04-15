---
status: complete
priority: p3
issue_id: '098'
tags: [code-review, architecture, agent-parity]
dependencies: []
---

# Peer disconnect not exposed through LDK context

## Problem Statement

`connectToPeer` returns `PeerConnection` with `disconnect()` but the context discards the handle after tracking it internally. No programmatic way to disconnect a specific peer without tearing down the entire LdkProvider. This is a gap in both UI features and agent-native parity.

## Findings

- **File**: `src/ldk/context.tsx:38-46`
- **Identified by**: agent-native-reviewer, architecture-strategist

## Proposed Solution

Add `disconnectPeer(pubkey: string): void` to `LdkContextValue` that looks up the connection in `activeConnections` and calls `conn.disconnect()`.
