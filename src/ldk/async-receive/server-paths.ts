import {
  BlindedMessagePath,
  IntroductionNode_NodeId,
  Result_BlindedMessagePathDecodeErrorZ_OK,
  type ReadOnlyNetworkGraph,
} from 'lightningdevkit'
import { bytesToHex } from '../utils'

/**
 * Decoding of the static invoice server's blinded message paths.
 *
 * Kept out of `config.ts` because that module is imported by tests that never
 * initialize WASM — `BlindedMessagePath.constructor_read` is WASM-backed, so it
 * cannot run at config-load time. `config.ts` validates the hex *shape*; this
 * module owns the actual decode and returns a discriminated result rather than
 * throwing, so a decode failure leaves the feature off instead of bricking
 * startup.
 */
export type ServerPathsResult =
  | { ok: true; paths: BlindedMessagePath[] }
  | { ok: false; reason: string }

/** Split the comma-separated config value into trimmed, non-empty entries. */
export function splitServerPathEntries(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

const HEX_ENTRY = /^(?:[0-9a-f]{2})+$/

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Resolve the hex node id a blinded path's introduction node points at.
 *
 * Paths built with a compact introduction node carry a directed short channel
 * id instead of a pubkey; those need the network graph to resolve. Returns null
 * when the introduction node cannot be resolved, which the caller treats as a
 * failed identity check rather than a pass.
 */
export function introductionNodeIdHex(
  path: BlindedMessagePath,
  networkGraph: ReadOnlyNetworkGraph
): string | null {
  try {
    const introduction = path.introduction_node()
    if (introduction instanceof IntroductionNode_NodeId) {
      return bytesToHex(introduction.node_id)
    }

    const resolved = path.public_introduction_node_id(networkGraph)
    if (!resolved) return null
    const bytes = resolved.as_slice()
    if (!bytes || bytes.length === 0) return null
    return bytesToHex(bytes)
  } catch {
    // An unresolvable compact introduction node can throw out of WASM. Treat it
    // as a failed identity check, never as a pass.
    return null
  }
}

/**
 * Decode the configured path entries and pin every one of them to the
 * configured server node id.
 *
 * Fails the whole set on any bad entry. A partial registration would hand a
 * substituted server authority over the wallet's only receive code, so the
 * safe direction is to register nothing.
 */
export function decodeServerPaths(
  entries: string[],
  expectedNodeIdHex: string,
  networkGraph: ReadOnlyNetworkGraph
): ServerPathsResult {
  if (entries.length === 0) return { ok: true, paths: [] }

  const paths: BlindedMessagePath[] = []

  for (const [index, entry] of entries.entries()) {
    // `config.ts` already validates the hex shape at load, but this function is
    // the module boundary — re-check so a bad entry can never reach hexToBytes,
    // where a non-hex pair would silently decode to a zero byte.
    if (!HEX_ENTRY.test(entry)) {
      return { ok: false, reason: `path ${index} is not even-length lowercase hex` }
    }

    const result = BlindedMessagePath.constructor_read(hexToBytes(entry))
    if (!(result instanceof Result_BlindedMessagePathDecodeErrorZ_OK)) {
      return { ok: false, reason: `path ${index} failed to decode as a blinded message path` }
    }

    const path = result.res
    const introductionNodeId = introductionNodeIdHex(path, networkGraph)
    if (introductionNodeId === null) {
      return { ok: false, reason: `path ${index} has an unresolvable introduction node` }
    }
    if (introductionNodeId !== expectedNodeIdHex) {
      return {
        ok: false,
        reason: `path ${index} introduces at ${introductionNodeId}, expected ${expectedNodeIdHex}`,
      }
    }

    paths.push(path)
  }

  return { ok: true, paths }
}
