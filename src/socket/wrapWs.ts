import type { WebSocket as WsWebSocket } from "ws"
import type { Socket } from "../types.js"

/**
 * Wrap a Node `ws` WebSocket as the transport-agnostic `Socket`. Used by both
 * the Node client factory and the server-side accepted connections. Keeping
 * all `ws` knowledge here means the session never imports `ws` directly.
 */
export function wrapWs(ws: WsWebSocket): Socket {
  return {
    send(data) {
      ws.send(data)
    },
    close(code, reason) {
      ws.close(code, reason)
    },
    ping() {
      // ws throws if not open; guard so liveness probing is best-effort.
      if (ws.readyState === ws.OPEN) ws.ping()
    },
    onOpen(handler) {
      if (ws.readyState === ws.OPEN) queueMicrotask(handler)
      else ws.on("open", handler)
    },
    onMessage(handler) {
      ws.on("message", (data: unknown) => handler(String(data)))
    },
    onClose(handler) {
      ws.on("close", (code: number, reason: Buffer) =>
        handler(code, reason.toString()),
      )
    },
    onError(handler) {
      ws.on("error", (err: Error) => handler(err))
    },
    onPing(handler) {
      ws.on("ping", () => handler())
    },
    onPong(handler) {
      ws.on("pong", () => handler())
    },
  }
}
