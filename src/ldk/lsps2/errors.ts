/**
 * Typed LSPS2 transport errors.
 *
 * The hand-rolled client speaks LSPS2 over the Lightning peer connection
 * (BOLT8 custom messages). These typed errors let callers distinguish transport
 * failure modes for telemetry and for the buy-vs-quote failover decision.
 *
 * All of these are non-`AbortError`, so on the quote path they remain
 * failover-eligible (see `runJitQuoteFlow` in `context.tsx`, which only skips
 * fallback on external `AbortError`). On the buy path they surface to the user
 * without triggering failover (a committed buy is not failover-eligible).
 */

/** Base class for all LSPS2 peer-transport failures. */
export class Lsps2TransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Lsps2TransportError'
  }
}

/** A pending request outlived the transport timeout without a response. */
export class Lsps2TimeoutError extends Lsps2TransportError {
  constructor(message = 'LSPS2 request timed out') {
    super(message)
    this.name = 'Lsps2TimeoutError'
  }
}

/** The LSP peer disconnected while a request was in flight. */
export class Lsps2PeerDisconnectedError extends Lsps2TransportError {
  constructor(message = 'LSP peer disconnected') {
    super(message)
    this.name = 'Lsps2PeerDisconnectedError'
  }
}

/** The message handler was torn down (node shutdown) with requests pending. */
export class Lsps2HandlerDestroyedError extends Lsps2TransportError {
  constructor(message = 'LSPS message handler destroyed') {
    super(message)
    this.name = 'Lsps2HandlerDestroyedError'
  }
}

/** Too many concurrent pending requests for a single peer. */
export class Lsps2BackpressureError extends Lsps2TransportError {
  constructor(message = 'Too many pending LSPS requests for this peer') {
    super(message)
    this.name = 'Lsps2BackpressureError'
  }
}
