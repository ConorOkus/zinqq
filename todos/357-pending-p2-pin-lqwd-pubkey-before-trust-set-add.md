---
status: pending
priority: p2
issue_id: '357'
tags: [code-review, security, lsp, lqwd, fix-lqwd-channel-acceptance]
dependencies: []
---

# Pin LQwD pubkey (or allowlist) before adding to `trustedLspIds`

## Problem Statement

`src/ldk/context.tsx:938-950` adds whatever pubkey `fetchLqwdContact()` returns to `LdkNode.trustedLspIds`. The discovery path is:

- Browser → `/api/lqwd/get_info` (same-origin Vercel proxy, hardcoded upstream — low MITM risk)
- Proxy → `https://germany.lqwd.tech/api/v1/get_info`
- `lqwd-discovery.ts:25` accepts any 66-hex-char pubkey via regex; no signature, no allowlist, no pinning.

If the upstream `/get_info` endpoint is ever compromised (or the proxy mis-routed), an attacker-controlled pubkey lands in `trustedLspIds`. Because this PR relaxes both the announcement-flag check (`init.ts:163`) and the non-anchor remote feerate floor (`fee-estimator.ts:22`), the **consequence** of a malicious "LQwD" pubkey is now strictly larger:

- It can open 0-conf channels with low pre-signed commitment fees that would previously have been rejected at the feerate gate as defense-in-depth.
- It can choose any announcement preference without LDK objecting.

This is a pre-existing weakness (introduced in PR #148), but this branch amplifies the blast radius.

## Findings

- security-sentinel P2-1

## Proposed Solutions

**Option A — Hardcoded pubkey allowlist**

Add `KNOWN_LQWD_PUBKEYS: ReadonlySet<string>` in `src/ldk/lsp/lqwd-discovery.ts` containing the LQwD pubkey we shipped with PR #148 (`032c9c7648e471befa2dc2d093e0854dd138f2718c0ad93bd4411328b33d072918`). Reject discovery responses whose `nodeId` isn't in the set.

- Pros: Strongest guarantee; matches how Megalith is bootstrapped (env-pinned).
- Cons: Pubkey rotations require a release. Acceptable — LSP pubkey rotations are extremely rare events.
- Effort: Small.
- Risk: A legitimate pubkey rotation by LQwD would temporarily fall back to Megalith until we ship a release.

**Option B — Pin via env var**

Add `LDK_LQWD_PUBKEY_PINS` (comma-separated allowlist) parallel to the existing Megalith env vars. Cross-check `fetchLqwdContact()`'s `nodeId` against the pin list before `trustedLspIds.add`.

- Pros: Rotates without a release; same pattern as Megalith.
- Cons: One more env var to manage on Vercel.
- Effort: Small.
- Risk: Low.

**Option C — Sign discovery responses**

Out of scope for now (requires LQwD-side cooperation).

## Recommended Action

(filled during triage — Option B is most consistent with Megalith's bootstrap)

## Technical Details

- **Affected files:** `src/ldk/lsp/lqwd-discovery.ts`, `src/ldk/context.tsx:938-950`, env config

## Acceptance Criteria

- [ ] `fetchLqwdContact()` returns null (or throws) when the upstream `nodeId` isn't in the pin list
- [ ] LQwD failover to Megalith verified when discovery is rejected
- [ ] Test covers a malicious-pubkey response

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- LQwD reference: `~/.claude/projects/-Users-conor-Projects-zinq/memory/reference_lqwd_lsp.md`
- Original LQwD discovery PR: #148
- Possibly related: existing todo #291 (referenced in `context.tsx:942`)
