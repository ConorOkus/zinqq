---
title: WebSocket-to-TCP proxy on Cloudflare Workers for browser Lightning peer connectivity
category: infrastructure
date: 2026-03-12
tags: [cloudflare-workers, websocket, tcp, proxy, lightning, ldk, ssrf, security]
modules: [proxy, src/ldk/peers, src/ldk/config]
---

# WebSocket-to-TCP Proxy on Cloudflare Workers

## Problem

Browser-based LDK Lightning nodes cannot open raw TCP sockets. The wallet depended on `wss://p.mutinynet.com`, a public community proxy with no SLA, no access control, and no guarantee of availability. A self-hosted proxy was needed for production use.

## Root Cause

Browsers lack a raw TCP socket API (and likely never will for security reasons). A WebSocket-to-TCP bridge is the only viable approach for Lightning peer connectivity from the browser. The BOLT 8 Noise protocol provides end-to-end encryption, making the proxy zero-trust by design.

## Solution

A ~100-line TypeScript Cloudflare Worker in `proxy/` that:

1. Accepts WebSocket upgrades at `/v1/{host_underscored}/{port}` (MutinyWallet-compatible format)
2. Validates origin, target port (`ALLOWED_PORTS` — `9735,9736,9737,26000` in production, dev additionally allows `25000`), and SSRF protection
3. Opens TCP via Cloudflare's `connect()` API
4. Pipes bytes bidirectionally between WebSocket and TCP

### Key Code Pattern: Hold the WritableStream Writer

The most important implementation detail — acquire the TCP writer **once** for the connection lifetime. Per-message `getWriter()`/`releaseLock()` throws under concurrent writes because the Streams spec allows only one active writer:

```typescript
// CORRECT: hold writer for connection lifetime
const writer = tcp.writable.getWriter()
server.addEventListener('message', (event: MessageEvent) => {
  void writer.write(new Uint8Array(event.data as ArrayBuffer)).catch(...)
})
server.addEventListener('close', () => void writer.close())
```

```typescript
// WRONG: per-message writer — throws if messages overlap
server.addEventListener('message', () => {
  const writer = tcp.writable.getWriter() // throws if previous write pending
  writer.write(...).then(() => writer.releaseLock())
})
```

### SSRF Protection Checklist

Block these before calling `connect()`:

- RFC 1918 (`10.x`, `172.16-31.x`, `192.168.x`)
- Loopback (`127.x`)
- Link-local (`169.254.x`)
- CGNAT (`100.64-127.x`)
- Broadcast (`255.x`)
- Well-known hostnames: `localhost`, `*.local`, `*.internal`, `*.localhost`
- IPv6 loopback/private: `::1`, `[::1]`, `::ffff:*`, `fc*`, `fd*`, `fe80*`

**Known limitation:** Hostnames that DNS-resolve to private IPs bypass validation (Cloudflare's `connect()` resolves DNS server-side and doesn't expose the resolved IP). The `ALLOWED_PORTS` allowlist limits blast radius. Tracked in `todos/035`.

### Cloudflare Workers Gotchas

- **`Response` status 101**: The Workers runtime allows `new Response(null, { status: 101, webSocket: client })` but Node.js rejects status outside 200-599. Tests for the WebSocket upgrade path must account for this.
- **`WebSocketPair` indexing**: Use `pair[0]`/`pair[1]` instead of `Object.values(new WebSocketPair())` to avoid `noUncheckedIndexedAccess` issues with potentially-undefined values.
- **Text frames**: Lightning is binary-only. Reject text WebSocket frames with close code 1003 rather than silently encoding them.
- **Cloudflare Access**: New Workers may auto-create Access policies that block all requests with 302 redirects. Delete them via the Access API if the proxy handles its own auth.
- **Empty env vars**: `ALLOWED_ORIGINS = ""` splits to an empty array — add a runtime guard returning 500 instead of silently 403-ing everything.
- **`MAX_MESSAGE_SIZE` is YAGNI**: Cloudflare enforces a 1MB platform limit. Lightning self-frames. Don't add application-level size checks.

### Deployment

```bash
cd proxy && pnpm install
npx wrangler login          # Browser OAuth — no API key needed
npx wrangler deploy --env dev
```

Requires Cloudflare Workers **Paid plan** ($5/month) for the `connect()` TCP API.

Production runs on a custom domain, `proxy.zinqq.app`, worker name `ln-ws-proxy-production` (`proxy/wrangler.toml` `[env.production]`).

### Wallet Integration

```typescript
// src/ldk/config.ts — env var, defaulting to the self-hosted proxy (not a community fallback)
wsProxyUrl: (import.meta.env.VITE_WS_PROXY_URL as string | undefined) ?? DEFAULTS.wsProxyUrl,
// DEFAULTS.wsProxyUrl = 'wss://proxy.zinqq.app'
```

CSP in `index.html`/`vercel.json` must include the Worker domain in `connect-src`.

## Prevention

- Always hold `WritableStream` writers for the connection lifetime when piping bidirectional streams
- Test SSRF blocklists against both IP literals AND well-known hostnames
- Add runtime guards for required env vars — don't let empty strings silently disable security controls
- When deploying new Cloudflare Workers, check for auto-created Access policies

## Related

- Brainstorm: `docs/brainstorms/2026-03-12-websocket-proxy-infrastructure-brainstorm.md`
- Plan: `docs/plans/2026-03-12-002-feat-websocket-tcp-proxy-worker-plan.md`
- Existing learnings: `docs/solutions/integration-issues/ldk-wasm-foundation-layer-patterns.md`
- [Cloudflare Workers TCP Sockets docs](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [MutinyWallet/websocket-proxy](https://github.com/MutinyWallet/websocket-proxy) — reference implementation
- [BOLT 8: Transport Protocol](https://github.com/lightning/bolts/blob/master/08-transport.md)
