---
title: 'feat: Lightning Peer Connectivity via WebSocket'
type: feat
status: completed
date: 2026-03-12
origin: docs/brainstorms/2026-03-12-peer-connectivity-brainstorm.md
---

# feat: Lightning Peer Connectivity via WebSocket

## Overview

Add PeerManager with WebSocket-based networking so the browser wallet can connect to Lightning peers on Signet/Mutinynet via a WS-to-TCP proxy. This is the networking layer that enables all future channel and payment functionality. Includes a basic connect UI for testing.

## Problem Statement / Motivation

The wallet has a fully wired ChannelManager, ChainMonitor, NetworkGraph, and Scorer — but cannot communicate with any Lightning peer. Without PeerManager and a transport layer, the node is isolated: it can't open channels, receive gossip, or make payments. Browsers cannot open raw TCP sockets, so a WebSocket-based transport via a WS-to-TCP proxy is required (see brainstorm: `docs/brainstorms/2026-03-12-peer-connectivity-brainstorm.md`).

## Proposed Solution

1. **PeerManager** — Created with ChannelManager's ChannelMessageHandler + IgnoringMessageHandler for routing/onion/custom messages
2. **SocketDescriptor** — Browser WebSocket wrapper implementing LDK's SocketDescriptor trait
3. **WebSocket proxy** — Connect to peers via `wss://{proxy}/v1/{host}/{port}` format (Mutiny-compatible)
4. **Connect function** — `connectToPeer(pubkey, host, port)` exposed via React context
5. **Basic UI** — Input for `pubkey@host:port`, Connect button, connected peers list
6. **PeerManager timer** — Separate 10s interval for `timer_tick_occurred()` + `process_events()`

## Technical Approach

### Architecture

```
src/ldk/
  init.ts                    — Add PeerManager creation, extend LdkNode
  config.ts                  — Add wsProxyUrl
  ldk-context.ts             — Add peerManager to LdkNode, add connectToPeer action
  context.tsx                — Start/stop peer timer, expose connectToPeer
  use-ldk.ts                 — (unchanged)
  peers/
    socket-descriptor.ts     — NEW: SocketDescriptor wrapping WebSocket
    peer-connection.ts       — NEW: connectToPeer orchestration
  sync/
    chain-sync.ts            — (unchanged — peer timer is separate)
src/pages/
  Home.tsx                   — Add connect form + peer list
index.html                   — CSP update: add wss: to connect-src
```

### Implementation Phases

#### Phase 1: PeerManager Setup

**1a. Config update** (`src/ldk/config.ts`)

```typescript
export const SIGNET_CONFIG = {
  // ...existing fields
  wsProxyUrl: 'wss://p.mutinynet.com',
  peerTimerIntervalMs: 10_000,
} as const
```

**1b. CSP update** (`index.html`)

Add `wss:` to `connect-src`:
```html
connect-src 'self' https://mutinynet.com wss:;
```

**1c. PeerManager creation** (`src/ldk/init.ts`)

```typescript
import { PeerManager, IgnoringMessageHandler } from 'lightningdevkit'

const ignorer = IgnoringMessageHandler.constructor_new()

const peerManager = PeerManager.constructor_new(
  channelManager.as_ChannelMessageHandler(),
  ignorer.as_RoutingMessageHandler(),
  ignorer.as_OnionMessageHandler(),
  ignorer.as_CustomMessageHandler(),
  Math.floor(Date.now() / 1000),
  keysManager.as_EntropySource().get_secure_random_bytes(),
  logger,
  keysManager.as_NodeSigner()
)
```

Add `peerManager` to `LdkNode` interface:
```typescript
export interface LdkNode {
  // ...existing fields
  peerManager: PeerManager
}
```

#### Phase 2: SocketDescriptor + Connection Logic

**2a. SocketDescriptor** (`src/ldk/peers/socket-descriptor.ts`)

```typescript
import { SocketDescriptor, type PeerManager } from 'lightningdevkit'

let nextSocketId = BigInt(1)

export function createSocketDescriptor(
  ws: WebSocket,
  peerManager: PeerManager
): SocketDescriptor {
  const socketId = nextSocketId++

  return SocketDescriptor.new_impl({
    send_data(data: Uint8Array, _resume_read: boolean): number {
      if (ws.readyState !== WebSocket.OPEN) return 0
      ws.send(data)
      return data.length
    },
    disconnect_socket(): void {
      ws.close()
    },
    eq(other: SocketDescriptor): boolean {
      return other.hash() === socketId
    },
    hash(): bigint {
      return socketId
    },
  })
}
```

**2b. Connect function** (`src/ldk/peers/peer-connection.ts`)

```typescript
import {
  Result_CVec_u8ZPeerHandleErrorZ_OK,
  Result_boolPeerHandleErrorZ_OK,
  Option_SocketAddressZ,
  type PeerManager,
} from 'lightningdevkit'
import { createSocketDescriptor } from './socket-descriptor'
import { hexToBytes } from '../utils'
import { SIGNET_CONFIG } from '../config'

export function connectToPeer(
  peerManager: PeerManager,
  pubkeyHex: string,
  host: string,
  port: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Proxy URL format: wss://{proxy}/v1/{host_with_underscores}/{port}
    const proxyHost = host.replace(/\./g, '_')
    const wsUrl = `${SIGNET_CONFIG.wsProxyUrl}/v1/${proxyHost}/${port}`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    let descriptor: SocketDescriptor | null = null

    ws.onopen = () => {
      descriptor = createSocketDescriptor(ws, peerManager)
      const theirNodeId = hexToBytes(pubkeyHex)

      const initResult = peerManager.new_outbound_connection(
        theirNodeId,
        descriptor,
        Option_SocketAddressZ.constructor_none()
      )

      if (!(initResult instanceof Result_CVec_u8ZPeerHandleErrorZ_OK)) {
        ws.close()
        reject(new Error('Failed to initiate outbound connection'))
        return
      }

      // Send Noise Act One
      ws.send(initResult.res)
    }

    ws.onmessage = (event) => {
      if (!descriptor) return
      const data = new Uint8Array(event.data as ArrayBuffer)

      const readResult = peerManager.read_event(descriptor, data)
      if (!(readResult instanceof Result_boolPeerHandleErrorZ_OK)) {
        ws.close()
        reject(new Error('Peer handshake failed'))
        return
      }

      peerManager.process_events()

      // Check if handshake is complete (peer appears in list)
      const peers = peerManager.list_peers()
      const connected = peers.some((p) => {
        const peerPubkey = p.get_counterparty_node_id()
        return bytesToHex(peerPubkey) === pubkeyHex
      })
      if (connected) {
        resolve()
      }
    }

    ws.onerror = () => {
      reject(new Error(`WebSocket connection to ${wsUrl} failed`))
    }

    ws.onclose = () => {
      if (descriptor) {
        peerManager.socket_disconnected(descriptor)
      }
    }
  })
}
```

#### Phase 3: PeerManager Timer

**3a. Separate peer timer** (`src/ldk/context.tsx`)

PeerManager needs `timer_tick_occurred()` every ~10s (per LDK docs — more frequent than the 30s chain sync). Add a separate timer:

```typescript
// In LdkProvider, after sync loop starts:
const peerTimerId = setInterval(() => {
  node.peerManager.timer_tick_occurred()
  node.peerManager.process_events()
}, SIGNET_CONFIG.peerTimerIntervalMs)

// In cleanup:
return () => {
  cancelled = true
  syncHandle?.stop()
  clearInterval(peerTimerId)
}
```

#### Phase 4: React Integration + UI

**4a. Expose connectToPeer via context** (`src/ldk/ldk-context.ts`)

Add a `connectToPeer` action to the ready state:

```typescript
export type LdkContextValue =
  | { status: 'loading'; node: null; nodeId: null; error: null }
  | {
      status: 'ready'
      node: LdkNode
      nodeId: string
      error: null
      syncStatus: SyncStatus
      connectToPeer: (pubkey: string, host: string, port: number) => Promise<void>
    }
  | { status: 'error'; node: null; nodeId: null; error: Error }
```

**4b. Basic connect UI** (`src/pages/Home.tsx`)

```
┌─────────────────────────────────────────┐
│ Browser Wallet                          │
│                                         │
│ ✅ Lightning node ready                 │
│ Node ID: 02abc...def                    │
│                                         │
│ ── Connect to Peer ──────────────────── │
│ [pubkey@host:port                     ] │
│ [Connect]                               │
│                                         │
│ Connected Peers: 0                      │
│ (none)                                  │
└─────────────────────────────────────────┘
```

- Input: `pubkey@host:port` format, parsed on submit
- Button: Connect (disabled while connecting, shows spinner)
- Status: List of connected peers from `peerManager.list_peers()`
- Error: Display connection errors inline

## System-Wide Impact

### Interaction Graph

User clicks Connect → `connectToPeer(pubkey, host, port)` → opens WebSocket to proxy → `peerManager.new_outbound_connection()` → Noise Act One sent via WebSocket → peer responds → `peerManager.read_event()` → `process_events()` generates Act Three → `send_data` on SocketDescriptor → handshake completes → `list_peers()` shows peer.

Separately: every 10s, `timer_tick_occurred()` pings connected peers and disconnects unresponsive ones. `process_events()` flushes any pending outbound messages.

### Error Propagation

- WebSocket connection failure: `ws.onerror` → promise rejects → UI shows error message
- Noise handshake failure: `read_event` returns error → WebSocket closed → `socket_disconnected` → promise rejects
- Proxy unreachable: WebSocket times out (browser default ~30s) → `ws.onerror` fires
- Peer disconnects: `ws.onclose` → `socket_disconnected` → peer removed from `list_peers()`

### State Lifecycle Risks

- **No persistent state**: Peer connections are ephemeral — lost on page reload. This is intentional for the "connect + handshake" scope.
- **Timer cleanup**: Must clear the 10s peer timer interval on provider unmount to prevent leaks.
- **WebSocket cleanup**: Must close WebSocket and call `socket_disconnected` on cleanup.

## Acceptance Criteria

### Functional Requirements

- [ ] PeerManager created with ChannelMessageHandler + IgnoringMessageHandler
- [ ] SocketDescriptor wraps browser WebSocket with send_data, disconnect_socket, eq, hash
- [ ] `connectToPeer(pubkey, host, port)` connects via WS-to-TCP proxy
- [ ] Lightning Noise protocol handshake completes successfully
- [ ] Connected peer appears in `peerManager.list_peers()`
- [ ] PeerManager `timer_tick_occurred()` called every ~10s
- [ ] PeerManager `process_events()` called after each `read_event` and on timer tick
- [ ] `LdkNode` interface extended with `peerManager`
- [ ] React context exposes `connectToPeer` action
- [ ] CSP updated to allow `wss:` connections
- [ ] Config includes `wsProxyUrl` and `peerTimerIntervalMs`

### UI Requirements

- [ ] Input field for `pubkey@host:port` on Home page
- [ ] Connect button (disabled while connecting)
- [ ] Connected peers count + list displayed
- [ ] Connection errors shown inline
- [ ] Peer disconnect reflected in UI (peer disappears from list)

### Non-Functional Requirements

- [ ] WebSocket `binaryType` set to `'arraybuffer'`
- [ ] SocketDescriptor uses monotonically incrementing BigInt IDs
- [ ] Peer timer cleaned up on provider unmount
- [ ] WebSocket connections cleaned up on provider unmount
- [ ] TypeScript strict mode passes
- [ ] No `any` escape hatches

### Quality Gates

- [ ] Unit tests for SocketDescriptor (mock WebSocket)
- [ ] Unit tests for connectToPeer (mock PeerManager + WebSocket)
- [ ] Unit tests for peer address parsing (`pubkey@host:port`)
- [ ] Existing tests continue passing

## Dependencies & Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Public WS proxy down or rate-limited | Cannot connect to peers | Make proxy URL configurable, document self-hosting |
| Proxy URL format differs from Mutiny | Connection fails | Verify format against actual proxy, add tests |
| PeerManager WASM API differs from docs | Build failures | Verify against `.d.mts` type definitions |
| CSP too restrictive (`wss:` wildcard) | Minor security concern | Can restrict to specific proxy domain if needed |
| Noise handshake timing | Promise may never resolve if handshake stalls | Add connection timeout (e.g., 15s) |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-12-peer-connectivity-brainstorm.md](docs/brainstorms/2026-03-12-peer-connectivity-brainstorm.md) — Key decisions: WebSocket via WS-to-TCP proxy, public community proxy, connect + handshake scope only, basic connect UI.

### Internal References

- LDK init: `src/ldk/init.ts`
- Config: `src/ldk/config.ts`
- React context: `src/ldk/context.tsx`, `src/ldk/ldk-context.ts`
- CSP: `index.html`
- LDK patterns doc: `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md`

### External References

- LDK PeerManager: `lightningdevkit/structs/PeerManager.d.mts`
- LDK SocketDescriptor: `lightningdevkit/structs/SocketDescriptor.d.mts`
- LDK test file with PeerManager example: `node_modules/lightningdevkit/test/tests.mjs:251-321`
- Mutiny WS proxy: `wss://{proxy}/v1/{host_underscored}/{port}` format
- MutinyWallet/ln-websocket-proxy GitHub repo

### Related Work

- PR #3: ChannelManager, ChainMonitor, chain sync (merged)
- Todo #031: Broadcaster retry (P1, independent)
