import http from "node:http"
import {
  type CallOptions,
  type Listeners,
  type LocalHandlers,
  type Middleware,
  type SessionOptions,
  type UpgradeHook,
} from "./types.js"
import { Session } from "./session.js"
import { createNodeServer } from "./socket/nodeServer.js"

export interface ServerOptions extends SessionOptions {
  /** The app-owned upgrade hook: auth/reject, identity, subprotocol. */
  hook: UpgradeHook
  /** Attach to an existing HTTP server, or omit and pass `port`. */
  server?: http.Server
  port?: number
  host?: string
  /** Inbound OCPP handlers (charger-initiated calls). */
  local?: LocalHandlers
  /** Local middleware wrapping inbound-handler dispatch. */
  middleware?: Middleware[]
  listeners?: Listeners
}

export interface Server {
  /** Typed proxy for calling a connected charger by id. */
  getRemote<R = any>(id: string): R
  isConnected(id: string): boolean
  getConnectedIds(): string[]
  disconnectClient(id: string): void
  readonly httpServer: http.Server
  close(): Promise<void>
}

/**
 * Create an OCPP-J server. Accepts charger WebSocket connections via the
 * app-owned upgrade hook, dispatches inbound calls to `local`, and lets the
 * app call any connected charger by id via `getRemote`. The server keeps a
 * connection registry keyed by the identity the hook assigns.
 */
export function createServer(options: ServerOptions): Server {
  const registry = new Map<string, Session>()

  const transport = createNodeServer({
    server: options.server,
    port: options.port,
    host: options.host,
    hook: options.hook,
  })

  transport.onConnection((socket, ctx) => {
    const existing = registry.get(ctx.id)

    const session: Session = new Session(socket, ctx, {
      callTimeout: options.callTimeout,
      keepAliveTimeout: options.keepAliveTimeout ?? 0,
      pingInterval: options.pingInterval ?? 0,
      maxFrameSize: options.maxFrameSize,
      messageParser: options.messageParser,
      messageSerializer: options.messageSerializer,
      local: options.local,
      middleware: options.middleware,
      listeners: {
        ...options.listeners,
        disconnected: (c, code, reason) => {
          // Identity guard: only drop the registry entry if it still points
          // at THIS session. The evicted old session's close fires after the
          // new one is installed, so without this guard it would delete the
          // freshly-authenticated replacement.
          if (registry.get(c.id) === session) registry.delete(c.id)
          options.listeners?.disconnected?.(c, code, reason)
        },
      },
    })

    // Install the new session first, then evict the old one — so the old
    // session's close handler (above) sees the new entry and leaves it intact.
    registry.set(ctx.id, session)
    if (existing) existing.close(1000, "Replaced by new connection")
  })

  return {
    getRemote<R = any>(id: string): R {
      return new Proxy(Object.create(null), {
        get(_t, action: string) {
          return (payload: unknown, opts?: CallOptions) => {
            const s = registry.get(id)
            if (!s) {
              return Promise.reject(new Error(`Charger '${id}' is not connected`))
            }
            return s.call(action, payload, opts)
          }
        },
      }) as R
    },
    isConnected: (id) => registry.has(id),
    getConnectedIds: () => [...registry.keys()],
    disconnectClient: (id) => registry.get(id)?.close(),
    httpServer: transport.httpServer,
    close: () => transport.close(),
  }
}
