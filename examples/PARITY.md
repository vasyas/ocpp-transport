# Parity with `@push-rpc/core`

This maps the `@push-rpc/core` surfaces that `bill` and `charger` use today to
their `ocpp-transport` equivalents, so migration is mechanical. The wire format
(CALL/CALLRESULT/CALLERROR) is identical, so no charger-facing behavior changes.

| push-rpc surface | ocpp-transport | Notes |
|---|---|---|
| `createRpcClient(createSocket, opts)` | `createClient(options)` | `url` + optional `socket` factory instead of `createSocket`. |
| `client.remote.Action(payload)` | `client.remote.Action(payload)` | Identical typed-proxy call. Dynamic `remote[action](payload)` also supported. |
| `createRpcServer(local, socketServer, opts)` | `createServer(options)` | `local` + `hook` in one options object. |
| `server.getRemote(id)` | `server.getRemote(id)` | Identical. Rejects if the id is not connected. |
| `server.isConnected/getConnectedIds/disconnectClient/close` | same | Identical names and semantics. |
| `verifyClient` + `handleProtocols` + `createConnectionContext` | single `hook(req)` | Unified: auth-reject (HTTP status) + identity + subprotocol in one async decision. |
| `localMiddleware` + `composeMiddleware` | `middleware` + `composeMiddleware` | Same `Middleware` signature `(ctx, next, params, messageType)`. Remote middleware deferred. |
| `messageParser` | `messageParser` (+ `messageSerializer`) | Same hook for vendor malformed-JSON repair; date reviver built in. |
| `listeners` (connected/disconnected/messageIn/messageOut) | `listeners` | Same. `messageIn/Out` carry the raw frame — **redaction is the consumer's responsibility**. |
| `setLogger` | `setLogger` | Same global logger injection. |
| `callTimeout` | `callTimeout` | Now measured from call **initiation** (covers queue-wait). |
| `keepAliveTimeout` | `keepAliveTimeout` | Idle-timeout liveness, both roles. |
| `pingSendTimeout` (emulated PING) | `pingInterval` (native `ws` ping) | Emulated app-level PING **dropped**; native ping (Node) replaces it, default on for the client. |
| `syncRemoteCalls: true` | (always on) | Outbound calls are **always** serialized — no flag. |

## Deliberately dropped (not ported)

- Subscriptions / topics / GET / `Data` message types (11/12/13/14).
- TCP / HTTP / OpenAPI adapters.
- The emulated application-level `PING`/`PONG` string messages.
- A dedicated error class — errors stay push-rpc-compatible (code/message/details).

## Executable parity coverage

Representative consumer behaviors are exercised by the test suite:

- **Custom parser** repairing a malformed vendor frame — `test/codec.test.ts`.
- **Serialized outbound** (AE/ABL chargers can't take concurrent CALLs) — `test/session.test.ts`.
- **Identity derivation from the upgrade request** + subprotocol echo — `test/socket.test.ts`, `test/integration.test.ts`.
- **Inbound dispatch + outbound `getRemote` + reconnect** end-to-end — `test/integration.test.ts`.
