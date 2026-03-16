import {
  Result_CVec_u8ZPeerHandleErrorZ_OK,
  Result_boolPeerHandleErrorZ_OK,
  Option_SocketAddressZ,
  type PeerManager,
  type SocketDescriptor,
} from 'lightningdevkit'
import { createSocketDescriptor } from './socket-descriptor'
import { hexToBytes, bytesToHex } from '../utils'
import { SIGNET_CONFIG } from '../config'

const CONNECTION_TIMEOUT_MS = 15_000

export interface PeerConnection {
  disconnect: () => void
}

export function connectToPeer(
  peerManager: PeerManager,
  pubkeyHex: string,
  host: string,
  port: number
): Promise<PeerConnection> {
  if (!/^[0-9a-f]{66}$/.test(pubkeyHex)) {
    return Promise.reject(new Error('Invalid pubkey: must be 66 lowercase hex characters'))
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
    return Promise.reject(new Error('Invalid host: must contain only alphanumeric, dot, hyphen, or underscore'))
  }
  if (port < 1 || port > 65535) {
    return Promise.reject(new Error('Invalid port: must be between 1 and 65535'))
  }

  return new Promise((resolve, reject) => {
    const proxyHost = host.replace(/\./g, '_')
    const wsUrl = `${SIGNET_CONFIG.wsProxyUrl}/v1/${proxyHost}/${port}`
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'

    let descriptor: SocketDescriptor | null = null
    let resolved = false

    const peerConnection: PeerConnection = {
      disconnect: () => {
        if (descriptor) {
          peerManager.socket_disconnected(descriptor)
        }
        ws.close()
      },
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        // ws.close() triggers onclose, which calls socket_disconnected if descriptor exists
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
      if (!descriptor) return
      if (!(event.data instanceof ArrayBuffer)) return
      const data = new Uint8Array(event.data)

      const readResult = peerManager.read_event(descriptor, data)
      if (!(readResult instanceof Result_boolPeerHandleErrorZ_OK)) {
        cleanup()
        if (!resolved) {
          resolved = true
          ws.close()
          reject(new Error('Peer handshake failed'))
        }
        return
      }

      peerManager.process_events()

      // Check if handshake is complete (resolve the promise once)
      if (!resolved) {
        const peers = peerManager.list_peers()
        for (const peer of peers) {
          const peerPubkeyBytes = peer.get_counterparty_node_id()
          const peerPubkey = bytesToHex(peerPubkeyBytes)
          if (peerPubkey === pubkeyHex) {
            cleanup()
            resolved = true
            resolve(peerConnection)
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
  if (!/^[0-9a-f]{66}$/.test(pubkey)) {
    throw new Error('Invalid peer address: pubkey must be 66 lowercase hex characters')
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
    throw new Error('Invalid peer address: host must contain only alphanumeric, dot, hyphen, or underscore')
  }
  return { pubkey, host, port }
}
