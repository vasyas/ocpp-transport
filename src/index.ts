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

// Public surface added by later units:
//   export { createClient } from "./client.js"
//   export { createServer } from "./server.js"
