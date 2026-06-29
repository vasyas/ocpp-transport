import http from "node:http"
import { WebSocketServer } from "ws"
import type { ConnectionContext, Socket, UpgradeHook } from "../types.js"
import { wrapWs } from "./wrapWs.js"
import { log } from "../logger.js"

export interface NodeServerOptions {
  /** Attach to an existing HTTP server, or omit to create one. */
  server?: http.Server
  /** Port to listen on when creating a server. */
  port?: number
  host?: string
  /** The app-owned upgrade hook (auth, identity, subprotocol). */
  hook: UpgradeHook
}

export interface NodeServerHandle {
  onConnection(handler: (socket: Socket, ctx: ConnectionContext) => void): void
  readonly httpServer: http.Server
  close(): Promise<void>
}

const DEFAULT_STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
}

function writeReject(
  socket: import("node:stream").Duplex,
  status: number,
  message?: string,
): void {
  const text = message ?? DEFAULT_STATUS_TEXT[status] ?? "Error"
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}

/**
 * Node WebSocket server that owns the raw HTTP `upgrade` event (`noServer`
 * style). For each upgrade it runs the app hook, then either rejects with the
 * chosen HTTP status (written before any socket is established) or accepts and
 * echoes the chosen subprotocol on the 101 response. The negotiated
 * subprotocol is threaded into `ws`'s `handleProtocols` per-request.
 */
export function createNodeServer(opts: NodeServerOptions): NodeServerHandle {
  const httpServer =
    opts.server ??
    http.createServer((_req, res) => {
      res.writeHead(426, { "Content-Type": "text/plain" })
      res.end("Upgrade Required")
    })

  const chosenProtocol = new WeakMap<object, string | undefined>()
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (_protocols, req) =>
      chosenProtocol.get(req as object) ?? false,
  })

  let connHandler:
    | ((socket: Socket, ctx: ConnectionContext) => void)
    | undefined

  httpServer.on("upgrade", (req, socket, head) => {
    Promise.resolve(opts.hook(req))
      .then((decision) => {
        if (!decision.ok) {
          writeReject(socket, decision.status, decision.message)
          return
        }
        chosenProtocol.set(req, decision.subprotocol)
        wss.handleUpgrade(req, socket, head, (ws) => {
          connHandler?.(wrapWs(ws), decision.context)
        })
      })
      .catch((err) => {
        log().error("ocpp-transport: upgrade hook threw", err)
        writeReject(socket, 500)
      })
  })

  if (!opts.server && opts.port != null) {
    httpServer.listen(opts.port, opts.host)
  }

  return {
    onConnection(handler) {
      connHandler = handler
    },
    httpServer,
    close() {
      return new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => {
          if (opts.server) return resolve()
          httpServer.close((err) => (err ? reject(err) : resolve()))
          // Force-close any lingering keep-alive sockets so close() resolves.
          httpServer.closeAllConnections?.()
        })
      })
    },
  }
}
