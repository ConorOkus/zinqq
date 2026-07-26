---
title: 'VSS key-per-record cannot restore: HMAC-obfuscated keys are not enumerable — use a singleton map key with field-wise merge'
category: design-patterns
date: 2026-07-21
tags: [vss, persistence, cross-device, hmac, key-design, close-records, crdt]
modules: [src/ldk/close-records/store, src/ldk/storage/vss-crypto, src/ldk/storage/vss-write]
---

# VSS key-per-record cannot restore: HMAC-obfuscated keys are not enumerable — use a singleton map key with field-wise merge

## Problem

A growing set of records (channel-close records) was designed as key-per-record on VSS
(`close_record_<channelId>`) for independent versioning. Data-integrity review found this
can **never restore cross-device**: a fresh device has no way to discover which record
keys exist.

## Root Cause

Every VSS key is HMAC-SHA256-obfuscated before hitting the server
(`src/ldk/storage/vss-crypto.ts:48-66`). `listKeyVersions()` therefore returns opaque
digests — there is no prefix scan and no reverse mapping. The existing monitor restore
works only because it is **manifest-driven** (a known key lists the member keys); it
restores nothing generically.

## Solution

For record _sets_ that must restore cross-device, choose one of:

1. **Singleton map key (chosen for close records)** — the whole
   `Record<channelId, SerializedRecord>` lives under one key (`close_records`),
   restorable through a single `getObject`. The cost — cross-device write conflicts on the
   shared key — is paid with a **field-wise merge on 409**: fetch the remote map, merge
   record-by-record with monotonic per-field rules (set-once identity facts, union-by-txid
   tx lists, verified-absorbs-unverified), then rewrite
   (`src/ldk/close-records/store.ts`, `persistLocked`). The stock
   `vssWriteWithConflictRetry` helper is **blob last-writer-wins** and would silently
   discard the other device's facts — do not reuse it for mergeable state.
2. **Manifest key** (the monitor pattern) — worth it only when values are large enough
   that one blob per write hurts (monitors), since it adds a second write, its own
   conflict handling, and listed-but-missing tolerance on restore.

Merge-safety is what makes the singleton cheap: because record merges are monotonic
(CRDT-ish), a lost race is healed by the next merge or by reconciliation — no data can be
destroyed, only delayed.

## Prevention

Any new VSS-persisted collection must answer "how does a fresh device discover the keys?"
at design time. If the answer is `listKeyVersions` + prefix filtering, the design is
broken — keys are HMAC-obfuscated. Default to a singleton map with a merge function;
escalate to a manifest only for monitor-sized values.
