---
status: complete
priority: p3
issue_id: "093"
tags: [code-review, security, pr-14]
dependencies: []
---

# Sanitize error messages on Backup page

## Problem Statement

The Backup page passes raw `err.message` from IndexedDB failures directly to the UI. This could leak storage structure details.

## Findings

- **Security Sentinel (PR #14)**: Raw error messages from IndexedDB surfaced to UI (MEDIUM-3).
- **Location**: `src/pages/Backup.tsx` lines 29-31

## Proposed Solutions

### Option A: Generic user-facing message (Recommended)
- Always show "Unable to retrieve your seed phrase. Please restart the app and try again."
- Log detailed error to `console.error` for debugging
- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] User sees a generic error message, not raw IndexedDB errors
- [ ] Detailed error logged to console

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-15 | Created from PR #14 review | Security sentinel flagged info disclosure |

## Resources

- PR: #14
