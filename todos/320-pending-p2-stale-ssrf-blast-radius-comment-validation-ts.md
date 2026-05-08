---
status: pending
priority: p2
issue_id: '320'
tags: [code-review, security, proxy, ssrf, documentation]
dependencies: []
---

# Stale SSRF blast-radius comment in `proxy/src/validation.ts` after port allowlist widening

## Problem Statement

`proxy/src/validation.ts:39-43` documents the DNS-rebinding limitation
of the WebSocket proxy with this justification:

> Note: DNS rebinding via custom hostnames is a known limitation —
> Cloudflare Workers connect() resolves DNS server-side, and we cannot
> inspect the resolved IP before connecting. **The port-9735
> restriction limits the blast radius.** See todos/035 for tracking.

The "port-9735 restriction" framing is no longer accurate. `ALLOWED_PORTS`
now contains:

- `[vars]` (default): `9735, 9736, 9737, 25000, 26000`
- `[env.dev.vars]`: `9735, 9736, 9737, 25000, 26000`
- `[env.production.vars]`: `9735, 9736, 9737, 26000`

Port 26000 was added for LQwD Germany (LSP), 25000 for [check usage].
The comment's mitigation argument therefore overstates the residual
defenses, and a future reader could reasonably assume "we only allow
9735" when reasoning about the trust boundary of the proxy.

This is documentation drift, not an exploitable security bug. But the
DNS-rebinding hole flagged in `todos/035` widens slightly with each
new allowed port (any internal service running on 26000 inside the
Cloudflare egress's reachable network is now within range when an
attacker controls a hostname they pass through the proxy). The
literal-IP guards in `isPrivateIPv4` still catch direct RFC1918
addresses, but a hostname whose DNS resolves at connect time to a
private/internal IP is not blocked — that's the gap todo 035 covers.

## Findings

- Source: `proxy/src/validation.ts:39-43` — comment block
- Identified by: security-sentinel during /ce:review of LSPS2 fix
  (2026-05-07)
- Severity P2: documentation accuracy; the underlying SSRF risk
  exists and is tracked separately (todos/035), this todo only
  addresses the misleading comment + a small reconsideration of
  whether the residual risk has crossed a threshold worth picking up
  todo 035 sooner
- The change to add 26000 was correct and necessary — LQwD's primary
  endpoint runs on that port (returned dynamically from
  `https://germany.lqwd.tech/api/v1/get_info`)

## Proposed Solutions

### Option A — Update the comment, link the running list of allowed ports (recommended)

Edit `proxy/src/validation.ts:39-43` to drop the hard-coded
"port-9735" framing and reference the live `ALLOWED_PORTS` env var
instead:

```ts
// Note: DNS rebinding via custom hostnames is a known limitation —
// Cloudflare Workers connect() resolves DNS server-side, and we cannot
// inspect the resolved IP before connecting. The ALLOWED_PORTS
// allowlist limits the egress blast radius to the specific Lightning
// peer ports operators have whitelisted; expanding that list widens
// the residual SSRF surface for any hostname that resolves to an
// internal IP at connect time. See todos/035 for the long-term fix
// (DoH pre-resolution).
```

- **Pros**: Honest. Doesn't require code changes. Re-asserts the
  trade-off so the next port addition is a deliberate decision.
- **Cons**: None.
- **Effort**: Small (5 minutes).
- **Risk**: None.

### Option B — Pick up todo 035 (DoH pre-resolution)

Implement the long-term fix referenced by todo 035: resolve hostnames
client-side via DNS-over-HTTPS, validate the returned IP against
`isPrivateIPv4`, and only then route the connection. Closes the
DNS-rebinding gap entirely and makes the port allowlist a defense-
in-depth layer rather than the primary mitigation.

- **Pros**: Eliminates the residual risk root-cause.
- **Cons**: Larger change; couples proxy to a DoH provider; latency
  hit on every connection.
- **Effort**: Large.
- **Risk**: Medium.

## Recommended Action

Option A first (cheap, immediate). Re-evaluate Option B priority once
the running port list grows further — current 5 ports is still a
narrow allowlist, but each addition lowers the bar for picking up
todo 035.

## Technical Details

- **Affected files**: `proxy/src/validation.ts`
- **Tests**: none — comment-only change

## Acceptance Criteria

- [ ] Comment in `validation.ts:39-43` no longer references
      "port-9735 restriction"
- [ ] Updated comment names ALLOWED_PORTS as the mechanism and notes
      the trade-off of expanding it
- [ ] Reference to todos/035 preserved
- [ ] `pnpm lint` passes

## Work Log

(Empty)

## Resources

- Original PR: in-progress LSPS2 + LQwD-port fix (uncommitted as of
  2026-05-07)
- Related todo: `todos/035-*-dns-rebinding-ssrf-bypass.md`
- Past solution: `docs/solutions/infrastructure/websocket-tcp-proxy-cloudflare-workers.md`
