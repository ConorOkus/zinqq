---
status: pending
priority: p2
issue_id: '107'
tags: [code-review, quality]
dependencies: []
---

# Outbound capacity computation repeated 4 times in context.tsx

## Problem Statement

`.list_usable_channels().reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)` followed by `msatToSatFloor()` appears at 4 locations in `src/ldk/context.tsx` (lines ~284, ~374, ~416, ~481).

## Proposed Solution

Extract a local helper:
```typescript
function getOutboundCapacitySats(cm: ChannelManager): bigint {
  const msat = cm.list_usable_channels().reduce((sum, ch) => sum + ch.get_outbound_capacity_msat(), 0n)
  return msatToSatFloor(msat)
}
```

- **Effort**: Small (~8 LOC saved)

## Acceptance Criteria

- [ ] Single helper function for outbound capacity computation
- [ ] All 4 call sites use the helper
