---
title: 'refactor: Rename project from zinq to zinqq'
type: refactor
status: completed
date: 2026-03-28
origin: docs/brainstorms/2026-03-28-rename-zinq-to-zinqq-brainstorm.md
---

# refactor: Rename project from zinq to zinqq

## Overview

Full rebrand from **zinq** to **zinqq** across all layers — source code, UI, config, documentation, and infrastructure. Motivated by domain availability (`zinqq.app` available, `zinq.app` is not). Follows the same pattern as the successful `browser-wallet` → `zinq` rename (see `docs/plans/2026-03-16-004-refactor-rename-project-to-zinq-plan.md`).

## Proposed Solution

Single atomic commit for all code/config/doc changes on a feature branch, followed by a coordinated infrastructure cutover (GitHub repo, Vercel project, Cloudflare worker).

**Key constraint:** The replacement must be **case-aware** and **single-pass** to avoid double-`q` corruption:

- Lowercase: `zinq` → `zinqq` (identifiers, config, domains)
- Title case: `Zinq` → `Zinqq` (display strings, HTML titles, comments)

Never run the replacement twice on already-renamed content.

## Acceptance Criteria

- [x] All runtime identifiers updated (`zinqq-ldk`, `zinqq-lock`, `Zinqq Wallet`, `zinqq wallet`)
- [x] `package.json` name is `zinqq`
- [x] HTML titles show `Zinqq`
- [x] `wrangler.toml` references `zinqq.vercel.app`
- [x] All ~26 documentation files updated
- [x] Tests pass after rename
- [x] GitHub repo renamed to `ConorOkus/zinqq`
- [x] Vercel project renamed, deploys working
- [x] Cloudflare worker CORS updated
- [x] Git remote updated locally

## MVP

### Phase 1: Code, Config & Docs (Single Commit)

All changes in one atomic commit on a feature branch.

#### Source Code — Lowercase `zinq` → `zinqq`

| File                                       | Change                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| `src/storage/idb.ts:1`                     | `DB_NAME = 'zinq-ldk'` → `'zinqq-ldk'`                  |
| `src/ldk/init.ts:122`                      | `'zinq-lock'` → `'zinqq-lock'`                          |
| `src/ldk/context.tsx:626`                  | `builder.description('zinq wallet')` → `'zinqq wallet'` |
| `src/wallet/mnemonic.test.ts:10`           | `deleteDatabase('zinq-ldk')` → `'zinqq-ldk'`            |
| `src/onchain/storage/changeset.test.ts:35` | `deleteDatabase('zinq-ldk')` → `'zinqq-ldk'`            |

#### Source Code — Title Case `Zinq` → `Zinqq`

| File                      | Change                                                 |
| ------------------------- | ------------------------------------------------------ |
| `src/ldk/context.tsx:192` | `description = 'Zinq Wallet'` → `'Zinqq Wallet'`       |
| `index.html:11`           | `<title>Zinq</title>` → `<title>Zinqq</title>`         |
| `design/index.html:6`     | `Zinq — Design Prototype` → `Zinqq — Design Prototype` |
| `design/styles.css:2`     | Comment: `Zinq` → `Zinqq`                              |
| `design/app.js:2`         | Comment: `Zinq` → `Zinqq`                              |

#### Config

| File                     | Change                                 |
| ------------------------ | -------------------------------------- |
| `package.json:2`         | `"name": "zinq"` → `"name": "zinqq"`   |
| `proxy/wrangler.toml:12` | `zinq.vercel.app` → `zinqq.vercel.app` |

#### Documentation (~26 files)

Apply case-aware find-and-replace across all files in `docs/`:

- `zinq.vercel.app` → `zinqq.vercel.app`
- `zinq-app.vercel.app` → `zinqq-app.vercel.app`
- `zinq.app` → `zinqq.app`
- `zinq-ldk` → `zinqq-ldk`
- `zinq-lock` → `zinqq-lock`
- `zinq:register:v1` → `zinqq:register:v1` (BIP 353 domain separator)
- `'zinq'` in reserved username lists → `'zinqq'`
- `ConorOkus/zinq` → `ConorOkus/zinqq` (GitHub URLs)
- Remaining lowercase `zinq` → `zinqq`
- Title case `Zinq` → `Zinqq`

**Order matters:** Replace longer/more-specific strings first (e.g., `zinq.vercel.app` before bare `zinq`) to avoid partial match corruption.

### Phase 2: Infrastructure Cutover (Manual, Post-Merge)

Follow this exact order to avoid downtime:

1. **Update `wrangler.toml`** — Add BOTH `zinq.vercel.app` AND `zinqq.vercel.app` to `ALLOWED_ORIGINS`
2. **Deploy Cloudflare Worker** — `cd proxy && wrangler deploy --env dev`
3. **Rename GitHub repo** — Settings → General → Repository name → `zinqq`
4. **Verify Vercel Git integration** — Check that Vercel still receives push webhooks after GitHub rename. Re-link if broken (Vercel Dashboard → Git → Reconnect)
5. **Rename Vercel project** — Vercel Dashboard → Settings → General → Project Name → `zinqq`
6. **Update local git remote** — `git remote set-url origin git@github.com:ConorOkus/zinqq.git`
7. **Remove old domain** from `wrangler.toml` `ALLOWED_ORIGINS` (keep only `zinqq.vercel.app`)
8. **Redeploy Cloudflare Worker** — `cd proxy && wrangler deploy --env dev`
9. **Optionally rename local directory** — `mv ~/Projects/zinq ~/Projects/zinqq`

## Technical Considerations

### Substring safety

A naive `sed s/zinq/zinqq/g` run twice would produce `zinqqq`. Each replacement must be a **single pass** using literal string matching. Use editor find-and-replace or `Edit` tool with `replace_all`, not chained regex.

### IndexedDB orphaning

Existing `zinq-ldk` databases in developer browsers will be abandoned. No migration needed (signet-only, per brainstorm decision). Developers should manually delete the old DB via DevTools if desired.

### Web Lock independence

During a rolling deploy, if two tabs run different code versions, they'll hold independent locks (`zinq-lock` vs `zinqq-lock`), defeating mutual exclusion. Acceptable for signet — would need migration logic for production.

### Claude memory directory

After local directory rename, the Claude memory path `/Users/conor/.claude/projects/-Users-conor-Projects-zinq/` will become stale. A new project directory will be auto-created at the new path. Relevant memories should be migrated manually.

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-28-rename-zinq-to-zinqq-brainstorm.md](docs/brainstorms/2026-03-28-rename-zinq-to-zinqq-brainstorm.md) — Key decisions: full scope rename, no DB migration, GitHub repo rename included
- **Prior rename plan:** [docs/plans/2026-03-16-004-refactor-rename-project-to-zinq-plan.md](docs/plans/2026-03-16-004-refactor-rename-project-to-zinq-plan.md) — Proven deployment order and patterns
- **Learnings:** Vercel serverless functions require flat file structure; Cloudflare worker CORS must include both old and new domains during transition
