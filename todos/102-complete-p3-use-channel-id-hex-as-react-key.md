---
status: pending
priority: p3
issue_id: '102'
tags: [code-review, quality]
dependencies: []
---

# Channel list uses array index as React key

## Problem Statement

In `Peers.tsx`, channel rows use array index (`i`) as the React key. The `channelIdHex` is a stable unique identifier that should be used instead.

## Findings

- **File**: `src/pages/Peers.tsx:257` — `{peer.channels.map((ch, i) => (<div key={i} ...>`)
- **Identified by**: kieran-typescript-reviewer

## Proposed Solution

Change `key={i}` to `key={ch.channelIdHex}`.

- **Effort**: Trivial (1 line)
- **Risk**: None

## Acceptance Criteria

- [ ] Channel rows keyed by `channelIdHex` instead of array index
