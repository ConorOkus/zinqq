---
status: pending
priority: p3
issue_id: "040"
tags: [code-review, quality, proxy]
dependencies: []
---

# MAX_MESSAGE_SIZE is YAGNI — Cloudflare enforces platform limits

## Problem Statement

Cloudflare Workers enforce a 1MB WebSocket message limit at the platform level. Lightning protocol self-frames messages. The application-level 64KB size check adds complexity for a problem that does not exist.

## Findings

- **Source:** Simplicity Reviewer
- **Location:** `proxy/src/index.ts` lines 7, 35, 54-58; `proxy/wrangler.toml` lines 7, 14, 20

## Proposed Solutions

### Option A: Remove MAX_MESSAGE_SIZE entirely
Remove from Env interface, wrangler.toml, and the size-checking if block. ~7 LOC removed.

- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] MAX_MESSAGE_SIZE removed from Env, wrangler.toml, and handler
