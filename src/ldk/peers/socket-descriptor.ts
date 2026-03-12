import { SocketDescriptor } from 'lightningdevkit'

let nextSocketId = BigInt(1)

export function createSocketDescriptor(ws: WebSocket): SocketDescriptor {
  const socketId = nextSocketId++

  return SocketDescriptor.new_impl({
    // resume_read parameter is required by LDK but unused — browser WebSocket has no back-pressure
    send_data(...args: [Uint8Array, boolean]): number {
      if (ws.readyState !== WebSocket.OPEN) return 0
      ws.send(args[0])
      return args[0].length
    },
    disconnect_socket(): void {
      ws.close()
    },
    eq(other: SocketDescriptor): boolean {
      return other.hash() === socketId
    },
    hash(): bigint {
      return socketId
    },
  })
}
