import {
  Result_CVec_u8ZPeerHandleErrorZ_OK,
  Result_boolPeerHandleErrorZ_OK,
  Option_SocketAddressZ,
  type PeerManager,
  type SocketDescriptor,
} from 'lightningdevkit'
import { createSocketDescriptor } from './socket-descriptor'
import { hexToBytes } from '../utils'
import { SIGNET_CONFIG } from '../config'

const CONNECTION_TIMEOUT_MS = 15_000

export function connectToPeer(
  peerManager: PeerManager,
  pubkeyHex: string,
  host: string,
  port: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proxyHost = host.replace(/\./g, '_')
    const wsUrl = `${SIGNET_CONFIG.wsProxyUrl}/v1/${proxyHost}/${port}`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    let descriptor: SocketDescriptor | null = null
    let resolved = false

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        ws.close()
        reject(new Error('Connection timed out'))
      }
    }, CONNECTION_TIMEOUT_MS)

    function cleanup() {
      clearTimeout(timeout)
    }

    ws.onopen = () => {
      descriptor = createSocketDescriptor(ws)
      const theirNodeId = hexToBytes(pubkeyHex)

      const initResult = peerManager.new_outbound_connection(
        theirNodeId,
        descriptor,
        Option_SocketAddressZ.constructor_none()
      )

      if (!(initResult instanceof Result_CVec_u8ZPeerHandleErrorZ_OK)) {
        cleanup()
        resolved = true
        ws.close()
        reject(new Error('Failed to initiate outbound connection'))
        return
      }

      // Send Noise Act One
      ws.send(initResult.res)
    }

    ws.onmessage = (event) => {
      if (!descriptor || resolved) return
      const data = new Uint8Array(event.data as ArrayBuffer)

      const readResult = peerManager.read_event(descriptor, data)
      if (!(readResult instanceof Result_boolPeerHandleErrorZ_OK)) {
        cleanup()
        resolved = true
        ws.close()
        reject(new Error('Peer handshake failed'))
        return
      }

      peerManager.process_events()

      // Check if handshake is complete
      if (!resolved) {
        const peers = peerManager.list_peers()
        for (const peer of peers) {
          const peerPubkeyBytes = peer.get_counterparty_node_id()
          const peerPubkey = Array.from(peerPubkeyBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          if (peerPubkey === pubkeyHex) {
            cleanup()
            resolved = true
            resolve()
            return
          }
        }
      }
    }

    ws.onerror = () => {
      if (!resolved) {
        cleanup()
        resolved = true
        reject(new Error(`WebSocket connection to proxy failed`))
      }
    }

    ws.onclose = () => {
      if (descriptor) {
        peerManager.socket_disconnected(descriptor)
      }
      if (!resolved) {
        cleanup()
        resolved = true
        reject(new Error('Connection closed before handshake completed'))
      }
    }
  })
}

export function parsePeerAddress(address: string): { pubkey: string; host: string; port: number } {
  const atIndex = address.indexOf('@')
  if (atIndex === -1) {
    throw new Error('Invalid peer address: expected pubkey@host:port')
  }
  const pubkey = address.slice(0, atIndex)
  const hostPort = address.slice(atIndex + 1)
  const colonIndex = hostPort.lastIndexOf(':')
  if (colonIndex === -1) {
    throw new Error('Invalid peer address: expected host:port after @')
  }
  const host = hostPort.slice(0, colonIndex)
  const port = parseInt(hostPort.slice(colonIndex + 1), 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('Invalid peer address: port must be a number between 1 and 65535')
  }
  if (pubkey.length !== 66) {
    throw new Error('Invalid peer address: pubkey must be 66 hex characters')
  }
  return { pubkey, host, port }
}
