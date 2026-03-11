---
status: pending
priority: p3
issue_id: "016"
tags: [code-review, architecture, agent-native]
dependencies: []
---

# LDK node lifecycle locked behind React Context

## Problem Statement

The `LdkNode` instance is only accessible via React Context (`useLdk()` hook). No headless/programmatic entry point exists for agents, service workers, tests, or CLI tools to access the running node. As features are added, this creates an agent-parity gap where wallet actions are only available through UI event handlers.

## Acceptance Criteria

- [ ] `NodeManager` singleton (or similar) owns LdkNode lifecycle
- [ ] React context consumes NodeManager rather than owning the instance
- [ ] Non-React consumers can call `getOrInitNode()` / `getNode()`
