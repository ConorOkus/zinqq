---
title: "WebSocket message relay blocked after handshake by resolved flag guard"
category: logic-errors
severity: high
date: 2026-03-15
tags:
  - ldk
  - peer-connection
  - websocket
  - noise-handshake
  - timeout
  - lightning-network
module: src/ldk/peers/peer-connection.ts
symptoms:
  - "Peers disconnect approximately 60 seconds after successful connection"
  - "Disconnection triggered by navigating away from Peers page and returning"
  - "LDK ping/pong keepalive frames silently dropped after Noise handshake"
  - "peerManager.read_event() never called for post-handshake messages"
  - "No errors logged — messages dropped silently by early return guard"
---

# WebSocket Message Relay Blocked After Noise Handshake

## Problem

Peers disconnect ~60 seconds after a successful Lightning Noise protocol handshake. The connection appears to work initially — the handshake completes, the peer shows as "Connected" in the UI — but the peer silently drops off after roughly one minute. No errors are logged.

The symptom is most noticeable when navigating away from the Peers page and returning, because the UI refreshes and shows the peer as gone.

## Root Cause

In `src/ldk/peers/peer-connection.ts`, the `ws.onmessage` handler had a boolean guard at the top:

```typescript
ws.onmessage = (event) => {
  if (!descriptor || resolved) return  // <-- BUG
  // ...
  peerManager.read_event(descriptor, data)
  peerManager.process_events()
  // ...
}
```

The `resolved` flag was set to `true` when the Noise handshake completed (to prevent double-resolving the Promise). But this same flag also **gated the entire message handler**, causing every subsequent WebSocket message to be silently dropped via early `return`.

After the handshake, `peerManager.read_event()` was never called again. LDK sent pings but never received pong responses (because the incoming pong frames were dropped). After LDK's ping timeout (~60 seconds), it disconnected the peer.

## Key Insight

The `resolved` flag served **two distinct purposes** with **opposite lifecycles**:

1. **Promise guard** — prevent `resolve()`/`reject()` from being called more than once. This activates once and stays set forever. Correct and necessary.
2. **Message gate** — control whether incoming data is relayed to LDK. This must remain open for the entire connection lifetime. Incorrect and harmful.

Collapsing these two concerns into one variable means the first successful operation (handshake) kills all subsequent operations (message relay).

## Solution

Remove `|| resolved` from the top-level `onmessage` guard. Keep the `resolved` check only around the promise-settling code:

```typescript
ws.onmessage = (event) => {
  if (!descriptor) return                          // only check descriptor
  if (!(event.data instanceof ArrayBuffer)) return
  const data = new Uint8Array(event.data)

  const readResult = peerManager.read_event(descriptor, data)
  if (!(readResult instanceof Result_boolPeerHandleErrorZ_OK)) {
    cleanup()
    if (!resolved) {                               // guard only the reject()
      resolved = true
      ws.close()
      reject(new Error('Peer handshake failed'))
    }
    return
  }

  peerManager.process_events()

  if (!resolved) {                                 // guard only the resolve()
    const peers = peerManager.list_peers()
    for (const peer of peers) {
      const peerPubkey = bytesToHex(peer.get_counterparty_node_id())
      if (peerPubkey === pubkeyHex) {
        cleanup()
        resolved = true
        resolve()
        return
      }
    }
  }
}
```

Now `peerManager.read_event()` and `peerManager.process_events()` execute on **every message** for the entire WebSocket lifetime, not just during the handshake phase. LDK can receive and respond to pings, channel messages, and gossip.

## Prevention Strategies

### Separate concerns into distinct variables

Never reuse a single boolean to control two different behaviors. A promise-resolution guard and a message-processing gate are fundamentally different concerns. Name each flag after its single purpose.

### Prefer state machines over boolean flags

A WebSocket connection has states: `CONNECTING`, `HANDSHAKING`, `ACTIVE`, `CLOSING`, `CLOSED`. A state machine makes it impossible for the "handshake complete" transition to shut down message processing, because `ACTIVE` is a distinct state from `CLOSED`.

### Code review heuristic

Any early-return on a boolean in an `onmessage`/`ondata` handler is a red flag. Ask: "What messages will this drop after the flag flips?" The answer should be "none that matter," and that reasoning should be in a comment.

### Detection symptoms

- Connection succeeds, then silently dies 30-90 seconds later
- No errors in logs (the flag causes an early `return`, not a thrown error)
- Peer-side timeout errors while the local side reports no problems
- Works in unit tests that only check handshake, fails in integration tests that keep the connection alive

### Testing approach

Write a test that sends messages *after* the handshake resolves:

1. Set up the WebSocket connection and await the handshake promise
2. After the promise resolves, send simulated messages (e.g., ping frames) into the `onmessage` handler
3. Assert that each message was processed (e.g., `peerManager.read_event` was called)
4. If zero messages were processed post-handshake, the bug is present

Most tests stop after verifying the handshake. The bug only manifests in the "steady-state after successful setup" phase.

## Related Documentation

- [LDK Event Handler Patterns](../integration-issues/ldk-event-handler-patterns.md) — Documents the 10s peer timer tick that calls `process_events()`. Without `onmessage` relaying data, the timer alone is too infrequent for ping/pong.
- [LDK Trait Defensive Hardening](../integration-issues/ldk-trait-defensive-hardening-patterns.md) — Peer address validation and sync/async bridging patterns.
- [WebSocket-to-TCP Proxy](../infrastructure/websocket-tcp-proxy-cloudflare-workers.md) — Confirms the proxy is a stateless byte forwarder, ruling it out as the source of message drops.
- [Peer Connectivity Brainstorm](../../brainstorms/2026-03-12-peer-connectivity-brainstorm.md) — Original scope was "connect + handshake only," which may explain why post-handshake message flow wasn't thoroughly tested.
- [Auto-Reconnect Plan](../../plans/2026-03-15-004-feat-automatic-peer-reconnection-on-restart-plan.md) — Depends on `connectToPeer()` working correctly; the bug would have made auto-reconnect ineffective.
