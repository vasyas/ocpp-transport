/**
 * Minimal OCPP-J central system (server).
 *
 * Run with: npx tsx examples/simple-server.ts
 */
import { createServer, type UpgradeHook } from "ocpp-transport"

// The upgrade hook is the app-owned authentication boundary. It derives the
// charge point id from the URL path and selects a subprotocol. Reject by
// returning { ok: false, status } — the library never authenticates itself.
const hook: UpgradeHook = (req) => {
  const id = (req.url ?? "").replace(/^\/+/, "") || undefined
  if (!id) return { ok: false, status: 400, message: "Missing charge point id" }

  // e.g. validate a token here: if (!authorized(req.headers)) return { ok:false, status:401 }
  const offered = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((s) => s.trim())
  const subprotocol = ["ocpp2.0.1", "ocpp1.6"].find((p) => offered.includes(p))

  return { ok: true, context: { id }, subprotocol }
}

const server = createServer({
  port: 9000,
  hook,
  // Idle-timeout liveness; rides on Heartbeat without parsing it. Tune above
  // the charger's HeartbeatInterval.
  keepAliveTimeout: 5 * 60 * 1000,
  local: {
    BootNotification: () => ({
      status: "Accepted",
      currentTime: new Date().toISOString(),
      interval: 300,
    }),
    Heartbeat: () => ({ currentTime: new Date().toISOString() }),
    Authorize: (payload: { idTag: string }) => ({
      idTagInfo: { status: payload.idTag ? "Accepted" : "Blocked" },
    }),
    StatusNotification: () => ({}),
  },
  listeners: {
    connected: (ctx) => console.log(`connected: ${ctx.id} (${ctx.protocol})`),
    disconnected: (ctx) => console.log(`disconnected: ${ctx.id}`),
  },
})

console.log("OCPP server listening on ws://localhost:9000/<chargePointId>")

// Example: start charging on a connected charger after 10s.
setTimeout(async () => {
  const [id] = server.getConnectedIds()
  if (!id) return
  try {
    const res = await server.getRemote(id).RemoteStartTransaction({
      idTag: "TAG-1",
      connectorId: 1,
    })
    console.log("RemoteStartTransaction ->", res)
  } catch (e) {
    console.error("remote call failed:", e)
  }
}, 10_000)
