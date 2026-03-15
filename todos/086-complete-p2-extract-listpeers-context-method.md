---
status: complete
priority: p2
issue_id: "086"
tags: [code-review, architecture, agent-native]
dependencies: []
---

# Extract listPeers() as LDK context primitive

## Problem Statement

`Peers.tsx` reaches through `ldk.node.peerManager.list_peers()` and manually hex-encodes pubkeys. This is a raw node internal, not a context-level primitive. Agents and other consumers must also navigate the raw LDK node object.

## Findings

- **File:** `src/pages/Peers.tsx`, `refreshPeers` function
- **Identified by:** agent-native-reviewer (Warning-2)

## Acceptance Criteria

- [ ] Add `listPeers(): string[]` method to `LdkContextValue` (ready state) that returns hex-encoded pubkeys
- [ ] Update `Peers.tsx` to use the context method
