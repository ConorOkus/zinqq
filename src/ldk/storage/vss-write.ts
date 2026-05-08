/**
 * Shared VSS-write helper used by all per-key persisters: ChannelManager
 * (`persist-cm.ts`), known-peers (`known-peers.ts`), and recovery-state
 * (`recovery-state.ts`). Encapsulates:
 *   1. `putObject` with version tracking,
 *   2. conflict-retry-once for genuine server version drift,
 *   3. takeover-grace check that refuses to overwrite when a 409 lands
 *      within the wallet-lock takeover window (see PR #158, todo #347).
 *
 * Each persister still owns its own encode + IDB write — those vary too
 * much for a single abstraction. This helper handles only the VSS step.
 */

import { walletLockAcquiredAt } from '../init'
import { isVssConflict, type VssClient } from './vss-client'

const TAKEOVER_GRACE_MS = 1_000

/**
 * Error thrown when a VSS conflict is observed inside the takeover-grace
 * window. The previous active tab's late `putObject` likely landed after
 * we read the initial version but before this write; overwriting would
 * clobber state that the loser tab persisted just before tear-down.
 */
export class VssConflictDuringTakeoverError extends Error {
  readonly correctedVersion: number
  constructor(correctedVersion: number) {
    super(
      `VSS 409 within ${TAKEOVER_GRACE_MS}ms of acquiring wallet lock — likely former tab's late write. Refusing to overwrite.`
    )
    this.name = 'VssConflictDuringTakeoverError'
    this.correctedVersion = correctedVersion
  }
}

export interface VssWriteOptions {
  /** Test-only override for `walletLockAcquiredAt`. */
  walletLockAcquiredAtOverride?: number | null
}

/**
 * Write `data` to VSS at `key` using `versionRef.current` as the expected
 * version. Updates `versionRef.current` on success.
 *
 * On 409 (CONFLICT_EXCEPTION):
 *   1. Refetch the server's version, update `versionRef.current`.
 *   2. If we're inside the takeover-grace window, throw
 *      `VssConflictDuringTakeoverError` without retrying. The caller's
 *      mustRetry path will pick up on the next schedule().
 *   3. Otherwise, retry once with the corrected version.
 */
export async function vssWriteWithConflictRetry(
  vssClient: VssClient,
  key: string,
  data: Uint8Array,
  versionRef: { current: number },
  opts: VssWriteOptions = {}
): Promise<void> {
  try {
    versionRef.current = await vssClient.putObject(key, data, versionRef.current)
  } catch (err: unknown) {
    if (!isVssConflict(err)) throw err

    const serverObj = await vssClient.getObject(key)
    const correctedVersion = serverObj ? serverObj.version : 0
    versionRef.current = correctedVersion

    const acquiredAt = opts.walletLockAcquiredAtOverride ?? walletLockAcquiredAt
    if (acquiredAt !== null && Date.now() - acquiredAt < TAKEOVER_GRACE_MS) {
      throw new VssConflictDuringTakeoverError(correctedVersion)
    }

    versionRef.current = await vssClient.putObject(key, data, correctedVersion)
  }
}
