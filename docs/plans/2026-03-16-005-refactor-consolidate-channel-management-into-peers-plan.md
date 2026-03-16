---
title: "refactor: Consolidate channel management into Peers screen"
type: refactor
status: completed
date: 2026-03-16
---

# refactor: Consolidate Channel Management into Peers Screen

## Overview

Merge the standalone Open Channel and Close Channel flows into the Peers screen within Advanced Settings, eliminating two separate navigation destinations and providing a more intuitive channel management experience where actions are contextual to each peer.

## Problem Statement / Motivation

Currently, channel management is spread across three separate screens under Advanced Settings: Peers, Open Channel, and Close Channel. The Open Channel flow redundantly asks the user to select a peer they've already connected to, and the Close Channel flow asks the user to select a channel without the context of which peer it belongs to. Consolidating these into the Peers screen places channel actions directly where the user can see their peers and existing channels, reducing navigation depth and cognitive overhead.

## Proposed Solution

1. **Add inline actions to peer cards** on the Peers screen:
   - "Open Channel" button on each connected peer card
   - "Close Channel" button on each channel row within a peer card

2. **Refactor Open Channel flow** to skip peer selection — the peer is already known from the card that was tapped. Navigate to the existing amount → review → success/error screens.

3. **Refactor Close Channel flow** to skip channel selection — the channel is already known from the row that was tapped. Navigate to the existing confirm → success/error screens.

4. **Remove the Open Channel and Close Channel items** from the Advanced settings menu, keeping only Peers.

5. **Clean up routes** — remove `/settings/advanced/open-channel` and `/settings/advanced/close-channel`, replace with new routes nested under peers.

## Technical Considerations

### Routing Strategy

Use React Router `state` to pass peer/channel data when navigating from the Peers screen to the sub-flows. Keep `OpenChannel.tsx` and `CloseChannel.tsx` as separate route components (not inline) to avoid bloating the Peers component.

**New routes:**
- `/settings/advanced/peers/open-channel` — receives `{ peerPubkey: string }` via route state
- `/settings/advanced/peers/close-channel` — receives `{ channel: ChannelInfo }` via route state

**Refresh/deep-link guard:** If route state is missing (page refresh, direct navigation), redirect to `/settings/advanced/peers`.

### Data Model Enrichment

The `ChannelInfo` interface in `Peers.tsx` (line 9-15) needs to be enriched to include fields required by the close-channel flow:

```typescript
// src/pages/Peers.tsx
interface ChannelInfo {
  channelId: ChannelId        // NEW — needed for close
  channelIdHex: string        // NEW — needed for close
  counterpartyNodeId: Uint8Array  // NEW — needed for close
  capacitySats: bigint
  outboundMsat: bigint
  inboundMsat: bigint
  isUsable: boolean
  isReady: boolean
}
```

### Back Navigation

| Screen | Back goes to |
|--------|-------------|
| Open Channel → Amount step | `/settings/advanced/peers` |
| Open Channel → Review step | Amount step (internal state) |
| Close Channel → Confirm step | `/settings/advanced/peers` |
| Success → "Done" button | `/` (Home) — matches current behavior |
| Error → "Try Again" | Amount step (open) or Confirm step (close) — preserving peer/channel context |

### Disconnected Peer Handling

- **Hide** the "Open Channel" button on disconnected peer cards (LDK requires an active connection to open a channel)
- The "Close Channel" button remains available on channels of disconnected peers (force close is always possible)

### Pending Channel Behavior

- Show "Close Channel" on pending channels
- Display a warning that cooperative close is unavailable for unconfirmed channels
- Default to force close for pending channels

## Acceptance Criteria

- [x] Each connected peer card on the Peers screen shows an "Open Channel" button
- [x] Each channel row within a peer card shows a "Close Channel" button
- [x] "Open Channel" button is hidden on disconnected peer cards
- [x] Tapping "Open Channel" navigates to the amount entry screen with the peer pre-selected (no peer selection step)
- [x] Tapping "Close Channel" navigates to the confirm screen with the channel pre-selected (no channel selection step)
- [x] Routes `/settings/advanced/open-channel` and `/settings/advanced/close-channel` are removed
- [x] New routes exist: `/settings/advanced/peers/open-channel` and `/settings/advanced/peers/close-channel`
- [x] If route state is missing (page refresh), user is redirected to the Peers screen
- [x] Advanced settings menu shows only the Peers item (Open Channel and Close Channel menu items removed)
- [x] "Try Again" on open-channel error returns to the amount step with same peer
- [x] "Try Again" on close-channel error returns to the confirm step with same channel
- [x] Back button from the first step of each sub-flow returns to the Peers screen
- [x] All success/error screens continue to work as before
- [x] The `ChannelInfo` interface in `Peers.tsx` includes `channelId`, `channelIdHex`, and `counterpartyNodeId`
- [x] Existing E2E or unit tests are updated to reflect new routes and removed pages

## Success Metrics

- Channel management is accessible in fewer taps (2 fewer navigation steps for open/close)
- No standalone Open/Close Channel screens in the Advanced menu
- User can manage all channel operations from the Peers screen context

## Dependencies & Risks

- **Route state ephemeral nature**: Page refresh during open/close flow loses context. Mitigated by redirecting to Peers screen.
- **Component complexity**: Peers screen gains inline buttons but the heavy logic stays in `OpenChannel.tsx` and `CloseChannel.tsx` as separate route components.
- **LDK `ChannelId` serialization**: Need to verify `ChannelId` can be safely passed through React Router state (may need to serialize to hex and reconstruct).

## Files to Modify

| File | Change |
|------|--------|
| `src/pages/Peers.tsx` | Enrich `ChannelInfo`, add "Open Channel" / "Close Channel" buttons |
| `src/pages/OpenChannel.tsx` | Remove peer selection step, accept peer from route state, update back navigation |
| `src/pages/CloseChannel.tsx` | Remove channel selection step, accept channel from route state, update back navigation |
| `src/pages/Advanced.tsx` | Remove Open Channel and Close Channel menu items |
| `src/routes/router.tsx` | Remove old routes, add new nested routes under peers |

## Sources & References

- Similar pattern: `src/pages/OpenChannel.tsx` — current peer selection + amount + review flow
- Similar pattern: `src/pages/CloseChannel.tsx` — current channel selection + confirm flow
- Component: `src/components/ScreenHeader.tsx` — supports both `backTo` (route string) and `onBack` (callback)
- Context API: `src/ldk/ldk-context.ts` — provides `createChannel`, `closeChannel`, `forceCloseChannel`
