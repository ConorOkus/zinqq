/**
 * LSPS0 CustomMessageHandler implementation.
 *
 * Bridges synchronous LDK PeerManager callbacks to an async promise-based
 * message queue. The sync handler only does JSON parsing and Map lookups;
 * all protocol logic runs in async code.
 *
 * Threading safety: get_and_clear_pending_msg() cannot interleave with queue
 * pushes because both run on the single JS main thread within a synchronous
 * PeerManager call. Do not introduce await or queueMicrotask between push
 * and drain without revisiting this invariant.
 */

import {
  CustomMessageHandler,
  Result_NoneLightningErrorZ,
  Result_NoneNoneZ,
  Result_COption_TypeZDecodeErrorZ,
  Option_TypeZ,
  TwoTuple_PublicKeyTypeZ,
  Type,
  NodeFeatures,
  InitFeatures,
  type Init,
} from 'lightningdevkit'
import { bytesToHex } from '../utils'
import { captureError } from '../../storage/error-log'
import {
  LSPS_MESSAGE_TYPE,
  MAX_LSPS_MESSAGE_BYTES,
  deserializeJsonRpcResponse,
  type JsonRpcResponse,
} from './types'

const LSPS_FEATURE_BIT = 729
const REQUEST_TIMEOUT_MS = 30_000
const REAPER_INTERVAL_MS = 5_000
const MAX_PENDING_PER_PEER = 10

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: Error) => void
  createdAt: number
  peerHex: string
}

export interface LspsMessageHandlerResult {
  handler: CustomMessageHandler
  sendRequest: (peerPubkey: Uint8Array, payload: string) => Promise<JsonRpcResponse>
  destroy: () => void
  /** Set a callback to flush outbound messages (call peerManager.process_events()) */
  setFlushCallback: (cb: () => void) => void
}

export function createLspsMessageHandler(): LspsMessageHandlerResult {
  const pending = new Map<string, PendingRequest>()
  const outbound: Array<{ pubkey: Uint8Array; payload: string }> = []
  let flushCallback: (() => void) | null = null

  // Timeout reaper: reject promises older than REQUEST_TIMEOUT_MS
  const reaperTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of pending) {
      if (now - entry.createdAt > REQUEST_TIMEOUT_MS) {
        entry.reject(new Error('LSPS2 request timed out'))
        pending.delete(id)
      }
    }
  }, REAPER_INTERVAL_MS)

  function sendRequest(peerPubkey: Uint8Array, payload: string): Promise<JsonRpcResponse> {
    const peerHex = bytesToHex(peerPubkey)

    // Cap pending requests per peer
    let peerCount = 0
    for (const entry of pending.values()) {
      if (entry.peerHex === peerHex) peerCount++
    }
    if (peerCount >= MAX_PENDING_PER_PEER) {
      return Promise.reject(new Error('Too many pending LSPS requests for this peer'))
    }

    // Extract JSON-RPC ID from the serialized payload
    const parsed = JSON.parse(payload) as { id: string }
    const requestId = parsed.id

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(requestId, { resolve, reject, createdAt: Date.now(), peerHex })
      outbound.push({ pubkey: peerPubkey, payload })
      // Flush outbound queue immediately via PeerManager.process_events()
      queueMicrotask(() => flushCallback?.())
    })
  }

  const handler = CustomMessageHandler.new_impl(
    {
      handle_custom_message(msg: Type, senderNodeId: Uint8Array): Result_NoneLightningErrorZ {
        const bytes = msg.write()

        if (bytes.length > MAX_LSPS_MESSAGE_BYTES) {
          captureError('warning', 'LSPS2', `Dropping oversized message: ${bytes.length} bytes`)
          return Result_NoneLightningErrorZ.constructor_ok()
        }

        let text: string
        try {
          text = new TextDecoder().decode(bytes)
        } catch {
          captureError('warning', 'LSPS2', 'Failed to decode message as UTF-8')
          return Result_NoneLightningErrorZ.constructor_ok()
        }

        let response: JsonRpcResponse
        try {
          response = deserializeJsonRpcResponse(text)
        } catch (err) {
          captureError('warning', 'LSPS2', 'Failed to parse JSON-RPC response', String(err))
          return Result_NoneLightningErrorZ.constructor_ok()
        }

        const pendingEntry = pending.get(response.id)
        if (pendingEntry) {
          const senderHex = bytesToHex(senderNodeId)
          if (senderHex === pendingEntry.peerHex) {
            pending.delete(response.id)
            pendingEntry.resolve(response)
          }
        }

        return Result_NoneLightningErrorZ.constructor_ok()
      },

      get_and_clear_pending_msg(): TwoTuple_PublicKeyTypeZ[] {
        if (outbound.length === 0) return []

        const messages = outbound.splice(0)
        return messages.map(({ pubkey, payload }) => {
          const bytes = new TextEncoder().encode(payload)
          const msgType = Type.new_impl({
            type_id(): number {
              return LSPS_MESSAGE_TYPE
            },
            debug_str(): string {
              return `LSPS message (${bytes.length} bytes)`
            },
            write(): Uint8Array {
              return bytes
            },
          })
          return TwoTuple_PublicKeyTypeZ.constructor_new(pubkey, msgType)
        })
      },

      peer_disconnected(theirNodeId: Uint8Array): void {
        const peerHex = bytesToHex(theirNodeId)
        for (const [id, entry] of pending) {
          if (entry.peerHex === peerHex) {
            entry.reject(new Error('LSP peer disconnected'))
            pending.delete(id)
          }
        }
      },

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      peer_connected(_theirNodeId: Uint8Array, _msg: Init, _inbound: boolean): Result_NoneNoneZ {
        return Result_NoneNoneZ.constructor_ok()
      },

      provided_node_features(): NodeFeatures {
        const features = NodeFeatures.constructor_empty()
        features.set_optional_custom_bit(LSPS_FEATURE_BIT)
        return features
      },

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      provided_init_features(_theirNodeId: Uint8Array): InitFeatures {
        const features = InitFeatures.constructor_empty()
        features.set_optional_custom_bit(LSPS_FEATURE_BIT)
        return features
      },
    },
    {
      read(messageType: number, buffer: Uint8Array): Result_COption_TypeZDecodeErrorZ {
        if (messageType !== LSPS_MESSAGE_TYPE) {
          return Result_COption_TypeZDecodeErrorZ.constructor_ok(Option_TypeZ.constructor_none())
        }

        const capturedBuffer = new Uint8Array(buffer)
        const customType = Type.new_impl({
          type_id(): number {
            return LSPS_MESSAGE_TYPE
          },
          debug_str(): string {
            return `LSPS message (${capturedBuffer.length} bytes)`
          },
          write(): Uint8Array {
            return capturedBuffer
          },
        })

        return Result_COption_TypeZDecodeErrorZ.constructor_ok(
          Option_TypeZ.constructor_some(customType)
        )
      },
    }
  )

  function destroy(): void {
    clearInterval(reaperTimer)
    flushCallback = null
    for (const [id, entry] of pending) {
      entry.reject(new Error('LSPS message handler destroyed'))
      pending.delete(id)
    }
  }

  function setFlushCallback(cb: () => void): void {
    flushCallback = cb
  }

  return { handler, sendRequest, destroy, setFlushCallback }
}
