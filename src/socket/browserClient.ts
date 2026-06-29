import type { ClientSocketFactory, Socket } from "../types.js"

/**
 * Browser client socket factory (uses the global `WebSocket`). Native ping is
 * unavailable in the browser, and the `WebSocket` API does not expose the
 * HTTP status of a rejected upgrade — so `ping` and `onUnexpectedResponse`
 * are intentionally absent, and a rejected upgrade surfaces as a generic
 * error via `onError`.
 */
export const browserClientSocket: ClientSocketFactory = (url, protocols) => {
  // `opts.headers` is intentionally ignored — the browser WebSocket API cannot
  // set handshake headers.
  const ws = new WebSocket(url, protocols)
  const socket: Socket = {
    send(data) {
      ws.send(data)
    },
    close(code, reason) {
      ws.close(code, reason)
    },
    onOpen(handler) {
      if (ws.readyState === WebSocket.OPEN) queueMicrotask(handler)
      else ws.addEventListener("open", () => handler())
    },
    onMessage(handler) {
      ws.addEventListener("message", (ev: MessageEvent) =>
        handler(String(ev.data)),
      )
    },
    onClose(handler) {
      ws.addEventListener("close", (ev: CloseEvent) =>
        handler(ev.code, ev.reason),
      )
    },
    onError(handler) {
      ws.addEventListener("error", () =>
        handler(new Error("WebSocket connection error")),
      )
    },
  }
  return socket
}
