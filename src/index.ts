/**
 * ocpp-transport — OCPP-J (OCPP-over-WebSocket) transport.
 *
 * Public API. The typed proxy (`client.remote`, `server.getRemote(id)`) is the
 * call surface; handlers are registered as a `local` object.
 */

export type {
  Json,
  Frame,
  CallFrame,
  CallResultFrame,
  CallErrorFrame,
  ConnectionContext,
  Middleware,
  Logger,
  MessageParser,
  MessageSerializer,
  Socket,
  ClientSocketFactory,
  SessionOptions,
  CallOptions,
  Listeners,
  LocalHandlers,
} from "./types.js"
export { MessageType } from "./types.js"

export { setLogger } from "./logger.js"
export {
  FrameError,
  isoDateReviver,
  defaultMessageParser,
  defaultMessageSerializer,
} from "./codec.js"

export { composeMiddleware } from "./middleware.js"
export { nodeClientSocket } from "./socket/nodeClient.js"
export { browserClientSocket } from "./socket/browserClient.js"
export type { UpgradeDecision, UpgradeHook } from "./types.js"

export type { Client, ClientOptions } from "./client.js"
export { createServer } from "./server.js"
export type { Server, ServerOptions } from "./server.js"
export { TimeoutError, ClosedError } from "./session.js"

import { createClientCore, type Client, type ClientOptions } from "./client.js"

/**
 * Create an OCPP-J client. On Node the `ws`-backed socket is loaded lazily via
 * dynamic import, so it stays out of the synchronous module graph (and out of
 * browser builds, which use the separate `browser` entry point).
 */
export function createClient<R = any>(options: ClientOptions): Client<R> {
  return createClientCore<R>(
    options,
    async () => (await import("./socket/nodeClient.js")).nodeClientSocket,
  )
}

// Public surface added by later units:
//   export { createClient } from "./client.js"
//   export { createServer } from "./server.js"
