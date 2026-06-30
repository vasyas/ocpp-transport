/**
 * Core shared types for ocpp-transport.
 *
 * The library is OCPP-version-agnostic: actions are opaque strings and
 * payloads are opaque JSON. Nothing here knows about specific OCPP actions,
 * payload schemas, or error-code vocabularies.
 */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }

/** OCPP-J message type ids (the first element of every wire frame). */
export enum MessageType {
  Call = 2,
  CallResult = 3,
  CallError = 4,
}

/** A decoded inbound/outbound OCPP-J frame. */
export type CallFrame = [MessageType.Call, string, string, unknown]
export type CallResultFrame = [MessageType.CallResult, string, unknown]
export type CallErrorFrame = [
  MessageType.CallError,
  string,
  string,
  string,
  unknown,
]
export type Frame = CallFrame | CallResultFrame | CallErrorFrame

/**
 * Per-connection context. The application's upgrade hook (server) produces
 * this; it is carried to handlers and middleware. `id` is the connection
 * identity (e.g. charge point id). Applications may attach arbitrary fields.
 */
export interface ConnectionContext {
  /** Connection identity (charge point id), the server registry key. */
  id: string
  /** Negotiated WebSocket subprotocol, if any (e.g. "ocpp1.6"). */
  protocol?: string
  /**
   * The OCPP action being processed. Present only on the per-call context
   * passed to local middleware and inbound handlers (so middleware can label
   * by operation) — not on the persistent connection context.
   */
  action?: string
  [key: string]: unknown
}

/**
 * Middleware signature, compatible with @push-rpc/core. `ctx` is the
 * connection context for local (inbound-handler) middleware. `messageType`
 * is the OCPP message type being processed.
 */
export type Middleware = (
  ctx: ConnectionContext,
  next: (params: unknown) => Promise<unknown>,
  params: unknown,
  messageType: MessageType,
) => Promise<unknown>

/** Injectable logger. A no-op logger is used until one is supplied. */
export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Parses a raw inbound WebSocket text frame into a JS value (expected to be
 * an OCPP-J array). Override to absorb vendor-specific malformed JSON.
 * Throwing surfaces a scoped parse error without tearing down the connection.
 */
export type MessageParser = (raw: string) => unknown

/**
 * Serializes an outbound frame array to a wire string. Must NOT mutate the
 * input (notably: must not convert Date fields in place on the caller's
 * payload object). Override to match a custom parser.
 */
export type MessageSerializer = (frame: unknown[]) => string

/**
 * Transport-agnostic socket the session drives. Implemented by the built-in
 * Node `ws` and browser `WebSocket` factories. The session never imports a
 * concrete WebSocket library directly — only this interface.
 */
export interface Socket {
  send(data: string): void
  close(code?: number, reason?: string): void
  /** Native WS ping (Node only). No-op where unavailable (browser). */
  ping?(): void

  onOpen(handler: () => void): void
  onMessage(handler: (data: string) => void): void
  onClose(handler: (code: number, reason: string) => void): void
  onError(handler: (err: Error) => void): void
  /** Native ping received from the peer (Node only). */
  onPing?(handler: () => void): void
  /** Native pong received (Node only). */
  onPong?(handler: () => void): void
  /**
   * Connection-establishment failure carrying an HTTP status — fired when the
   * server rejects the upgrade (Node `ws` "unexpected-response"). The browser
   * `WebSocket` global cannot expose the status, so its path degrades to a
   * generic error via `onError`.
   */
  onUnexpectedResponse?(handler: (status: number, message: string) => void): void
}

/** Per-connection options passed to a client socket factory. */
export interface ClientSocketOptions {
  /**
   * Extra HTTP headers for the WebSocket handshake (e.g. `Authorization` for
   * OCPP Security Profile 1 Basic Auth). Node only — the browser `WebSocket`
   * API cannot set request headers, so the browser factory ignores these.
   */
  headers?: Record<string, string>
}

/** Factory that opens a client socket to `url` with optional subprotocols. */
export type ClientSocketFactory = (
  url: string,
  protocols?: string | string[],
  opts?: ClientSocketOptions,
) => Socket

/**
 * The app-owned upgrade decision (server). Accepting returns the connection
 * context (identity + chosen subprotocol); rejecting returns an HTTP status
 * written to the response before the socket is established. This is the
 * application's authentication/authorization boundary — the library
 * authenticates nothing itself.
 */
export type UpgradeDecision =
  | { ok: true; context: ConnectionContext; subprotocol?: string }
  | { ok: false; status: number; message?: string }

/**
 * Runs at the WebSocket handshake. Receives the raw HTTP upgrade request
 * (headers, url) and decides accept-or-reject. Async so it can consult a
 * database, validate a token, or check rate limits.
 */
export type UpgradeHook = (req: {
  url?: string
  headers: Record<string, string | string[] | undefined>
}) => UpgradeDecision | Promise<UpgradeDecision>

/** Tuning shared by client and server sessions. */
export interface SessionOptions {
  /** Default per-call timeout in ms (covers queue-wait). Default 30000. */
  callTimeout?: number
  /** Idle-liveness timeout in ms; 0/undefined disables. */
  keepAliveTimeout?: number
  /** Native WS ping interval in ms (Node only); 0/undefined disables. */
  pingInterval?: number
  /** Max raw frame size in bytes enforced before parsing. Default 65536. */
  maxFrameSize?: number
  messageParser?: MessageParser
  messageSerializer?: MessageSerializer
}

/** Per-call options. */
export interface CallOptions {
  /** Override the default call timeout (ms). */
  timeout?: number
}

/** Connection lifecycle + message listeners. */
export interface Listeners {
  connected?(ctx: ConnectionContext): void
  disconnected?(ctx: ConnectionContext, code: number, reason: string): void
  messageIn?(ctx: ConnectionContext, data: string): void
  messageOut?(ctx: ConnectionContext, data: string): void
}

/** A map of inbound OCPP action handlers. Resolved by action name. */
export type LocalHandlers = Record<
  string,
  (payload: any, ctx: ConnectionContext) => unknown | Promise<unknown>
>
