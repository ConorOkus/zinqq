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
 * The wire shape is hex of LDK's `Vec<BlindedMessagePath>::write()` — the whole
 * vector as one blob, with a length prefix — because that is what ldk-node's
 * uniffi bindings already emit and consume for async-recipient paths. Every
 * Swift/Kotlin ldk-node client speaks this form, so matching it means no
 * invented format. It is LDK's internal `Writeable` encoding rather than a BOLT
 * wire format, so both ends must pin the same LDK revision; the failure mode is
 * a decode error at bootstrap, not corrupted persisted state.
 *
 * Kept out of `config.ts` because that module is imported by tests that never
 * initialize WASM.
 */
export type ServerPathsResult =
  | { ok: true; paths: BlindedMessagePath[] }
  | { ok: false; reason: string }

const HEX_BLOB = /^(?:[0-9a-f]{2})+$/

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
 * when it cannot be resolved, which the caller treats as a failed identity
 * check rather than a pass.
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
 * Decode a hex-encoded `Vec<BlindedMessagePath>` and pin every path to the
 * configured server node id.
 *
 * Segmentation works because `constructor_read` consumes only the bytes one
 * path needs and tolerates trailing data, and re-serializing the decoded path
 * reproduces exactly those bytes — so the round-trip length is how far to
 * advance. Verified against real LDK in `handshake-harness.test.ts`.
 *
 * Fails the whole set on any bad entry: a partial registration would hand a
 * substituted server authority over the wallet's only receive code.
 */
export function decodeServerPaths(
  blobHex: string,
  expectedNodeIdHex: string,
  networkGraph: ReadOnlyNetworkGraph
): ServerPathsResult {
  const trimmed = blobHex.trim()
  if (trimmed === '') return { ok: true, paths: [] }
  if (!HEX_BLOB.test(trimmed)) {
    return { ok: false, reason: 'server paths blob is not even-length lowercase hex' }
  }

  const bytes = hexToBytes(trimmed)
  if (bytes.length < 2) {
    return { ok: false, reason: 'server paths blob is too short to contain a length prefix' }
  }

  // LDK writes a collection length as a big-endian u16, escaping to 0xffff plus
  // a BigSize for very large collections. A path set that large is not a real
  // input, so reject the escape rather than guessing at the wider encoding.
  const count = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)
  if (count === 0xffff) {
    return { ok: false, reason: 'server paths blob uses the extended length encoding' }
  }
  if (count === 0) {
    return { ok: false, reason: 'server paths blob declares zero paths' }
  }

  const paths: BlindedMessagePath[] = []
  let offset = 2

  for (let index = 0; index < count; index++) {
    if (offset >= bytes.length) {
      return { ok: false, reason: `server paths blob ended before path ${index}` }
    }

    const result = BlindedMessagePath.constructor_read(bytes.slice(offset))
    if (!(result instanceof Result_BlindedMessagePathDecodeErrorZ_OK)) {
      return { ok: false, reason: `path ${index} failed to decode as a blinded message path` }
    }

    const path = result.res
    const consumed = path.write().length
    if (consumed === 0) {
      return { ok: false, reason: `path ${index} decoded to zero bytes` }
    }
    offset += consumed

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

  if (offset !== bytes.length) {
    return {
      ok: false,
      reason: `server paths blob has ${bytes.length - offset} trailing byte(s) after ${count} path(s)`,
    }
  }

  return { ok: true, paths }
}
