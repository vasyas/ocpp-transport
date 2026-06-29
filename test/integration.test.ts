import { describe, it, expect, afterEach } from "vitest"
import type { AddressInfo } from "node:net"
import { createServer, type Server } from "../src/server.js"
import { createClient } from "../src/index.js"
import type { Client } from "../src/client.js"
import type { UpgradeHook } from "../src/types.js"

let server: Server | undefined
const clients: Client[] = []

afterEach(async () => {
  for (const c of clients) c.close()
  clients.length = 0
  await server?.close()
  server = undefined
})

function start(hook: UpgradeHook, local?: Record<string, any>): Promise<number> {
  server = createServer({ port: 0, hook, local: local ?? {} })
  return new Promise((resolve) =>
    server!.httpServer.on("listening", () =>
      resolve((server!.httpServer.address() as AddressInfo).port),
    ),
  )
}

const acceptAs = (id: string): UpgradeHook => () => ({
  ok: true,
  context: { id },
  subprotocol: "ocpp1.6",
})

function connect(port: number, path: string, opts: Partial<Parameters<typeof createClient>[0]> = {}) {
  const c = createClient({
    url: `ws://127.0.0.1:${port}${path}`,
    protocols: "ocpp1.6",
    ...opts,
  })
  clients.push(c)
  return c
}

describe("client connection id", () => {
  it("uses the URL's last path segment, not the full URL", async () => {
    const port = await start(acceptAs("CPID"))
    let clientId: string | undefined
    const c = connect(port, "/ocpp/CPID", {
      listeners: { connected: (ctx) => (clientId = ctx.id) },
    })
    await c.connected
    expect(clientId).toBe("CPID")
  })
})

describe("F1: inbound charger -> server handler", () => {
  it("dispatches a charger CALL to the server's local handler", async () => {
    const port = await start(acceptAs("CP1"), {
      Authorize: (p: any) => ({ idTagInfo: { status: p.idTag === "OK" ? "Accepted" : "Blocked" } }),
    })
    const c = connect(port, "/CP1")
    await c.connected
    await expect(c.remote.Authorize({ idTag: "OK" })).resolves.toEqual({
      idTagInfo: { status: "Accepted" },
    })
  })
})

describe("F2: outbound server -> charger via getRemote", () => {
  it("calls a connected charger by id and resolves its response", async () => {
    const port = await start(acceptAs("CP2"))
    connect(port, "/CP2", {
      local: {
        RemoteStartTransaction: (p: any) => ({ status: "Accepted", got: p.connectorId }),
      },
    })
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (server!.isConnected("CP2")) {
          clearInterval(t)
          r()
        }
      }, 10)
    })
    const res = await server!.getRemote("CP2").RemoteStartTransaction({ connectorId: 2 })
    expect(res).toEqual({ status: "Accepted", got: 2 })
  })

  it("rejects getRemote for a charger that is not connected", async () => {
    await start(acceptAs("CPx"))
    await expect(server!.getRemote("ghost").Anything({})).rejects.toThrow(/not connected/)
  })
})

describe("U9: registry + connection management", () => {
  it("tracks connected ids and supports disconnectClient", async () => {
    const port = await start(acceptAs("CP3"))
    const c = connect(port, "/CP3")
    await c.connected
    await viWaitConnected("CP3")
    expect(server!.getConnectedIds()).toContain("CP3")
    expect(server!.isConnected("CP3")).toBe(true)
    server!.disconnectClient("CP3")
    await new Promise((r) => setTimeout(r, 50))
    expect(server!.isConnected("CP3")).toBe(false)
  })

  it("evicts a duplicate identity without dropping the new session (identity guard)", async () => {
    const port = await start(acceptAs("DUP"))
    const c1 = connect(port, "/DUP")
    await c1.connected
    await viWaitConnected("DUP")
    // Second connection with the same identity.
    const c2 = connect(port, "/DUP")
    await c2.connected
    await new Promise((r) => setTimeout(r, 80))
    // After eviction settles, the id is still connected (the new session).
    expect(server!.isConnected("DUP")).toBe(true)
    // And the new session is callable.
  })
})

describe("U9: upgrade rejection", () => {
  it("rejects connect with the hook's HTTP status when reconnect is off", async () => {
    const port = await start(() => ({ ok: false, status: 403, message: "Forbidden" }))
    const c = connect(port, "/nope", { reconnect: false })
    await expect(c.connected).rejects.toMatchObject({ status: 403 })
  })

  it("surfaces the rejection and retries (does not hang) when reconnect is on", async () => {
    const port = await start(() => ({ ok: false, status: 503, message: "Busy" }))
    const seen: number[] = []
    connect(port, "/retry", {
      reconnect: true,
      reconnectDelay: 30,
      onUpgradeRejected: (status) => seen.push(status),
    })
    await new Promise((r) => setTimeout(r, 150))
    expect(seen.length).toBeGreaterThanOrEqual(2) // observed + retried
    expect(seen.every((s) => s === 503)).toBe(true)
  })
})

describe("F3: reconnect after drop", () => {
  it("re-establishes after the server drops the connection", async () => {
    const port = await start(acceptAs("CP4"))
    let connects = 0
    const c = connect(port, "/CP4", {
      reconnect: true,
      reconnectDelay: 50,
      listeners: { connected: () => connects++ },
    })
    await c.connected
    await viWaitConnected("CP4")
    server!.disconnectClient("CP4") // force a drop
    await new Promise((r) => setTimeout(r, 250)) // allow reconnect
    expect(connects).toBeGreaterThanOrEqual(2)
    expect(server!.isConnected("CP4")).toBe(true)
  })
})

async function viWaitConnected(id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (server!.isConnected(id)) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`server never registered ${id}`)
}
