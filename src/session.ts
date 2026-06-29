import { randomUUID } from "node:crypto"
import {
  MessageType,
  type CallOptions,
  type ConnectionContext,
  type Frame,
  type Listeners,
  type LocalHandlers,
  type Middleware,
  type SessionOptions,
  type Socket,
} from "./types.js"
import { decode, encode, FrameError } from "./codec.js"
import {
  buildReceivedError,
  resolveHandler,
  toCallErrorFrame,
} from "./errors.js"
import { runLocal } from "./middleware.js"
import { log } from "./logger.js"

/** Rejection reason for a call that did not get a response in time. */
export class TimeoutError extends Error {
  code = "Timeout"
  constructor(action: string) {
    super(`Call '${action}' timed out`)
    this.name = "TimeoutError"
  }
}

/** Rejection reason for a call abandoned because the connection closed. */
export class ClosedError extends Error {
  code = "ConnectionClosed"
  constructor() {
    super("Connection closed before response")
    this.name = "ClosedError"
  }
}

interface OutboundCall {
  id?: string
  action: string
  payload: unknown
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  timer: ReturnType<typeof setTimeout>
  settled: boolean
}

export interface SessionConfig extends SessionOptions {
  local?: LocalHandlers
  middleware?: Middleware[]
  listeners?: Listeners
}

/**
 * Per-connection session: drives a Socket, correlates calls by id, serializes
 * outbound calls (one in flight at a time), enforces initiation-time timeouts
 * (covering queue-wait), runs inbound dispatch through local middleware, and
 * manages idle-timeout liveness plus an optional native ping.
 */
export class Session {
  readonly ctx: ConnectionContext

  private readonly socket: Socket
  private readonly local: LocalHandlers
  private readonly middleware: Middleware[]
  private readonly listeners: Listeners
  private readonly callTimeout: number
  private readonly keepAliveTimeout: number
  private readonly pingInterval: number
  private readonly maxFrameSize: number
  private readonly parserOpts: { parser?: SessionOptions["messageParser"] }
  private readonly serializerOpts: {
    serializer?: SessionOptions["messageSerializer"]
  }

  private open = false
  private closed = false
  private readonly queue: OutboundCall[] = []
  private inflight: OutboundCall | null = null
  private lastActivity = Date.now()
  private keepAliveTimer?: ReturnType<typeof setInterval>
  private pingTimer?: ReturnType<typeof setInterval>

  constructor(socket: Socket, ctx: ConnectionContext, config: SessionConfig) {
    this.socket = socket
    this.ctx = ctx
    this.local = config.local ?? {}
    this.middleware = config.middleware ?? []
    this.listeners = config.listeners ?? {}
    this.callTimeout = config.callTimeout ?? 30_000
    this.keepAliveTimeout = config.keepAliveTimeout ?? 0
    this.pingInterval = config.pingInterval ?? 0
    this.maxFrameSize = config.maxFrameSize ?? 65536
    this.parserOpts = { parser: config.messageParser }
    this.serializerOpts = { serializer: config.messageSerializer }

    socket.onOpen(() => this.handleOpen())
    socket.onMessage((data) => this.handleMessage(data))
    socket.onClose((code, reason) => this.handleClose(code, reason))
    socket.onError((err) => log().warn("ocpp-transport: socket error", err))
    socket.onPong?.(() => {
      this.lastActivity = Date.now()
    })
  }

  /** Make an outbound call. Returns a promise resolved with the CALLRESULT. */
  call(action: string, payload: unknown, opts?: CallOptions): Promise<unknown> {
    if (this.closed) return Promise.reject(new ClosedError())
    const timeout = opts?.timeout ?? this.callTimeout
    return new Promise((resolve, reject) => {
      const c: OutboundCall = {
        action,
        payload,
        resolve,
        reject,
        settled: false,
        // Per-call timer scheduled at ENQUEUE time, so it covers queue-wait,
        // not only time after the frame is sent.
        timer: setTimeout(() => this.timeoutCall(c), timeout),
      }
      this.queue.push(c)
      this.flush()
    })
  }

  /** Force-close the connection. */
  close(code = 1000, reason = ""): void {
    if (!this.closed) this.socket.close(code, reason)
  }

  // --- internals ---

  private handleOpen(): void {
    if (this.open || this.closed) return
    this.open = true
    this.lastActivity = Date.now()
    this.startTimers()
    this.listeners.connected?.(this.ctx)
    this.flush()
  }

  private startTimers(): void {
    if (this.keepAliveTimeout > 0) {
      const period = Math.max(20, Math.floor(this.keepAliveTimeout / 4))
      this.keepAliveTimer = setInterval(() => {
        if (Date.now() - this.lastActivity > this.keepAliveTimeout) {
          log().warn(
            `ocpp-transport: ${this.ctx.id} idle past keepAliveTimeout, closing`,
          )
          this.close(1001, "keep-alive timeout")
        }
      }, period)
      this.keepAliveTimer.unref?.()
    }
    // Native ping is emitted directly on the socket — NOT through the
    // serialized outbound call queue — so liveness cannot be head-of-line
    // blocked by an in-flight application call.
    if (this.pingInterval > 0 && this.socket.ping) {
      this.pingTimer = setInterval(() => this.socket.ping?.(), this.pingInterval)
      this.pingTimer.unref?.()
    }
  }

  private flush(): void {
    if (!this.open || this.closed || this.inflight) return
    const c = this.queue.shift()
    if (!c) return
    c.id = randomUUID()
    this.inflight = c
    this.send([MessageType.Call, c.id, c.action, c.payload])
  }

  private timeoutCall(c: OutboundCall): void {
    if (c.settled) return
    this.settle(c, () => c.reject(new TimeoutError(c.action)))
    if (this.inflight === c) {
      this.inflight = null
      this.flush()
    } else {
      const i = this.queue.indexOf(c)
      if (i >= 0) this.queue.splice(i, 1)
    }
  }

  private settle(c: OutboundCall, run: () => void): void {
    if (c.settled) return
    c.settled = true
    clearTimeout(c.timer)
    run()
  }

  private send(frame: Frame): void {
    const data = encode(frame as unknown[], this.serializerOpts)
    this.socket.send(data)
    this.listeners.messageOut?.(this.ctx, data)
  }

  private handleMessage(data: string): void {
    this.lastActivity = Date.now()
    this.listeners.messageIn?.(this.ctx, data)

    let frame: Frame
    try {
      frame = decode(data, {
        parser: this.parserOpts.parser,
        maxFrameSize: this.maxFrameSize,
      })
    } catch (e) {
      // Scoped parse failure — log and drop the frame; do not tear down the
      // connection or other in-flight calls.
      log().warn(
        `ocpp-transport: dropping unparseable frame from ${this.ctx.id}`,
        e instanceof FrameError ? e.message : e,
      )
      return
    }

    switch (frame[0]) {
      case MessageType.Call:
        void this.dispatchCall(frame[1], frame[2], frame[3])
        break
      case MessageType.CallResult:
        this.handleResult(frame[1], frame[2])
        break
      case MessageType.CallError:
        this.handleError(frame[1], frame[2], frame[3], frame[4])
        break
    }
  }

  private async dispatchCall(
    id: string,
    action: string,
    payload: unknown,
  ): Promise<void> {
    const handler = resolveHandler(this.local, action)
    if (!handler) {
      this.send([
        MessageType.CallError,
        id,
        "NotImplemented",
        `Action '${action}' is not implemented`,
        null,
      ])
      return
    }
    try {
      const result = await runLocal(
        this.middleware,
        this.ctx,
        payload,
        MessageType.Call,
        (p) => Promise.resolve(handler(p as any, this.ctx)),
      )
      this.send([MessageType.CallResult, id, result ?? null])
    } catch (err) {
      this.send(toCallErrorFrame(id, err))
    }
  }

  private handleResult(id: string, result: unknown): void {
    const c = this.inflight
    if (c?.id !== id) return // unknown / already-settled id — ignore
    this.inflight = null
    this.settle(c, () => c.resolve(result))
    this.flush()
  }

  private handleError(
    id: string,
    code: string,
    description: string,
    details: unknown,
  ): void {
    const c = this.inflight
    if (c?.id !== id) return
    this.inflight = null
    this.settle(c, () => c.reject(buildReceivedError(code, description, details)))
    this.flush()
  }

  private handleClose(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.open = false
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    const closedErr = new ClosedError()
    if (this.inflight) {
      const c = this.inflight
      this.inflight = null
      this.settle(c, () => c.reject(closedErr))
    }
    for (const c of this.queue.splice(0)) {
      this.settle(c, () => c.reject(closedErr))
    }
    this.listeners.disconnected?.(this.ctx, code, reason)
  }
}

/**
 * Build the typed proxy whose property access becomes a serialized outbound
 * call: `remote.Authorize(payload)` or `remote[action](payload)`.
 */
export function createRemoteProxy<R = any>(session: Session): R {
  return new Proxy(Object.create(null), {
    get(_t, action: string) {
      return (payload: unknown, opts?: CallOptions) =>
        session.call(action, payload, opts)
    },
  }) as R
}
