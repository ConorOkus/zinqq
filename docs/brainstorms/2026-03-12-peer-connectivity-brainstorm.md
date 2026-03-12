# Brainstorm: Lightning Peer Connectivity

**Date:** 2026-03-12
**Status:** Draft

## What We're Building

PeerManager integration with WebSocket-based networking so the browser wallet can connect to Lightning peers on Signet/Mutinynet. This is the networking layer that enables all future channel and payment functionality.

- **PeerManager** — LDK's peer connection manager, wired with ChannelManager, NetworkGraph, and Logger
- **WebSocket SocketDescriptor** — Browser-compatible implementation of LDK's SocketDescriptor trait wrapping a WebSocket connection to a WS-to-TCP proxy
- **WebSocket proxy connectivity** — Connect to Lightning TCP peers via a public WS-to-TCP proxy (like those used by Mutiny wallet)
- **Basic connect UI** — Simple form on Home page to paste a `pubkey@host:port`, connect, and see status
- **PeerManager timer tick** — Periodic `timer_tick_occurred()` call integrated into the existing sync loop

## Why This Approach

- **WebSocket proxy** over direct TCP because browsers cannot open raw TCP sockets. A proxy bridges WebSocket to TCP, making any Lightning node reachable. This is the proven approach used by Mutiny and other browser wallets.
- **Public proxy** for quick start on Signet — avoids needing to self-host infrastructure. Can switch to self-hosted later.
- **Connect + handshake only** keeps scope tight. Proving the networking layer works is the gate for channel opening (next phase). No need to bundle channel open/close into this feature.
- **Basic UI** because connecting to a peer requires user input (pubkey@host:port) and visual feedback (connected/disconnected). Console-only testing is impractical for this feature.

## Key Decisions

1. **Transport: WebSocket via WS-to-TCP proxy** — Browser connects to `wss://proxy/` which relays to the target Lightning node's TCP port.
2. **Proxy: Public community proxy** — Default to a known Mutinynet/Signet proxy. Configurable in `config.ts`.
3. **Scope: Connect + Lightning handshake** — PeerManager setup, SocketDescriptor impl, connect to one peer, verify handshake completes. No channel operations.
4. **UI: Basic connect form on Home page** — Input for `pubkey@host:port`, Connect button, status indicator (disconnected/connecting/connected).
5. **Timer: Piggyback on sync loop** — Add `peerManager.timer_tick_occurred()` to the existing ~30s sync tick. Also call `peerManager.process_events()` on each tick.
6. **CSP update required** — `connect-src` in `index.html` must add `wss:` (or specific proxy domain) to allow WebSocket connections.
7. **Existing patterns maintained** — Factory function for SocketDescriptor, PeerManager added to `LdkNode` interface, exposed through React context.

## Scope

### In scope
- PeerManager creation and wiring (ChannelMessageHandler, RoutingMessageHandler, etc.)
- SocketDescriptor trait implementation wrapping browser WebSocket
- Connect to a peer via WS-to-TCP proxy
- Complete the Lightning noise protocol handshake
- PeerManager timer tick integration
- `LdkNode` interface extended with `peerManager`
- CSP update for WebSocket connections
- Basic connect UI (input + button + status)
- `connectToPeer(pubkey, host, port)` function exposed via context

### Out of scope
- Channel open/close
- Automatic reconnection on disconnect
- Peer persistence (remembering peers across restarts)
- Multi-peer management UI
- Inbound connections
- Self-hosted proxy setup

## Open Questions

_None — all key decisions resolved during brainstorm._
