/**
 * LSP contact resolution.
 *
 * Combines runtime discovery (LQwD primary) with env-var config
 * (Megalith fallback) into a primary/fallback pair consumed by the
 * receive flow.
 */

import { LDK_CONFIG } from '../config'
import { fetchLqwdContact } from './lqwd-discovery'

export type LspLabel = 'lqwd' | 'megalith'

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
 * Resolve the primary (LQwD via /get_info) and fallback (Megalith via
 * env vars) LSP contacts. Either side may be null if discovery failed
 * or the env config is empty.
 */
export async function resolveLspContacts(): Promise<LspContactPair> {
  const primary = await fetchLqwdContact().catch(() => null)
  const fallback: LspContact | null =
    LDK_CONFIG.lspNodeId && LDK_CONFIG.lspHost
      ? {
          nodeId: LDK_CONFIG.lspNodeId,
          host: LDK_CONFIG.lspHost,
          port: LDK_CONFIG.lspPort,
          token: LDK_CONFIG.lspToken ?? null,
          label: 'megalith',
        }
      : null
  return { primary, fallback }
}
