import {
  type ClientSocketFactory,
  type ConnectionContext,
  type Listeners,
  type LocalHandlers,
  type Middleware,
  type SessionOptions,
  type CallOptions,
} from "./types.js"
import { Session, ClosedError, createCallProxy } from "./session.js"
import { log } from "./logger.js"

export interface ClientOptions extends SessionOptions {
  /** Server URL, e.g. "wss://central.example/ocpp/CP001". */
  url: string
  /** Offered WebSocket subprotocol(s), e.g. "ocpp1.6". */
  protocols?: string | string[]
  /** Inbound OCPP handlers (server-initiated calls). */
  local?: LocalHandlers
  /** Local middleware wrapping inbound-handler dispatch. */
  middleware?: Middleware[]
  listeners?: Listeners
  /** Auto-reconnect after a drop. Default false. */
  reconnect?: boolean
  /** Delay between reconnect attempts in ms. Default 1000. */
  reconnectDelay?: number
  /** Override the socket factory (e.g. to force the browser or a mock). */
  socket?: ClientSocketFactory
  /** Notified when the server rejects the upgrade with an HTTP status. */
  onUpgradeRejected?: (status: number, message: string) => void
}

export interface Client<R = any> {
  /** Typed proxy for outbound calls: `remote.Authorize(payload)`. */
  readonly remote: R
  /** Resolves on first connect; rejects on first failure when reconnect is off. */
  readonly connected: Promise<void>
  /** Close the connection and stop reconnecting. */
  close(): void
}

/** The last non-empty path segment of an OCPP URL — the charge point id. */
function chargePointIdFromUrl(url: string): string {
  const path = (url.split(/[?#]/)[0] ?? url).replace(/\/+$/, "")
  const segment = path.slice(path.lastIndexOf("/") + 1)
  return segment || url
}

/** Resolves the default socket factory when `options.socket` is not given. */
export type DefaultSocketResolver = () =>
  | ClientSocketFactory
  | Promise<ClientSocketFactory>

/**
 * Core client implementation. The default socket factory is injected so this
 * module never references the Node (`ws`) or browser socket directly — the
 * `index` (Node) and `browser` entry points each bind the right one. Browser
 * builds therefore never pull `ws` into their graph.
 */
export function createClientCore<R = any>(
  options: ClientOptions,
  resolveDefaultFactory: DefaultSocketResolver,
): Client<R> {
  let session: Session | null = null
  let intentionalClose = false
  let firstAttemptPending = true
  let reconnectScheduled = false

  let resolveConnected!: () => void
  let rejectConnected!: (err: unknown) => void
  const connected = new Promise<void>((res, rej) => {
    resolveConnected = res
    rejectConnected = rej
  })

  const baseCtx: ConnectionContext = {
    // OCPP URLs end with the charge point id (e.g. wss://host/ocpp/CP001);
    // use that last path segment as the connection label, not the full URL.
    id: chargePointIdFromUrl(options.url),
    protocol: Array.isArray(options.protocols)
      ? options.protocols[0]
      : options.protocols,
  }

  // Native ping defaults on for the Node client (KTD3); the browser socket has
  // no `ping`, so the session's ping timer simply never fires there.
  const sessionConfig = {
    callTimeout: options.callTimeout,
    keepAliveTimeout: options.keepAliveTimeout ?? 40_000,
    pingInterval: options.pingInterval ?? 20_000,
    maxFrameSize: options.maxFrameSize,
    messageParser: options.messageParser,
    messageSerializer: options.messageSerializer,
    local: options.local,
    middleware: options.middleware,
  }

  const remote = createCallProxy<R>((action, payload, opts) =>
    session ? session.call(action, payload, opts) : Promise.reject(new ClosedError()),
  )

  function scheduleReconnect(): void {
    if (intentionalClose || !options.reconnect || reconnectScheduled) return
    reconnectScheduled = true
    const delay = options.reconnectDelay ?? 1000
    const t = setTimeout(() => {
      reconnectScheduled = false
      connectOnce().catch((err) => {
        log().warn("ocpp-transport: reconnect attempt failed", err)
        scheduleReconnect()
      })
    }, delay)
    t.unref?.()
  }

  async function connectOnce(): Promise<void> {
    const factory = options.socket ?? (await resolveDefaultFactory())
    const socket = factory(options.url, options.protocols)

    socket.onUnexpectedResponse?.((status, message) => {
      options.onUpgradeRejected?.(status, message)
      if (firstAttemptPending && !options.reconnect) {
        firstAttemptPending = false
        rejectConnected(
          Object.assign(new Error(`Upgrade rejected: ${status} ${message}`), {
            status,
          }),
        )
      } else {
        // A rejected handshake may not emit a `close` event, so schedule the
        // retry here rather than relying on the disconnected listener.
        session = null
        scheduleReconnect()
      }
    })

    session = new Session(socket, { ...baseCtx }, {
      ...sessionConfig,
      listeners: {
        ...options.listeners,
        connected: (ctx) => {
          if (firstAttemptPending) {
            firstAttemptPending = false
            resolveConnected()
          }
          options.listeners?.connected?.(ctx)
        },
        disconnected: (ctx, code, reason) => {
          session = null
          options.listeners?.disconnected?.(ctx, code, reason)
          scheduleReconnect()
        },
      },
    })
  }

  connectOnce().catch((err) => {
    if (firstAttemptPending && !options.reconnect) {
      firstAttemptPending = false
      rejectConnected(err)
    } else {
      log().warn("ocpp-transport: initial connect failed", err)
      scheduleReconnect()
    }
  })

  return {
    remote,
    connected,
    close() {
      intentionalClose = true
      session?.close()
    },
  }
}
