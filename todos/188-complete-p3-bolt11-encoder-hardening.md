---
status: complete
priority: p3
issue_id: '188'
tags: [code-review, quality, lsps2]
---

# BOLT11 encoder minor hardening

## Problem Statement

Several minor improvements identified across reviewers for the custom BOLT11 encoder.

## Findings

- Tagged field length overflow: `addTaggedField` accepts data > 1023 words without error (max is 10-bit length)
- Hardcoded signet prefix: should be parameterized for future network support
- Receive page: `processingRef` not reset in useEffect cleanup, causing missed re-triggers on amount change
- `needsJitChannel` as useEffect dependency causes double-fire (already guarded by processingRef)

## Proposed Solutions

1. Add `if (len > 1023) throw` bounds check in `addTaggedField`
2. Pass network prefix as parameter to `encodeBolt11Invoice`
3. Reset `processingRef.current = false` in useEffect cleanup
4. Inline `needsJitChannel` check in effect body

## Technical Details

- **Affected files:** `src/ldk/lsps2/bolt11-encoder.ts`, `src/pages/Receive.tsx`
- **Effort:** Small

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/60
