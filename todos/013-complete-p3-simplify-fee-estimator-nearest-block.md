---
status: complete
priority: p3
issue_id: "013"
tags: [code-review, quality, simplification]
dependencies: []
---

# Fee estimator nearest-block fallback is over-engineered

## Problem Statement

`src/ldk/traits/fee-estimator.ts` lines 84-93 has a nearest-block search loop that hunts for the closest block target when the exact one is missing. Esplora returns estimates for blocks 1-25+, and the targets used (1, 6, 12, 144) will nearly always hit directly. The loop adds ~10 lines of complexity for marginal accuracy gain on signet.

## Acceptance Criteria

- [ ] Replace nearest-block search with simple direct lookup + default fallback
- [ ] Remove `FeeCache` interface, use plain closure variables
