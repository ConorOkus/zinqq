---
status: pending
priority: p2
issue_id: 144
tags: [code-review, quality]
dependencies: []
---

# Extract private #post helper to deduplicate VssClient fetch calls

## Problem Statement

Every VssClient method repeats the same ~15-line fetch pattern: try/catch, AbortSignal.timeout, headers, Content-Type, VssError wrapping. This is 5 copies of identical boilerplate. If timeout or headers need to change, all 5 must be updated.

Flagged by: TypeScript reviewer, Simplicity reviewer.

## Findings

- `src/ldk/storage/vss-client.ts` — getObject, putObject, putObjects, deleteObject, listKeyVersions all repeat the same fetch+error pattern

## Proposed Solutions

Extract a private method:
```typescript
async #post(endpoint: string, body: Uint8Array): Promise<Response> {
  try {
    return await fetch(`${this.#baseUrl}/${endpoint}`, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(await this.#auth.getHeaders()),
      },
    })
  } catch (err) {
    throw new VssError(
      `[VSS] ${endpoint} network error: ${err instanceof Error ? err.message : String(err)}`,
      ErrorCode.UNKNOWN, 0,
    )
  }
}
```

- **Effort**: Small
- **Risk**: None

## Acceptance Criteria

- [ ] Single `#post` helper used by all methods
- [ ] All existing tests still pass
