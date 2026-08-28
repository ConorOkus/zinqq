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
 * There is no per-element length prefix, so the blob cannot be parsed by
 * skipping elements — each path must be fully decoded to find where the next
 * begins. That is a structural constraint of the encoding, not a shortcut here.
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

  // Framing confirmed against lightning 0.3.0+git rev 3dfcc4cc:
  // `impl_for_vec!(BlindedMessagePath)` (util/ser.rs:1162) uses the plain
  // variant — a CollectionLength followed by each element written directly,
  // with no per-element length prefix. CollectionLength (util/ser.rs:567-577)
  // is a big-endian u16 below 0xffff, escaping to an 0xffff marker followed by
  // a u64 of `len - 0xffff`.
  //
  // Reading only the u16 form is deliberate, not an oversight: the escape needs
  // 65,535+ paths, which is not a real input. Reject it loudly rather than
  // widening the parser for a case that would signal a malformed blob anyway.
  const count = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)
  if (count === 0xffff) {
    return {
      ok: false,
      reason: "server paths blob uses CollectionLength's extended (0xffff) encoding",
    }
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
