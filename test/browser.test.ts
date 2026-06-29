import { describe, it, expect, afterEach } from "vitest"
import type { AddressInfo } from "node:net"
import { createServer, type Server } from "../src/index.js"
import * as browserEntry from "../src/browser.js"
import { createClient } from "../src/browser.js"

let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

describe("browser entry", () => {
  it("exposes a client surface but not the server (Node-only)", () => {
    expect(typeof browserEntry.createClient).toBe("function")
    expect(typeof browserEntry.browserClientSocket).toBe("function")
    expect(typeof browserEntry.composeMiddleware).toBe("function")
    expect("createServer" in browserEntry).toBe(false)
  })

  it("connects and round-trips using the global WebSocket (no ws)", async () => {
    server = createServer({
      port: 0,
      hook: (req) => ({ ok: true, context: { id: (req.url ?? "").slice(1) } }),
      local: { Heartbeat: () => ({ currentTime: "2026-06-29T00:00:00Z" }) },
    })
    const port = await new Promise<number>((r) =>
      server!.httpServer.on("listening", () =>
        r((server!.httpServer.address() as AddressInfo).port),
      ),
    )

    const client = createClient({ url: `ws://127.0.0.1:${port}/CPB` })
    try {
      await client.connected
      const res = await client.remote.Heartbeat({})
      expect(res).toEqual({ currentTime: expect.anything() })
    } finally {
      client.close()
    }
  })
})
