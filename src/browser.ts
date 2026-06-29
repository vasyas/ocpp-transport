/**
 * Browser entry point for ocpp-transport.
 *
 * Selected via the package's `exports` "browser" condition. This module's
 * graph deliberately never references the Node socket factories or the server
 * (which import `ws`), so a browser bundle does not pull in `ws` or Node core
 * modules. The server runs on Node only; in the browser you create clients.
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
export { TimeoutError, ClosedError } from "./session.js"
export { browserClientSocket } from "./socket/browserClient.js"
export type { Client, ClientOptions } from "./client.js"

import { createClientCore, type Client, type ClientOptions } from "./client.js"
import { browserClientSocket } from "./socket/browserClient.js"

/** Create an OCPP-J client using the browser `WebSocket` global. */
export function createClient<R = any>(options: ClientOptions): Client<R> {
  return createClientCore<R>(options, () => browserClientSocket)
}
