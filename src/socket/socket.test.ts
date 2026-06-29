import { describe, it, expect, afterEach } from "vitest"
import type { AddressInfo } from "node:net"
import { createNodeServer, type NodeServerHandle } from "./nodeServer.js"
import { nodeClientSocket } from "./nodeClient.js"
import type { ConnectionContext, Socket } from "../types.js"

let server: NodeServerHandle | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

function listen(hook: Parameters<typeof createNodeServer>[0]["hook"]) {
  server = createNodeServer({ port: 0, hook })
  return new Promise<number>((resolve) => {
    server!.httpServer.on("listening", () =>
      resolve((server!.httpServer.address() as AddressInfo).port),
    )
  })
}

describe("node socket loopback", () => {
  it("accepts a connection, exchanges a message, and reports close", async () => {
    const received: string[] = []
    let serverSocket: Socket | undefined
    let serverCtx: ConnectionContext | undefined

    const port = await listen(async (req) => ({
      ok: true,
      context: { id: req.url ?? "unknown" },
      subprotocol: "ocpp1.6",
    }))

    server!.onConnection((sock, ctx) => {
      serverSocket = sock
      serverCtx = ctx
      sock.onMessage((m) => {
        received.push(m)
        sock.send("pong-from-server")
      })
    })

    const client = nodeClientSocket(`ws://127.0.0.1:${port}/CP001`, "ocpp1.6")
    const fromServer: string[] = []
    await new Promise<void>((resolve) => {
      client.onOpen(() => {
        client.onMessage((m) => {
          fromServer.push(m)
          resolve()
        })
        client.send("hello-from-client")
      })
    })

    expect(received).toEqual(["hello-from-client"])
    expect(fromServer).toEqual(["pong-from-server"])
    expect(serverCtx?.id).toBe("/CP001")
    expect(serverSocket).toBeDefined()
  })

  it("surfaces a rejected upgrade's HTTP status via onUnexpectedResponse", async () => {
    const port = await listen(async () => ({
      ok: false,
      status: 403,
      message: "Forbidden",
    }))

    const client = nodeClientSocket(`ws://127.0.0.1:${port}/CP002`)
    const status = await new Promise<number>((resolve, reject) => {
      client.onUnexpectedResponse?.((s) => resolve(s))
      client.onError(() => {
        /* ws also emits error after unexpected-response; ignore */
      })
      setTimeout(() => reject(new Error("no rejection")), 2000)
    })
    expect(status).toBe(403)
  })

  it("does not yield a Socket when the hook rejects", async () => {
    let connected = false
    const port = await listen(async () => ({ ok: false, status: 404 }))
    server!.onConnection(() => {
      connected = true
    })
    const client = nodeClientSocket(`ws://127.0.0.1:${port}/x`)
    await new Promise<void>((resolve) => {
      client.onUnexpectedResponse?.(() => resolve())
      client.onError(() => {})
    })
    expect(connected).toBe(false)
  })
})
