---
status: complete
priority: p2
issue_id: "091"
tags: [code-review, security, pr-14]
dependencies: []
---

# Auto-hide mnemonic after reveal + hide on tab blur

## Problem Statement

Once the seed phrase is revealed on the Backup page, the 12 words persist in React state and DOM indefinitely until the user navigates away. This increases the exposure window for shoulder surfing, extensions reading DOM content, or screenshots.

## Findings

- **Security Sentinel (PR #14)**: Mnemonic persists in React state with no cleanup, no timeout, and no "hide" button (HIGH-1). No `visibilitychange` listener to hide words when tab loses focus (MEDIUM-1).
- **Location**: `src/pages/Backup.tsx` line 26 — `setState({ status: 'revealed', words: mnemonic.split(' ') })`

## Proposed Solutions

### Option A: Auto-hide timer + visibilitychange listener (Recommended)
- Add 60-second auto-hide timer that resets state to `warning`
- Add `visibilitychange` listener that hides words when tab loses focus
- Add explicit "Hide" button below the word grid
- **Pros**: Low effort, meaningful risk reduction
- **Cons**: Timer may annoy users writing down words slowly
- **Effort**: Small
- **Risk**: Low

### Option B: Timer only
- Just the 60-second auto-hide, no visibility listener
- **Pros**: Simplest change
- **Cons**: Misses tab-switch scenario
- **Effort**: Small
- **Risk**: Low

## Recommended Action

Option A

## Technical Details

- **Affected files**: `src/pages/Backup.tsx`
- **Components**: Backup page `revealed` state

## Acceptance Criteria

- [ ] Mnemonic auto-hides after 60 seconds, returning to warning state
- [ ] Mnemonic hides when tab loses focus (`visibilitychange`)
- [ ] "Hide" button is available below the word grid
- [ ] Tests cover auto-hide behavior

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-15 | Created from PR #14 review | Security sentinel flagged indefinite DOM exposure |

## Resources

- PR: #14
- Security Sentinel review finding HIGH-1, MEDIUM-1
