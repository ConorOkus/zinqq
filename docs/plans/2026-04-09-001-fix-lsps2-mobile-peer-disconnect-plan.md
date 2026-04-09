---
title: 'fix: LSPS2 JIT payment failures from silent peer disconnect on mobile'
type: fix
status: completed
date: 2026-04-09
origin: docs/brainstorms/2026-04-09-lsps2-mobile-peer-disconnect-brainstorm.md
---

# fix: LSPS2 JIT payment failures from silent peer disconnect on mobile

## Problem

On mobile browsers, LSPS2 JIT invoice requests fail with a 30-second timeout hang. The root cause is at `src/ldk/context.tsx:258` — the `requestJitInvoice` function catches `doConnectToPeer` failures with `catch { // May already be connected, continue }` and proceeds to send LSPS2 messages to a disconnected LSP peer.

This happens because mobile browsers aggressively kill WebSocket connections when backgrounded. When the user returns and triggers a receive, the catch block swallows the connection failure and the LSPS2 request hangs until the 30s timeout.

## Proposed Solution

Replace the silent catch block with a verify-and-reconnect pattern:

1. Keep the initial `doConnectToPeer` try/catch (it may legitimately fail if already connected)
2. After the catch, verify the LSP is actually in `peerManager.list_peers()`
3. If not connected, attempt **one** fresh reconnect via `doConnectToPeer`
4. If the retry also fails, throw a descriptive error immediately

### `src/ldk/context.tsx` (requestJitInvoice, ~lines 248-261)

```typescript
// Before (broken):
try {
  const conn = await doConnectToPeer(...)
  activeConnections.current.get(lspNodeId)?.disconnect()
  activeConnections.current.set(lspNodeId, conn)
} catch {
  // May already be connected, continue
}

// After (fixed):
try {
  const conn = await doConnectToPeer(node.peerManager, lspNodeId, lspHost, lspPort, () =>
    drainEventsRef.current?.()
  )
  activeConnections.current.get(lspNodeId)?.disconnect()
  activeConnections.current.set(lspNodeId, conn)
} catch {
  // Connection attempt failed — verify LSP is actually reachable
  const lspPubkeyBytes = hexToBytes(lspNodeId)
  const isConnected = node.peerManager
    .list_peers()
    .some((p) => bytesToHex(p.get_counterparty_node_id()) === lspNodeId)

  if (!isConnected) {
    // One retry — common after mobile browser backgrounds and kills WebSocket
    const conn = await doConnectToPeer(node.peerManager, lspNodeId, lspHost, lspPort, () =>
      drainEventsRef.current?.()
    )
    activeConnections.current.get(lspNodeId)?.disconnect()
    activeConnections.current.set(lspNodeId, conn)
  }
}
```

The retry `doConnectToPeer` is **not** wrapped in try/catch — if it fails, the error propagates to the caller with a clear message ("Connection timed out" or "WebSocket connection to proxy failed") instead of a mysterious 30s LSPS2 timeout.

## Acceptance Criteria

- [x] `requestJitInvoice` verifies LSP is in `list_peers()` after failed connection attempt
- [x] If LSP not connected, one retry attempt is made
- [x] If retry fails, error propagates immediately (no 30s hang)
- [x] Existing tests still pass
- [x] Happy path (LSP already connected) behavior unchanged

## Context

- `bytesToHex` is already imported in context.tsx (from `../ldk/utils`)
- `hexToBytes` is already imported in context.tsx (from `../ldk/utils`)
- `list_peers()` returns an array of `PeerDetails` with `get_counterparty_node_id()`
- This is a PWA fundamental constraint — mobile browsers kill WebSockets on background. The fix handles the consequence rather than trying to prevent it.

## Files to Modify

- `src/ldk/context.tsx` — replace catch block in `requestJitInvoice` (~lines 248-261)

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-04-09-lsps2-mobile-peer-disconnect-brainstorm.md](docs/brainstorms/2026-04-09-lsps2-mobile-peer-disconnect-brainstorm.md) — key decisions: verify + reconnect once, minimal fix in requestJitInvoice only, no visibility handler changes
- Related: `src/ldk/peers/peer-connection.ts` — `connectToPeer` implementation
- Related: `src/ldk/lsps2/message-handler.ts:154` — `peer_disconnected` rejects pending requests
