---
status: complete
priority: p3
issue_id: '201'
tags: [code-review, simplification, receive]
---

# Simplify redundant showBolt12 && bolt12Uri guard

## Problem Statement

The condition `showBolt12 && bolt12Uri` appears twice in Receive.tsx JSX. Since `showBolt12` requires `bolt12Offer` to be truthy, and `bolt12Uri` is derived from `bolt12Offer` via `buildBip321Uri({ lno: bolt12Offer })` which always returns a non-empty string, `bolt12Uri` is guaranteed truthy whenever `showBolt12` is true. The `&& bolt12Uri` check is redundant.

## Proposed Solutions

### Solution 1: Replace with just `showBolt12` (Recommended)

Change both instances of `showBolt12 && bolt12Uri` to just `showBolt12`.

- **Effort**: Small

## Acceptance Criteria

- [ ] Redundant `&& bolt12Uri` checks removed
