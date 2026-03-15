---
title: "feat: Automatic Peer Reconnection on Restart"
type: feat
status: completed
date: 2026-03-15
---

# feat: Automatic Peer Reconnection on Restart

## Overview

Persist known peer addresses in IndexedDB and automatically reconnect to them when the wallet restarts. Currently, all peer connections are lost on page refresh and must be manually re-entered via the `pubkey@host:port` form. This is a key UX gap — especially once channels are open, since the wallet cannot route payments without an active connection to the channel counterparty.

This feature was explicitly deferred as out-of-scope in the peer connectivity brainstorm (see `docs/brainstorms/2026-03-12-peer-connectivity-brainstorm.md`, "Out of scope" section).

## Problem Statement / Motivation

- **Channel usability:** Once a channel is open, the wallet needs an active connection to the counterparty to send/receive payments. Without auto-reconnect, every restart requires the user to remember and re-enter peer addresses.
- **User friction:** Lightning peer addresses are 66+ character strings — re-entering them manually is error-prone and tedious.
- **Expected behavior:** Every Lightning wallet (mobile, desktop, server) auto-reconnects to known peers. A browser wallet should match this expectation.

## Proposed Solution

1. **New IndexedDB store** (`ldk_known_peers`) to persist peer addresses keyed by pubkey
2. **Save on connect** — every successful peer connection upserts `{host, port}` into the store
3. **Reconnect on startup** — after LDK init, read all known peers and attempt parallel reconnection (fire-and-forget, non-blocking)
4. **Forget peer** — allow users to remove a peer from the known peers store, with a safety check for open channels

### Data Model

- **Store:** `ldk_known_peers`
- **Key:** pubkey hex string (66 chars) — provides natural deduplication and address updates
- **Value:** `{ host: string, port: number }`

Using pubkey as the key means reconnecting to the same peer from a new address automatically updates the stored address.

## Technical Considerations

### IndexedDB Migration (idb.ts)

- Bump `DB_VERSION` from `3` to `4`
- Add `'ldk_known_peers'` to the `STORES` array — the existing `onupgradeneeded` handler auto-creates missing stores, so no migration code is needed
- Add `'ldk_known_peers'` to the LDK stores clear list so that a future seed/mnemonic migration doesn't leave orphaned peer entries from an old node identity

### Storage Accessor (new file: `src/ldk/storage/known-peers.ts`)

Follow the existing pattern in `storage/seed.ts` and `onchain/storage/changeset.ts`:

```typescript
// src/ldk/storage/known-peers.ts
import { idbGet, idbGetAll, idbPut, idbDelete } from './idb'

export interface KnownPeer {
  host: string
  port: number
}

export async function getKnownPeers(): Promise<Map<string, KnownPeer>> {
  return idbGetAll<KnownPeer>('ldk_known_peers')
}

export async function putKnownPeer(pubkey: string, host: string, port: number): Promise<void> {
  await idbPut('ldk_known_peers', pubkey, { host, port })
}

export async function deleteKnownPeer(pubkey: string): Promise<void> {
  await idbDelete('ldk_known_peers', pubkey)
}
```

### Reconnection Logic (context.tsx)

Place reconnection **after** `setState({status: 'ready'})` — the wallet is usable immediately while peers reconnect in the background. Use `Promise.allSettled` so one offline peer doesn't block others.

```typescript
// In LdkProvider, after setting state to 'ready':
getKnownPeers().then(async (peers) => {
  if (peers.size === 0) return
  console.log(`[ldk] reconnecting to ${peers.size} known peer(s)`)
  const results = await Promise.allSettled(
    Array.from(peers.entries()).map(([pubkey, { host, port }]) =>
      connectToPeer(node.peerManager, pubkey, host, port)
    )
  )
  const succeeded = results.filter(r => r.status === 'fulfilled').length
  const failed = results.filter(r => r.status === 'rejected').length
  console.log(`[ldk] peer reconnection: ${succeeded} connected, ${failed} failed`)
}).catch((err) => {
  // IDB read failure should never prevent wallet from working
  console.warn('[ldk] failed to read known peers:', err)
})
```

### Save on Connect (context.tsx)

Wrap the existing `connectToPeer` callback to persist after success:

```typescript
const handleConnectToPeer = useCallback(async (pubkey: string, host: string, port: number) => {
  const node = nodeRef.current
  if (!node) throw new Error('LDK not initialized')
  await connectToPeer(node.peerManager, pubkey, host, port)
  // Persist for auto-reconnect — fire-and-forget, don't fail the connection on IDB error
  putKnownPeer(pubkey, host, port).catch((err) =>
    console.warn('[ldk] failed to persist known peer:', err)
  )
}, [])
```

### Forget Peer — Channel Safety Check

Before removing a known peer, check if any open channels exist with that counterparty:

```typescript
const forgetPeer = useCallback(async (pubkey: string) => {
  const node = nodeRef.current
  if (!node) throw new Error('LDK not initialized')

  // Check for open channels with this peer
  const channels = node.channelManager.list_channels()
  const hasChannels = channels.some(ch => {
    const counterparty = bytesToHex(ch.get_counterparty().get_node_id().write())
    return counterparty === pubkey
  })

  if (hasChannels) {
    throw new Error('Cannot forget peer with open channels')
  }

  await deleteKnownPeer(pubkey)
}, [])
```

The UI layer should catch this error and display a warning to the user.

### Peers Page UI Updates (Peers.tsx)

The current Peers page only shows live connected peers. With persistence, the page should show **all known peers** with their connection status:

- **Connected** — green indicator, pubkey, "Connected" badge
- **Saved / Offline** — gray indicator, pubkey, "Offline" badge + "Forget" button
- Connected peers that are also known show a "Forget" button (unless they have open channels)

Load known peers on mount and merge with `peerManager.list_peers()` to build the unified list.

### Context Type Updates (ldk-context.ts)

Extend the `'ready'` variant of `LdkContextValue`:

```typescript
// Add to the 'ready' variant:
forgetPeer: (pubkey: string) => Promise<void>
knownPeers: Map<string, KnownPeer>  // optional: expose for UI
```

## Acceptance Criteria

- [x] New `ldk_known_peers` IndexedDB store created on DB version upgrade (v3 → v4)
- [x] `src/ldk/storage/known-peers.ts` accessor module with `getKnownPeers()`, `putKnownPeer()`, `deleteKnownPeer()`
- [x] Successful peer connection persists `{host, port}` keyed by pubkey
- [x] On wallet startup, all known peers are reconnected in parallel (non-blocking)
- [x] Failed reconnections are logged but do not prevent wallet from reaching `ready` state
- [x] IDB read failures during startup reconnection are caught and logged, not fatal
- [x] User can "forget" a peer, removing it from auto-reconnect
- [x] Forgetting a peer with open channels is blocked with a clear error/warning
- [x] Peers page shows known peers with connection status (connected vs offline)
- [x] Known peers list shows "Forget" button per peer (disabled/hidden for peers with open channels)
- [x] Reconnecting to a peer with a new address updates the stored address (upsert by pubkey key)
- [x] `ldk_known_peers` is included in LDK stores clear list for future seed migrations

## Success Metrics

- Zero manual peer re-entry needed after restart when peers are online
- Known peers appear in the Peers page within seconds of startup (connected or showing offline status)
- No startup delay — wallet reaches `ready` state immediately, reconnection happens in background

## Dependencies & Risks

**Dependencies:**
- Existing `connectToPeer()` function in `peer-connection.ts` (no changes needed)
- Existing IndexedDB infrastructure in `idb.ts`
- Existing peer timer loop in `context.tsx` (ensures `process_events()` runs to complete handshakes)

**Risks:**
- **Proxy overload:** If a user accumulates many known peers over time, startup reconnection opens many simultaneous WebSocket connections. Mitigation: acceptable for now (typical user has 1-3 peers); add batching if needed later.
- **Stale entries:** Peers saved on connect (not just channel open) may accumulate experimental connections. Mitigation: "Forget" functionality lets users clean up; could add a "last connected" timestamp later for auto-cleanup.
- **bfcache restoration:** Browser back-forward cache can restore the page with stale WebSocket connections. Mitigation: out of scope for this feature; can be addressed separately with a `pageshow` event listener.
- **Cross-realm Uint8Array from IDB:** Per institutional learnings (`docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md`), data from IDB may fail `instanceof` checks. Mitigation: the known peers store uses plain `{host, port}` objects (strings and numbers), not typed arrays — this risk does not apply here.

## Sources & References

### Internal References

- Peer connectivity brainstorm (deferred this feature): `docs/brainstorms/2026-03-12-peer-connectivity-brainstorm.md`
- Peer connection implementation: `src/ldk/peers/peer-connection.ts:14`
- IndexedDB storage layer: `src/ldk/storage/idb.ts`
- Storage accessor pattern: `src/ldk/storage/seed.ts`, `src/onchain/storage/changeset.ts`
- LDK context provider: `src/ldk/context.tsx:10`
- Context type definition: `src/ldk/ldk-context.ts`
- Peers page UI: `src/pages/Peers.tsx`
- LdkNode interface: `src/ldk/init.ts:45`

### Institutional Learnings

- LDK event handler sync/async patterns: `docs/solutions/integration-issues/ldk-event-handler-patterns.md`
- LDK WASM foundation patterns: `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md`
- LDK trait defensive hardening: `docs/solutions/integration-issues/ldk-trait-defensive-hardening-patterns.md`
