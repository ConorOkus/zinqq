---
status: complete
priority: p3
issue_id: "090"
tags: [code-review, security, input-validation]
dependencies: []
---

# Add maxLength to address and peer input fields

## Problem Statement

The address input in Send.tsx and the peer address input in Peers.tsx have no `maxLength` attribute. Extremely long strings could cause UI lag or unexpected behavior.

## Findings

- **File:** `src/pages/Send.tsx`, address input
- **File:** `src/pages/Peers.tsx`, peer address input
- **Identified by:** security-sentinel (LOW-4)

## Acceptance Criteria

- [ ] Add `maxLength={200}` (or similar reasonable limit) to both inputs
