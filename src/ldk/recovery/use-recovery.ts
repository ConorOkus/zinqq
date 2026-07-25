import { useState, useEffect, useCallback } from 'react'
import {
  readRecoveryState,
  writeRecoveryState,
  clearRecoveryState,
  roundUpDepositNeeded,
  type RecoveryState,
} from './recovery-state'
import type { RecoveryNeededInfo } from '../traits/event-handler'
import type { VssClient } from '../storage/vss-client'
import { captureError } from '../../storage/error-log'
import { getFeeRate } from '../../shared/fee-cache'

/** Custom event name used to bridge LDK event handler → React state. */
const RECOVERY_EVENT = 'zinqq:recovery-state-changed'

/** Fire from anywhere to trigger a re-read of recovery state in the hook. */
export function notifyRecoveryStateChanged(): void {
  window.dispatchEvent(new Event(RECOVERY_EVENT))
}

// Fee estimate: anchor CPFP typically needs ~140 vbytes. At current fee rate,
// calculate the approximate cost and round up with buffer.
const CPFP_VBYTES_ESTIMATE = 140
const FEE_TARGET_BLOCKS = 6

async function estimateDepositNeeded(): Promise<number> {
  try {
    const feeRate = await getFeeRate(FEE_TARGET_BLOCKS)
    const exactFee = Math.ceil(feeRate * CPFP_VBYTES_ESTIMATE)
    return roundUpDepositNeeded(exactFee)
  } catch {
    // Default to a safe amount if fee estimation fails
    return 25_000
  }
}

/**
 * Enter recovery state when a force-close CPFP fails.
 * Called from the LDK event handler callback (outside React).
 */
export async function enterRecovery(
  info: RecoveryNeededInfo,
  depositAddress: string,
  vssClient: VssClient | null
): Promise<void> {
  const existing = await readRecoveryState()

  if (existing) {
    // Aggregate: add channel to existing recovery. An unknown balance on
    // either side poisons the sum — a partial total displayed as THE stuck
    // balance would understate what's recoverable, so keep it null (shown
    // as "Unknown") rather than pretend precision.
    if (!existing.channelIds.includes(info.channelId)) {
      const updated: RecoveryState = {
        ...existing,
        channelIds: [...existing.channelIds, info.channelId],
        stuckBalanceSat:
          existing.stuckBalanceSat === null || info.localBalanceSat === null
            ? null
            : existing.stuckBalanceSat + info.localBalanceSat,
        depositNeededSat: await estimateDepositNeeded(),
        updatedAt: Date.now(),
      }
      await writeRecoveryState(updated, vssClient)
    }
  } else {
    const depositNeeded = await estimateDepositNeeded()
    const state: RecoveryState = {
      status: 'needs_recovery',
      stuckBalanceSat: info.localBalanceSat,
      depositAddress,
      depositNeededSat: depositNeeded,
      channelIds: [info.channelId],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await writeRecoveryState(state, vssClient)
  }

  notifyRecoveryStateChanged()
}

export interface UseRecoveryResult {
  recovery: RecoveryState | null
  /** Dismiss the success banner — clears all recovery state. */
  dismiss: () => Promise<void>
}

/**
 * React hook that exposes force-close recovery state.
 * Reads from IDB on mount and re-reads when notified via custom event.
 */
export function useRecovery(vssClient: VssClient | null): UseRecoveryResult {
  const [recovery, setRecovery] = useState<RecoveryState | null>(null)

  // Load on mount + listen for changes
  useEffect(() => {
    const load = () => {
      readRecoveryState()
        .then(setRecovery)
        .catch((err: unknown) =>
          captureError('error', 'useRecovery', 'Failed to load recovery state', String(err))
        )
    }

    load()
    window.addEventListener(RECOVERY_EVENT, load)
    return () => window.removeEventListener(RECOVERY_EVENT, load)
  }, [])

  const dismiss = useCallback(async () => {
    await clearRecoveryState(vssClient)
    setRecovery(null)
  }, [vssClient])

  return { recovery, dismiss }
}
