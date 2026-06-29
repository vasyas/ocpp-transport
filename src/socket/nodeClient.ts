import WebSocket from "ws"
import type { ClientSocketFactory, Socket } from "../types.js"
import { wrapWs } from "./wrapWs.js"

/**
 * Node client socket factory (uses the `ws` package). Adds the
 * `onUnexpectedResponse` channel so a rejected upgrade's HTTP status reaches
 * the caller — `ws` fires this as a distinct event from `error`.
 */
export const nodeClientSocket: ClientSocketFactory = (url, protocols, opts) => {
  const ws = new WebSocket(
    url,
    protocols,
    opts?.headers ? { headers: opts.headers } : undefined,
  )
  const base = wrapWs(ws)
  const socket: Socket = {
    ...base,
    onUnexpectedResponse(handler) {
      ws.on("unexpected-response", (_req, res) => {
        handler(res.statusCode ?? 0, res.statusMessage ?? "")
        // Drain and discard the response so the socket can be GC'd.
        res.resume()
      })
    },
  }
  return socket
}
