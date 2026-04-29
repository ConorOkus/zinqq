---
status: cancelled
priority: p3
issue_id: '247'
tags: [code-review, payjoin, devx, error-handling]
dependencies: []
---

# Postcondition check on `dist/` output in `build-payjoin-bindings.sh`

## Problem Statement

The script exits 0 if `npm run build` exits 0 — but doesn't verify that `dist/index.js` (or the WASM artefacts) actually got produced. If upstream's build script changes output paths, no-ops, or silently writes to a different directory, our script reports success while downstream consumers (Vite, the `payjoin` link: dep, CI artifact upload) fail far from the cause.

Today this is theoretical — upstream's `npm run build` is reliable — but the failure mode if it does silently no-op is hours of confused debugging.

## Findings

- `scripts/build-payjoin-bindings.sh:54` — `npm run build` is the last meaningful step; no postcondition check.

Flagged by `agent-native-reviewer` (P3).

## Proposed Solution

Add a check at the end:

```sh
# Sanity: confirm the build actually produced what callers expect.
test -s dist/index.js || { echo "error: build-payjoin-bindings.sh: dist/index.js missing or empty after build"; exit 1; }
test -s dist/index.web.js || { echo "error: build-payjoin-bindings.sh: dist/index.web.js missing or empty after build"; exit 1; }
test -s dist/generated/wasm-bindgen/index_bg.wasm || { echo "error: build-payjoin-bindings.sh: WASM output missing"; exit 1; }
```

- Effort: Trivial.
- Risk: None — only reports failures earlier and more clearly.

## Technical Details

- Affected file: `scripts/build-payjoin-bindings.sh`

## Acceptance Criteria

- [ ] Build script exits non-zero with a clear message if any of the three expected outputs are missing/empty
- [ ] Happy-path build still succeeds

## Work Log

## Resources

- PR #141

## Cancelled

2026-04-29 — Payjoin integration removed (chore/remove-payjoin). Reopen if Payjoin is re-integrated.
