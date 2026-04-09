# Brainstorm: Fix LSPS2 JIT Payment Failures on Mobile (Peer Disconnect)

**Date:** 2026-04-09
**Status:** Complete

## What We're Building

A fix for LSPS2 JIT payment failures on mobile browsers caused by silent peer disconnection. When the mobile browser backgrounds the app, WebSocket connections to the LSP die. The current code swallows the connection failure and proceeds to send LSPS2 messages to a disconnected peer, causing a 30-second timeout hang.

## Why This Approach

- **Verify + reconnect once** chosen over fail-fast-only and full retry resilience. The catch block at `context.tsx:258` currently swallows `doConnectToPeer` failures with "may already be connected" — but on mobile, the peer is likely disconnected. The fix checks if the LSP is actually connected after the catch, attempts one reconnect if not, and throws a clear error if that also fails.
- **PWA fundamental constraint acknowledged** — mobile browsers aggressively kill WebSocket connections when backgrounded (especially iOS Safari). This is unavoidable. The pattern is: accept disconnects happen, verify before acting, reconnect when needed.
- **Minimal blast radius** — the fix is contained to the `requestJitInvoice` function. No changes to peer timers, visibility handlers, or reconnect cadence.

## Key Decisions

1. **Fix location:** `requestJitInvoice` in `src/ldk/context.tsx` (lines 248-261)
2. **Strategy:** After the try/catch for `doConnectToPeer`, verify LSP is in `peerManager.list_peers()`. If not, attempt one fresh reconnect. If that fails, throw descriptive error.
3. **No visibility handler changes** — keep the fix minimal for now. Proactive reconnect on foreground is a natural follow-up if needed.
4. **No retry logic in LSPS2 message layer** — YAGNI. The reconnect-once pattern handles the common mobile backgrounding case.

## Root Cause Analysis

```
User backgrounds app → browser kills WebSocket → LSP disconnected
→ User returns, triggers requestJitInvoice
→ doConnectToPeer fails (timeout/proxy error)
→ catch {} swallows error ("may already be connected")
→ getOpeningFeeParams sends to disconnected peer
→ 30s timeout → user sees mysterious failure
```

**Secondary factor:** `reconnectDisconnectedPeers` only reconnects **channel** peers. On a fresh wallet using LSPS2 for the first JIT channel, the LSP has no channels yet, so it's never reconnected by the timer.

## Open Questions

None — all questions resolved during brainstorm.
