---
status: pending
priority: p3
issue_id: '362'
tags: [code-review, architecture, lsp, fix-lqwd-channel-acceptance]
dependencies: []
---

# Per-LSP capability matrix on `LspContact` (instead of relaxing global `UserConfig`)

## Problem Statement

`UserConfig` (`init.ts createUserConfig()`) is a single global passed to `ChannelManager`. Two trusted LSPs with divergent capabilities now share one config:

| LSP | Anchors? | Announce flag |
|-----|----------|---------------|
| Megalith | Yes (PR #100, #102) | unannounced |
| LQwD | No (this branch) | divergent (this branch) |

This branch makes the config the loosest common denominator: announce check disabled, both feerate floors at 253. Adding a *third* LSP with different requirements pushes the config looser still — eventually the global config provides no validation at all.

The healthier model is per-LSP capability metadata, consulted before we add the LSP to `trustedLspIds` and used to decline LSPs that don't meet a minimum bar.

## Findings

- architecture-strategist P3

## Proposed Solutions

**Extend `LspContact`** (`src/ldk/lsp/contacts.ts`) with a capability struct:

```ts
type LspCapabilities = {
  supportsAnchors: boolean    // option_anchors_zero_fee_htlc_tx
  channelsAreAnnounced: boolean
  minProposedFeerateSatKw: number  // observed lower bound
}

type LspContact = {
  // existing fields
  capabilities: LspCapabilities
}
```

**Use it at trust-set add time** in `src/ldk/context.tsx`:

```ts
const lqwd = await fetchLqwdContact()
if (!meetsMinimumBar(lqwd.capabilities)) {
  console.warn('[LSP] LQwD does not meet capability bar; skipping trust-set add')
  return
}
trustedLspIds.add(lqwd.nodeId)
```

`meetsMinimumBar` could require, e.g., `supportsAnchors` for any *new* LSP added to the trust set going forward, while grandfathering LQwD via explicit override.

- Pros: Codifies the LSP compatibility matrix surfaced by learnings-researcher.
- Pros: Future LSPs can't silently regress safety.
- Cons: Touches the LSP discovery / failover code paths.
- Effort: Medium.
- Risk: Low — additive.

## Recommended Action

(filled during triage)

## Technical Details

- **Affected files:** `src/ldk/lsp/contacts.ts`, `src/ldk/context.tsx`, possibly `src/ldk/lsp/jit-failover.ts`

## Acceptance Criteria

- [ ] `LspContact` carries explicit capability metadata
- [ ] LSP discovery rejects LSPs that don't meet the bar (with grandfathered exceptions for LQwD)
- [ ] Tests cover both passing and failing capability checks

## Work Log

_(empty)_

## Resources

- Branch: `fix/lqwd-channel-acceptance`
- learnings-researcher pattern: "single LSP compatibility matrix keyed by LSP name"
- Related solutions: `docs/solutions/integration-issues/anchor-channels-lsp-compatibility.md`, `lsps2-lqwd-primary-unreachable-proxy-and-duplicate-connect.md`
