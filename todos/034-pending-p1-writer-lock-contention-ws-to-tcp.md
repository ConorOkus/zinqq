---
status: pending
priority: p1
issue_id: "034"
tags: [code-review, quality, proxy]
dependencies: []
---

# WritableStream writer lock contention on concurrent WebSocket messages

## Problem Statement

Every incoming WebSocket message calls `tcp.writable.getWriter()`, writes, then `releaseLock()`. If a second message arrives before the first write completes, `getWriter()` throws because the lock is still held. Under normal Lightning peer traffic (rapid BOLT 8 messages during handshake and gossip), this will cause intermittent `TCP write error` disconnects.

## Findings

- **Source:** Architecture Strategist, TypeScript Reviewer, Agent-Native Reviewer
- **Location:** `proxy/src/index.ts` lines 59-72
- **Evidence:** The Streams spec states only one writer can be active at a time. The current pattern creates a new writer per message rather than holding one for the connection lifetime.

## Proposed Solutions

### Option A: Hold writer for connection lifetime (Recommended)
Acquire the writer once after TCP connect, reuse for all messages. The `WritableStream` writer already queues writes internally.

```typescript
const writer = tcp.writable.getWriter()
server.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data
  void writer.write(
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new TextEncoder().encode(String(data)),
  ).catch(() => {
    if (server.readyState === WebSocket.OPEN) {
      server.close(1011, 'TCP write error')
    }
  })
})
server.addEventListener('close', () => void writer.close())
server.addEventListener('error', () => void writer.abort())
```

- **Pros:** Simpler code, eliminates the bug, writer queues writes naturally
- **Cons:** None
- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] Writer acquired once at connection setup
- [ ] Multiple rapid messages do not throw
- [ ] Connection closes cleanly when TCP write fails
