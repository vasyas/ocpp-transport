import { describe, it, expect, vi } from "vitest"
import {
  decode,
  encode,
  FrameError,
  isoDateReviver,
  defaultMessageParser,
} from "../src/codec.js"
import { MessageType } from "../src/types.js"

describe("codec encode/decode", () => {
  it("round-trips a CALL frame", () => {
    const wire = encode([MessageType.Call, "abc", "Authorize", { idTag: "X" }])
    const frame = decode(wire)
    expect(frame).toEqual([MessageType.Call, "abc", "Authorize", { idTag: "X" }])
  })

  it("decodes a CALLRESULT frame", () => {
    const frame = decode(JSON.stringify([3, "abc", { status: "Accepted" }]))
    expect(frame).toEqual([MessageType.CallResult, "abc", { status: "Accepted" }])
  })

  it("decodes a CALLERROR frame", () => {
    const frame = decode(
      JSON.stringify([4, "abc", "NotSupported", "nope", { extra: 1 }]),
    )
    expect(frame).toEqual([
      MessageType.CallError,
      "abc",
      "NotSupported",
      "nope",
      { extra: 1 },
    ])
  })

  it("rejects a non-array frame", () => {
    expect(() => decode(JSON.stringify({ not: "an array" }))).toThrow(FrameError)
  })

  it("rejects a CALL with a non-string action", () => {
    expect(() => decode(JSON.stringify([2, "id", 123, {}]))).toThrow(FrameError)
  })

  it("rejects an unknown message type", () => {
    expect(() => decode(JSON.stringify([9, "id", "x"]))).toThrow(/Unknown message type/)
  })
})

describe("codec size guard (AE4-adjacent)", () => {
  it("rejects a frame larger than maxFrameSize before invoking the parser", () => {
    const parser = vi.fn(defaultMessageParser)
    const huge = JSON.stringify([2, "id", "Action", { blob: "x".repeat(1000) }])
    expect(() => decode(huge, { parser, maxFrameSize: 100 })).toThrow(
      /exceeds max size/,
    )
    expect(parser).not.toHaveBeenCalled()
  })

  it("allows a frame within maxFrameSize", () => {
    const ok = JSON.stringify([2, "id", "A", {}])
    expect(() => decode(ok, { maxFrameSize: 65536 })).not.toThrow()
  })
})

describe("codec custom parser (AE4)", () => {
  it("uses a custom parser to repair a known vendor malformation", () => {
    // Vendor sends a stray trailing field outside the payload object.
    const malformed =
      '[3, "id", {"idTagInfo":{"status":"Blocked"}}, "transactionId":0]'
    const repair = (raw: string) =>
      JSON.parse(raw.replace('}, "transactionId":0]', ', "transactionId":0}]'))
    const frame = decode(malformed, { parser: repair })
    expect(frame[0]).toBe(MessageType.CallResult)
    expect((frame as any)[2]).toMatchObject({ transactionId: 0 })
  })

  it("surfaces an unrepairable frame as a FrameError, not a throw-through", () => {
    expect(() => decode("{ totally broken")).toThrow(FrameError)
  })
})

describe("codec dates", () => {
  it("revives ISO-8601 strings to Date on decode", () => {
    const frame = decode(JSON.stringify([2, "id", "Heartbeat", { t: "2026-06-29T10:00:00Z" }]))
    expect((frame as any)[3].t).toBeInstanceOf(Date)
  })

  it("isoDateReviver leaves non-date strings alone", () => {
    expect(isoDateReviver("k", "hello")).toBe("hello")
  })

  it("does NOT mutate the caller's payload Date fields on encode", () => {
    const when = new Date("2026-06-29T10:00:00Z")
    const payload = { timestamp: when }
    encode([MessageType.Call, "id", "Heartbeat", payload])
    expect(payload.timestamp).toBeInstanceOf(Date)
    expect(payload.timestamp).toBe(when)
  })
})
