/**
 * Minimal OCPP-J charge point (client).
 *
 * Run with: npx tsx examples/simple-client.ts
 */
import { createClient } from "ocpp-transport"

const client = createClient({
  url: "ws://localhost:9000/CP001",
  protocols: "ocpp1.6",
  reconnect: true,
  reconnectDelay: 1000,
  // Native ping defaults on for the Node client (bounds dead-connection
  // detection). keepAliveTimeout defaults to 40s.
  local: {
    // Server-initiated calls (the charger implements these).
    RemoteStartTransaction: (payload: { idTag: string; connectorId: number }) => {
      console.log("RemoteStartTransaction received:", payload)
      return { status: "Accepted" }
    },
    Reset: () => ({ status: "Accepted" }),
  },
  listeners: {
    connected: () => console.log("connected to central system"),
    disconnected: (_ctx, code, reason) =>
      console.log(`disconnected (${code} ${reason})`),
  },
})

await client.connected

await client.remote.BootNotification({
  chargePointVendor: "Acme",
  chargePointModel: "Model-1",
})

// Periodic heartbeat — the server's idle-timeout liveness rides on this.
setInterval(() => {
  client.remote.Heartbeat({}).catch((e: unknown) => console.error("heartbeat failed:", e))
}, 30_000)

const auth = await client.remote.Authorize({ idTag: "TAG-1" })
console.log("Authorize ->", auth)
