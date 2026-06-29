# ocpp-transport

A small, OCPP-version-agnostic **OCPP-J** (OCPP-over-WebSocket) transport for
Node and the browser. It provides a typed client and server with a
push-rpc-compatible API and wire format — and nothing else. It moves
`CALL` / `CALLRESULT` / `CALLERROR` frames and knows nothing about OCPP
actions, payload schemas, or versions.

It is a focused replacement for `@push-rpc/core` in OCPP projects: no
subscriptions, no extra adapters, one package.

```bash
npm install ocpp-transport
```

## Server

```ts
import { createServer, type UpgradeHook } from "ocpp-transport"

// The upgrade hook is YOUR authentication boundary (see "Security" below).
const hook: UpgradeHook = (req) => {
  const id = (req.url ?? "").replace(/^\/+/, "")
  if (!id) return { ok: false, status: 400 }
  // validate req.headers here; reject with any HTTP status
  return { ok: true, context: { id }, subprotocol: "ocpp1.6" }
}

const server = createServer({
  port: 9000,
  hook,
  keepAliveTimeout: 5 * 60 * 1000,
  local: {
    Heartbeat: () => ({ currentTime: new Date().toISOString() }),
    Authorize: (p: { idTag: string }) => ({ idTagInfo: { status: "Accepted" } }),
  },
})

// Call a connected charger by id:
await server.getRemote("CP001").RemoteStartTransaction({ idTag: "T", connectorId: 1 })
```

## Client

```ts
import { createClient } from "ocpp-transport"

const client = createClient({
  url: "ws://localhost:9000/CP001",
  protocols: "ocpp1.6",
  reconnect: true,
  local: {
    RemoteStartTransaction: (p) => ({ status: "Accepted" }),
  },
})

await client.connected
const res = await client.remote.Authorize({ idTag: "TAG-1" })
```

The client runs in the browser too — pass `browserClientSocket` or let it
auto-detect. Native ping is Node-only; the browser relies on idle-timeout
liveness plus whatever traffic the app sends.

See [`examples/`](examples) for runnable client and server, and
[`examples/PARITY.md`](examples/PARITY.md) for the `@push-rpc/core` migration map.

## Behavior worth knowing

- **Version-agnostic.** Actions are opaque strings, payloads opaque JSON. No
  schema or error-code validation. Pair with a schema layer above if you want
  validation.
- **Outbound calls are always serialized per connection.** One CALL is in
  flight at a time (some chargers can't handle concurrency). A non-responding
  call holds the queue until its timeout fires (head-of-line blocking); the
  call timeout therefore bounds worst-case queued latency. The timeout clock
  starts when you initiate the call, so it covers queue-wait.
- **Keep-alive by idle timeout.** A connection is force-closed after
  `keepAliveTimeout` with no inbound frame. OCPP Heartbeat (and its replies)
  keep it alive naturally — the transport never parses Heartbeat. On Node, an
  optional native WS ping (`pingInterval`, default on for the client) bounds
  detection independent of app traffic.
- **Errors.** Thrown handler errors serialize to `CALLERROR` from an explicit
  allowlist (`code`, `message`, `details`/`data`) — never a blanket property
  spread, so internal diagnostics don't leak to field devices. A missing
  `code` falls back to `GenericError` so frames stay structurally valid.
  Received CALLERROR details are sanitized against prototype pollution.
- **Custom parsing.** Real chargers emit malformed JSON. Override
  `messageParser` to repair it; a configurable `maxFrameSize` (default 64 KiB)
  is enforced before the parser runs.

## Security

This is a transport. **It authenticates nothing.** The server's upgrade hook is
the trust boundary: validate the upgrade request (token, TLS client cert,
`Authorization` header) there and reject with an HTTP status before any socket
is established. Identity derived from the URL path is only trustworthy because
your hook validated the request.

`messageIn` / `messageOut` events carry the **raw frame**, which may contain ID
tokens or PII. The library does not redact — redaction is the consumer's
responsibility.

## Not included (by design)

Subscriptions / topics / pub-sub, TCP/HTTP/OpenAPI transports, the ingress↔processor
broker (the application owns that), and any OCPP-version-specific logic.

## License

MIT
