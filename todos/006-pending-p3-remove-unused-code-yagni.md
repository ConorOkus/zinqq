---
status: complete
priority: p3
issue_id: '006'
tags: [code-review, quality, yagni]
dependencies: []
---

# Remove unused code (YAGNI)

## Items

1. `idbGetAll` in `idb.ts` (22 lines, zero callers)
2. 3 unused IndexedDB stores: `ldk_channel_manager`, `ldk_network_graph`, `ldk_scorer`
3. `genesisBlockHash` in `config.ts` (unused)
4. Logger switch: collapse Gossip/Trace/Debug into one case, add default
5. `archive_persisted_channel` comment says "move to archive" but code deletes — fix comment
6. Config test hardcodes enum ordinal `4` instead of `Network.LDKNetwork_Signet`

## Acceptance Criteria

- [ ] No unused exports remain
- [ ] All comments match code behavior
- [ ] Tests use named constants not magic numbers
