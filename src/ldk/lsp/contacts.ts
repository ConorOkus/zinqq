/**
 * LSP contact resolution.
 *
 * Builds the LSP contact pair from env-var config. Megalith is the sole LSP and
 * occupies the `primary` slot; the `fallback` slot is retained (currently always
 * null) so a second LSP can be re-introduced without reworking the receive
 * flow's primary/fallback failover orchestration.
 */

import { LDK_CONFIG } from '../config'

/**
 * Free-form telemetry / display tag for an LSP. Only `'megalith'` is configured
 * today; the failover orchestration is label-agnostic, so additional LSPs can be
 * added without changing this type.
 */
export type LspLabel = string

export interface LspContact {
  nodeId: string
  host: string
  port: number
  token: string | null
  label: LspLabel
}

export interface LspContactPair {
  primary: LspContact | null
  fallback: LspContact | null
}

/**
 * Resolve the primary (Megalith, via env vars) LSP contact. `primary` is null
 * when the env config is empty (LSPS2 disabled). `fallback` is currently always
 * null — the slot is kept for a future second LSP.
 *
 * Returns a `Promise` (though resolution is synchronous today) so a future
 * async discovery step can be reintroduced without changing call sites.
 */
export function resolveLspContacts(): Promise<LspContactPair> {
  const primary: LspContact | null =
    LDK_CONFIG.lspNodeId && LDK_CONFIG.lspHost
      ? {
          nodeId: LDK_CONFIG.lspNodeId,
          host: LDK_CONFIG.lspHost,
          port: LDK_CONFIG.lspPort,
          token: LDK_CONFIG.lspToken ?? null,
          label: 'megalith',
        }
      : null
  return Promise.resolve({ primary, fallback: null })
}
