import type { Wallet, EsploraClient } from '@bitcoindevkit/bdk-wallet-web'
import { ONCHAIN_CONFIG } from './config'
import { putChangeset } from './storage/changeset'

export interface OnchainSyncHandle {
  stop: () => void
  pause: () => void
  resume: () => void
  syncNow: () => void
}

export interface OnchainBalance {
  confirmed: bigint
  trustedPending: bigint
  untrustedPending: bigint
}

export function startOnchainSyncLoop(
  wallet: Wallet,
  esploraClient: EsploraClient,
  onBalanceUpdate: (balance: OnchainBalance) => void,
): OnchainSyncHandle {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let paused = false
  let isSyncing = false
  let retriesRemaining = 0

  function readBalance(): OnchainBalance {
    const b = wallet.balance
    return {
      confirmed: b.confirmed.to_sat(),
      trustedPending: b.trusted_pending.to_sat(),
      untrustedPending: b.untrusted_pending.to_sat(),
    }
  }

  const SYNC_NOW_RETRIES = 3
  const SYNC_NOW_RETRY_MS = 3_000

  async function tick() {
    if (stopped || isSyncing) return
    if (paused) {
      scheduleNext()
      return
    }
    isSyncing = true
    try {
      const syncRequest = wallet.start_sync_with_revealed_spks()
      const update = await esploraClient.sync(
        syncRequest,
        ONCHAIN_CONFIG.syncParallelRequests,
      )
      wallet.apply_update(update)

      // Persist ChangeSet — take_staged() is destructive, so log on failure
      const staged = wallet.take_staged()
      if (staged && !staged.is_empty()) {
        try {
          await putChangeset(staged.to_json())
        } catch (err) {
          console.error('[BDK Sync] CRITICAL: failed to persist ChangeSet:', err)
        }
      }

      onBalanceUpdate(readBalance())
    } catch (err) {
      console.warn('[BDK Sync] Sync tick failed:', err)
    } finally {
      isSyncing = false
    }

    scheduleNext()
  }

  function scheduleNext() {
    if (stopped) return
    // If retries remain from a syncNow() request, use shorter interval
    if (retriesRemaining > 0) {
      retriesRemaining -= 1
      timeoutId = setTimeout(() => void tick(), SYNC_NOW_RETRY_MS)
    } else {
      timeoutId = setTimeout(() => void tick(), ONCHAIN_CONFIG.syncIntervalMs)
    }
  }

  // Emit initial balance immediately, then start sync loop
  onBalanceUpdate(readBalance())
  timeoutId = setTimeout(() => void tick(), ONCHAIN_CONFIG.syncIntervalMs)

  return {
    stop() {
      stopped = true
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
    syncNow() {
      if (stopped) return
      retriesRemaining = SYNC_NOW_RETRIES
      // Cancel pending tick and fire immediately
      if (timeoutId !== null) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      void tick()
    },
  }
}
