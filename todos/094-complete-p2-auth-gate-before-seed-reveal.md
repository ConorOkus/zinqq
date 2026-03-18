---
status: pending
priority: p2
issue_id: "094"
tags: [code-review, security, pr-14, future-feature]
dependencies: []
---

# Add authentication gate before seed phrase reveal

## Problem Statement

The `/settings/backup` page reveals the master seed phrase with only a warning screen and single tap. There is no PIN, password, or biometric gate. Anyone with momentary physical access to an unlocked browser can view and photograph the seed in seconds.

**Context**: This is a wallet-wide gap — no authentication exists anywhere in the app. This todo tracks adding auth specifically for seed reveal as a high-value target, but the auth mechanism itself is a broader architectural feature.

## Findings

- **Security Sentinel (PR #14)**: No authentication before seed reveal (CRITICAL-1). Flagged as merge blocker.
- **Counterpoint**: The wallet is currently signet-only with no auth anywhere. Adding a PIN system is a separate feature affecting the entire app. The plan explicitly accepted this gap for the current release.

## Proposed Solutions

### Option A: PIN entry before reveal
- Add a PIN setup flow (first use) and PIN entry screen before `getMnemonic()` is called
- PIN can later be reused for send confirmation and app unlock
- **Pros**: Standard wallet pattern, reusable across features
- **Cons**: Larger feature scope, needs its own design
- **Effort**: Large
- **Risk**: Medium (new state management, storage)

### Option B: Web Authentication API (biometrics)
- Use `navigator.credentials.get` with `publicKey` to gate behind device biometrics
- **Pros**: Strongest auth, no PIN to remember
- **Cons**: Not supported in all browsers, requires HTTPS
- **Effort**: Medium
- **Risk**: Medium (browser compatibility)

### Option C: Type-to-confirm speed bump
- Require user to type "REVEAL" before showing seed
- **Pros**: Trivial to implement, prevents casual access
- **Cons**: Not real security, just a speed bump
- **Effort**: Small
- **Risk**: None

## Recommended Action

Option A as a separate feature PR, with Option C as an interim measure if needed before mainnet.

## Technical Details

- **Affected files**: `src/pages/Backup.tsx`, new PIN components, wallet context
- **Prerequisite for**: Any mainnet release

## Acceptance Criteria

- [ ] User must authenticate before `getMnemonic()` is called
- [ ] Auth mechanism is reusable for other sensitive operations

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-15 | Created from PR #14 review | Security sentinel flagged as critical; accepted as follow-up for signet |

## Resources

- PR: #14
- Security Sentinel review finding CRITICAL-1
