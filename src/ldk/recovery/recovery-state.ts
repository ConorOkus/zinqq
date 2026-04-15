import { idbGet, idbPut, idbDelete } from '../../storage/idb'
import type { VssClient } from '../storage/vss-client'
import { isVssConflict } from '../storage/vss-client'
import { captureError } from '../../storage/error-log'

const IDB_STORE = 'ldk_force_close_recovery'
const IDB_KEY = 'state'
const VSS_KEY = 'force_close_recovery'

export type RecoveryStatus = 'needs_recovery' | 'sweep_confirmed'

export interface RecoveryState {
  status: RecoveryStatus
  stuckBalanceSat: number
  depositAddress: string
  depositNeededSat: number
  channelIds: string[]
  createdAt: number
  updatedAt: number
}

let vssVersion = 0

/**
 * Read recovery state from IDB (fast, local-only).
 * Used on startup to surface the banner immediately.
 */
export async function readRecoveryState(): Promise<RecoveryState | null> {
  try {
    const state = await idbGet<RecoveryState>(IDB_STORE, IDB_KEY)
    return state ?? null
  } catch (err: unknown) {
    captureError('error', 'RecoveryState', 'Failed to read from IDB', String(err))
    return null
  }
}

/**
 * Seed the VSS version on startup by fetching from VSS. Must be called
 * before any VSS writes to avoid version conflicts.
 */
export async function seedRecoveryVssVersion(vssClient: VssClient | null): Promise<void> {
  if (!vssClient) return
  try {
    const result = await vssClient.getObject(VSS_KEY)
    if (result) {
      vssVersion = result.version
      // Optionally reconcile: if VSS has state but IDB doesn't, write to IDB
      const local = await readRecoveryState()
      if (!local) {
        const decoded = JSON.parse(new TextDecoder().decode(result.value)) as RecoveryState
        await idbPut(IDB_STORE, IDB_KEY, decoded)
      }
    }
  } catch (err: unknown) {
    captureError('warning', 'RecoveryState', 'Failed to seed VSS version', String(err))
  }
}

/**
 * Write recovery state to both IDB (fast) and VSS (durable).
 * IDB is written first for immediate local access.
 */
export async function writeRecoveryState(
  state: RecoveryState,
  vssClient: VssClient | null
): Promise<void> {
  // Write IDB first (fast, always available)
  await idbPut(IDB_STORE, IDB_KEY, state)

  // Write VSS (durable, cross-device)
  if (vssClient) {
    try {
      const encoded = new TextEncoder().encode(JSON.stringify(state))
      vssVersion = await vssClient.putObject(VSS_KEY, encoded, vssVersion)
    } catch (err: unknown) {
      if (isVssConflict(err)) {
        // Re-fetch version and retry once
        try {
          const result = await vssClient.getObject(VSS_KEY)
          vssVersion = result?.version ?? 0
          const encoded = new TextEncoder().encode(JSON.stringify(state))
          vssVersion = await vssClient.putObject(VSS_KEY, encoded, vssVersion)
        } catch (retryErr: unknown) {
          captureError(
            'error',
            'RecoveryState',
            'VSS write failed after conflict retry',
            String(retryErr)
          )
        }
      } else {
        captureError('warning', 'RecoveryState', 'VSS write failed (IDB saved)', String(err))
      }
    }
  }
}

/**
 * Clear recovery state from both IDB and VSS.
 * Called when the user dismisses the success banner.
 */
export async function clearRecoveryState(vssClient: VssClient | null): Promise<void> {
  await idbDelete(IDB_STORE, IDB_KEY).catch((err: unknown) =>
    captureError('warning', 'RecoveryState', 'Failed to clear IDB', String(err))
  )

  if (vssClient) {
    try {
      await vssClient.deleteObject(VSS_KEY, vssVersion)
      vssVersion = 0
    } catch (err: unknown) {
      captureError('warning', 'RecoveryState', 'Failed to clear VSS', String(err))
    }
  }
}

/** Round up to a "comfortable" deposit amount with 50% buffer, in increments of 5000. */
export function roundUpDepositNeeded(exactSats: number): number {
  const buffered = Math.ceil(exactSats * 1.5)
  return Math.ceil(buffered / 5000) * 5000
}
