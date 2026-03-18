---
status: pending
priority: p2
issue_id: '100'
tags: [code-review, security, validation]
dependencies: []
---

# No validation of route state inputs before LDK calls

## Problem Statement

`OpenChannel.tsx` reads `peerPubkey` from route state and passes it to `hexToBytes()` then `ldk.createChannel()` with only a truthiness check. No format validation (66-char lowercase hex for compressed secp256k1 pubkey). Similarly, `CloseChannel.tsx` reads `channelIdHex` and `counterpartyPubkey` without format validation. In a Bitcoin wallet, defense-in-depth demands validating before values reach the cryptographic layer.

## Findings

- **File**: `src/pages/OpenChannel.tsx:31,120`, `src/pages/CloseChannel.tsx:38,55`
- **Identified by**: security-sentinel, kieran-typescript-reviewer
- **Reference**: `src/ldk/peers/peer-connection.ts` already has proper pubkey validation via `parsePeerAddress()` with `/^[0-9a-f]{66}$/`

## Proposed Solutions

### Option A: Add inline regex validation after route state read
Validate `peerPubkey` with `/^[0-9a-f]{66}$/` and `channelIdHex` with `/^[0-9a-f]+$/` immediately after reading from route state. Redirect to Peers on invalid.

- **Pros**: Simple, self-contained, matches existing `parsePeerAddress` pattern
- **Cons**: Regex duplicated across files
- **Effort**: Small
- **Risk**: Low

### Option B: Type guard functions with runtime validation
Create `parseOpenChannelState(state: unknown)` and `parseCloseChannelState(state: unknown)` functions that return typed objects or null. Replaces the `as` casts with proper runtime validation.

- **Pros**: Type-safe, eliminates `as` casts, reusable
- **Cons**: Slightly more code
- **Effort**: Small
- **Risk**: Low

## Technical Details

- **Affected files**: `src/pages/OpenChannel.tsx`, `src/pages/CloseChannel.tsx`

## Acceptance Criteria

- [ ] `peerPubkey` validated as 66-char lowercase hex before any LDK call
- [ ] `channelIdHex` validated as valid hex string before channel lookup
- [ ] Invalid route state redirects to Peers screen
- [ ] No `as` type assertions on `location.state`
