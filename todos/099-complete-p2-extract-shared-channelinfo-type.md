---
status: pending
priority: p2
issue_id: '099'
tags: [code-review, architecture, typescript]
dependencies: []
---

# Duplicate diverging ChannelInfo interfaces

## Problem Statement

`Peers.tsx` and `CloseChannel.tsx` both define separate `ChannelInfo` interfaces with overlapping but inconsistent fields. `Peers` uses `outboundMsat`/`inboundMsat` while `CloseChannel` uses `outboundCapacityMsat`/`inboundCapacityMsat`. As more channel operations are added, these will drift further apart.

## Findings

- **File**: `src/pages/Peers.tsx:10-19`, `src/pages/CloseChannel.tsx:10-20`
- **Identified by**: kieran-typescript-reviewer, code-simplicity-reviewer, architecture-strategist
- **Known Pattern**: See `docs/solutions/integration-issues/ldk-wasm-write-vs-direct-uint8array.md` for LDK type patterns

## Proposed Solutions

### Option A: Extract shared type to `src/types/channel.ts`
Create a `ChannelSummary` type with the serializable fields (hex strings, bigints, booleans). CloseChannel extends it with the non-serializable `channelId: ChannelId`. Standardize on `outboundCapacityMsat`/`inboundCapacityMsat` naming to match LDK API.

- **Pros**: Single source of truth, naming consistency
- **Cons**: New file
- **Effort**: Small
- **Risk**: Low

### Option B: Use `Omit` from CloseChannel's type
Define the full type in CloseChannel and import `Omit<ChannelInfo, 'channelId'>` in Peers.

- **Pros**: No new file
- **Cons**: Creates a dependency from Peers -> CloseChannel
- **Effort**: Small
- **Risk**: Low

## Technical Details

- **Affected files**: `src/pages/Peers.tsx`, `src/pages/CloseChannel.tsx`
- Also remove `counterpartyNodeId: Uint8Array` from Peers' ChannelInfo (unused in Peers rendering, only hex string is passed via route state)

## Acceptance Criteria

- [ ] Single shared channel type definition
- [ ] Consistent field naming matching LDK API (`outboundCapacityMsat`/`inboundCapacityMsat`)
- [ ] `counterpartyNodeId: Uint8Array` removed from Peers' interface
- [ ] TypeScript compiles with no errors
