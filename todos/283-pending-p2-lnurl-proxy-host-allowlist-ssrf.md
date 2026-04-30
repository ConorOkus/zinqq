---
status: pending
priority: p2
issue_id: '283'
tags: [code-review, security, ssrf, api]
dependencies: []
---

# `api/lnurl-proxy.ts` accepts arbitrary upstream hosts (anonymizing-proxy / SSRF)

## Problem Statement

`api/lnurl-proxy.ts` reconstructs an upstream URL from the `_path` query parameter as `https://${targetHost}${targetPath}` with **no allowlist or hostname normalization**. An attacker can request `/api/lnurl-proxy/evil.attacker.tld/anything` to make Vercel's serverless function fetch any HTTPS host. The function does not return secrets, but it can be used as:

- An anonymizing outbound proxy (free egress on Vercel's IPs, Vercel-trusted source for downstream services).
- A probe surface to enumerate internal `https://` services from a Vercel IP range.

This is **pre-existing**, not introduced by PR #147. It became visible because PR #147 re-enabled lint coverage on `api/**`. Filing now since it's the right moment to address it.

## Findings

- `api/lnurl-proxy.ts:14-25` — URL reconstruction from `_path` without scheme/host validation.
- Flagged by `security-sentinel` during PR #147 follow-up review.

## Proposed Solution

Mirror what `api/payjoin-proxy.ts` (now deleted) did: parse the target via a `parseTarget` helper that:
1. Rejects non-`https:` schemes.
2. Rejects private IPs (RFC 1918, link-local, loopback, IPv6 ULA, IPv4-mapped IPv6).
3. Normalizes hostname (lowercase, IDN punycode).
4. Optionally enforces a soft allowlist of well-known LNURL servers if we have one.

If we don't want a strict allowlist, at minimum enforce points 1–3.

**Effort:** 1–2 hours.
**Risk:** Low; LNURL spec allows arbitrary hosts so we can't be too strict, but private-IP rejection is uncontroversial.

## Acceptance Criteria

- [ ] Non-`https:` schemes rejected.
- [ ] Private/loopback IPs rejected.
- [ ] Hostname normalized.
- [ ] Existing LNURL flows still work end-to-end.

## Resources

- **PR:** #147
- **Reviewer:** `security-sentinel`
- **Reference:** the deleted `api/payjoin-proxy.ts`'s `parseTarget` (in git history)

## Work Log

### 2026-04-29 — Surfaced during PR #147 follow-up review
**By:** security-sentinel
