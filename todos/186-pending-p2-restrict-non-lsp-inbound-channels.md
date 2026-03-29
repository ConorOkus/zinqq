---
status: pending
priority: p2
issue_id: '186'
tags: [code-review, security, lsps2]
---

# Restrict non-LSP inbound channel acceptance

## Problem Statement

The updated event handler now accepts ALL inbound channel requests (with standard confirmations for non-LSP peers). Previously these were ignored. This opens the wallet to channel griefing, UTXO bloat from force-closes, and liquidity fragmentation from unknown peers.

## Findings

- Security sentinel: HIGH - unconditional acceptance enables griefing attacks
- Previous behavior was safer (ignore all inbound)

## Proposed Solutions

1. Only accept from LSP, reject all others (simplest, most restrictive)
2. Accept from known peers only (peers in known_peers list)
3. Rate limit non-LSP inbound to max 3/hour

## Technical Details

- **Affected files:** `src/ldk/traits/event-handler.ts`
- **Effort:** Small

## Acceptance Criteria

- [ ] Non-LSP inbound channels have a clear acceptance policy
- [ ] Policy is documented in code comment
- [ ] Griefing attack surface is bounded

## Resources

- PR: https://github.com/ConorOkus/zinqq/pull/60
