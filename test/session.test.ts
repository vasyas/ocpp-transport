import { describe, it, expect, vi, afterEach } from "vitest"
import { Session, createRemoteProxy, TimeoutError } from "../src/session.js"
import { MessageType, type ConnectionContext, type Socket } from "../src/types.js"

function mockSocket() {
  let openH: (() => void) | undefined
  let msgH: ((d: string) => void) | undefined
  let closeH: ((c: number, r: string) => void) | undefined
  let pingH: (() => void) | undefined
  let pongH: (() => void) | undefined
  const sent: string[] = []
  let closed = false
  const socket: Socket = {
    send: (d) => sent.push(d),
    close: (c = 1000, r = "") => {
      if (closed) return
      closed = true
      closeH?.(c, r)
    },
    ping: () => {},
    onOpen: (h) => (openH = h),
    onMessage: (h) => (msgH = h),
    onClose: (h) => (closeH = h),
    onError: () => {},
    onPing: (h) => (pingH = h),
    onPong: (h) => (pongH = h),
  }
  return {
    socket,
    sent,
    fireOpen: () => openH?.(),
    inbound: (frame: unknown[]) => msgH?.(JSON.stringify(frame)),
    inboundRaw: (raw: string) => msgH?.(raw),
    firePing: () => pingH?.(),
    firePong: () => pongH?.(),
    get closed() {
      return closed
    },
  }
}

const ctx: ConnectionContext = { id: "cp1" }
const lastId = (raw: string) => JSON.parse(raw)[1] as string

afterEach(() => {
  vi.useRealTimers()
})

describe("session outbound correlation (AE5)", () => {
  it("resolves a call when the matching CALLRESULT arrives", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {})
    m.fireOpen()
    const p = s.call("Authorize", { idTag: "X" })
    const id = lastId(m.sent[0]!)
    m.inbound([MessageType.CallResult, id, { status: "Accepted" }])
    await expect(p).resolves.toEqual({ status: "Accepted" })
  })

  it("ignores a response with an unknown id", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {})
    m.fireOpen()
    const p = s.call("Authorize", {})
    m.inbound([MessageType.CallResult, "not-the-id", { status: "X" }])
    const settled = await Promise.race([
      p.then(() => "resolved"),
      Promise.resolve("pending"),
    ])
    expect(settled).toBe("pending")
  })

  it("rejects a call when a matching CALLERROR arrives", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {})
    m.fireOpen()
    const p = s.call("Authorize", {})
    const id = lastId(m.sent[0]!)
    m.inbound([MessageType.CallError, id, "NotSupported", "nope", { x: 1 }])
    await expect(p).rejects.toMatchObject({ code: "NotSupported", details: { x: 1 } })
  })
})

describe("session serialized outbound (R17)", () => {
  it("does not send B until A settles", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {})
    m.fireOpen()
    const a = s.call("A", {})
    s.call("B", {})
    expect(m.sent).toHaveLength(1) // only A on the wire
    const idA = lastId(m.sent[0]!)
    m.inbound([MessageType.CallResult, idA, "ra"])
    await a
    expect(m.sent).toHaveLength(2) // B sent after A settled
  })
})

describe("session timeouts (AE1, head-of-line)", () => {
  it("rejects an in-flight call that never gets a response", async () => {
    vi.useFakeTimers()
    const m = mockSocket()
    const s = new Session(m.socket, ctx, { callTimeout: 1000 })
    m.fireOpen()
    const p = s.call("RemoteStartTransaction", {})
    const expectation = expect(p).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(1100)
    await expectation
  })

  it("times out a call while it is still queued behind a stalled call", async () => {
    vi.useFakeTimers()
    const m = mockSocket()
    const s = new Session(m.socket, ctx, { callTimeout: 1000 })
    m.fireOpen()
    const a = s.call("A", {}) // becomes in-flight, never answered
    const b = s.call("B", {}, { timeout: 300 }) // queued behind A
    void a
    expect(m.sent).toHaveLength(1) // B never sent
    const bExpect = expect(b).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(350)
    await bExpect
    expect(m.sent).toHaveLength(1) // B still never sent (timed out in queue)
  })
})

describe("session inbound dispatch (F1)", () => {
  it("dispatches a CALL to the matching local handler and returns CALLRESULT", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {
      local: { Authorize: (p: any) => ({ echoed: p.idTag }) },
    })
    m.fireOpen()
    m.inbound([MessageType.Call, "req1", "Authorize", { idTag: "T" }])
    await vi.waitFor(() => expect(m.sent).toHaveLength(1))
    expect(JSON.parse(m.sent[0]!)).toEqual([
      MessageType.CallResult,
      "req1",
      { echoed: "T" },
    ])
  })

  it("replies CALLERROR NotImplemented for an unknown action", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, { local: {} })
    m.fireOpen()
    m.inbound([MessageType.Call, "req2", "Mystery", {}])
    await vi.waitFor(() => expect(m.sent).toHaveLength(1))
    const frame = JSON.parse(m.sent[0]!)
    expect(frame[0]).toBe(MessageType.CallError)
    expect(frame[2]).toBe("NotImplemented")
  })

  it("serializes a thrown handler error into a CALLERROR (AE2)", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {
      local: {
        StartTransaction: () => {
          throw Object.assign(new Error("blocked"), {
            code: "SecurityError",
            details: { reason: "x" },
          })
        },
      },
    })
    m.fireOpen()
    m.inbound([MessageType.Call, "req3", "StartTransaction", {}])
    await vi.waitFor(() => expect(m.sent).toHaveLength(1))
    expect(JSON.parse(m.sent[0]!)).toEqual([
      MessageType.CallError,
      "req3",
      "SecurityError",
      "blocked",
      { reason: "x" },
    ])
  })

  it("guards prototype-property action names", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, { local: { Authorize: () => ({}) } })
    m.fireOpen()
    m.inbound([MessageType.Call, "req4", "constructor", {}])
    await vi.waitFor(() => expect(m.sent).toHaveLength(1))
    expect(JSON.parse(m.sent[0]!)[2]).toBe("NotImplemented")
  })
})

describe("session keep-alive (AE3, F4)", () => {
  it("force-closes after keepAliveTimeout of inbound silence", async () => {
    vi.useFakeTimers()
    const m = mockSocket()
    const disconnected = vi.fn()
    new Session(m.socket, ctx, {
      keepAliveTimeout: 1000,
      listeners: { disconnected },
    })
    m.fireOpen()
    await vi.advanceTimersByTimeAsync(1300)
    expect(m.closed).toBe(true)
    expect(disconnected).toHaveBeenCalled()
  })

  it("stays alive while inbound frames keep arriving", async () => {
    vi.useFakeTimers()
    const m = mockSocket()
    new Session(m.socket, ctx, { keepAliveTimeout: 1000, local: {} })
    m.fireOpen()
    await vi.advanceTimersByTimeAsync(800)
    m.inbound([MessageType.Call, "hb", "Heartbeat", {}]) // resets activity
    await vi.advanceTimersByTimeAsync(800)
    expect(m.closed).toBe(false)
  })

  it("stays alive on inbound WS pings alone (no OCPP frames)", async () => {
    vi.useFakeTimers()
    const m = mockSocket()
    new Session(m.socket, ctx, { keepAliveTimeout: 1000, local: {} })
    m.fireOpen()
    await vi.advanceTimersByTimeAsync(800)
    m.firePing() // a charger keeping the socket alive purely via WS pings
    await vi.advanceTimersByTimeAsync(800)
    expect(m.closed).toBe(false)
  })
})

describe("remote proxy", () => {
  it("turns property access into a serialized call", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {})
    m.fireOpen()
    const remote = createRemoteProxy<{ Authorize(p: unknown): Promise<unknown> }>(s)
    const p = remote.Authorize({ idTag: "Z" })
    const frame = JSON.parse(m.sent[0]!)
    expect(frame[0]).toBe(MessageType.Call)
    expect(frame[2]).toBe("Authorize")
    m.inbound([MessageType.CallResult, frame[1], "ok"])
    await expect(p).resolves.toBe("ok")
  })

  it("is not thenable — awaiting the proxy does not fire a `then` call", async () => {
    const m = mockSocket()
    const s = new Session(m.socket, ctx, {})
    m.fireOpen()
    const remote = createRemoteProxy(s)
    // Awaiting a promise that resolves to the proxy must NOT treat it as a
    // thenable (which would call `remote.then`, sending a bogus OCPP call).
    const resolved = await Promise.resolve(remote)
    expect(resolved).toBe(remote)
    expect((remote as any).then).toBeUndefined()
    expect(m.sent).toHaveLength(0)
  })
})

describe("middleware per-call context", () => {
  it("exposes the action name to local middleware", async () => {
    const m = mockSocket()
    let seenAction: string | undefined
    const s = new Session(m.socket, ctx, {
      local: { Authorize: () => ({ status: "Accepted" }) },
      middleware: [
        async (c, next, p) => {
          seenAction = c.action
          return next(p)
        },
      ],
    })
    m.fireOpen()
    m.inbound([MessageType.Call, "r", "Authorize", {}])
    await vi.waitFor(() => expect(m.sent).toHaveLength(1))
    expect(seenAction).toBe("Authorize")
  })
})
