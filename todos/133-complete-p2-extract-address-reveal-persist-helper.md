---
status: pending
priority: p2
issue_id: "133"
tags: [code-review, quality]
---

# Extract duplicated address-reveal + persist changeset pattern

## Problem Statement

The same 8-line sequence (next_unused_address → take_staged → is_empty check → putChangeset) is copy-pasted in two places in event-handler.ts. If one copy is updated without the other, fund-safety logic diverges silently.

## Findings

- Flagged by Simplicity reviewer
- `src/ldk/traits/event-handler.ts` lines 113-120 (setBdkWallet startup sweep)
- `src/ldk/traits/event-handler.ts` lines 291-298 (SpendableOutputs handler)
- Identical logic, identical error handling

## Proposed Solutions

### Option A: Extract helper function
```typescript
function revealAddressScript(wallet: Wallet): Uint8Array {
  const addressInfo = wallet.next_unused_address('external')
  const staged = wallet.take_staged()
  if (staged && !staged.is_empty()) {
    void putChangeset(staged.to_json()).catch(...)
  }
  return addressInfo.address.script_pubkey.as_bytes()
}
```
- Pros: Single source of truth, ~10 LOC saved
- Cons: Minor indirection
- Effort: Small

## Technical Details

- **Affected files:** `src/ldk/traits/event-handler.ts`
- Note: This is also tracked in `todos/106-pending-p2-extract-address-reveal-persist-helper.md`

## Acceptance Criteria

- [ ] Both call sites use the same helper
- [ ] Tests pass
