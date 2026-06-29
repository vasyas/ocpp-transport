import { describe, it, expect } from "vitest"
import {
  serializeThrownError,
  toCallErrorFrame,
  buildReceivedError,
  sanitizeDetails,
  resolveHandler,
} from "../src/errors.js"
import { MessageType, type LocalHandlers } from "../src/types.js"

describe("error serialization (AE2)", () => {
  it("serializes code, message, and explicit details", () => {
    const err = Object.assign(new Error("Connector unknown"), {
      code: "NotSupported",
      details: { connectorId: 3 },
    })
    expect(toCallErrorFrame("id1", err)).toEqual([
      MessageType.CallError,
      "id1",
      "NotSupported",
      "Connector unknown",
      { connectorId: 3 },
    ])
  })

  it("emits a fallback errorCode when the thrown error has no code", () => {
    const { code } = serializeThrownError(new Error("boom"))
    expect(code).toBe("GenericError")
  })

  it("does NOT leak non-allowlisted properties (stack, internals) to the wire", () => {
    const err = Object.assign(new Error("fail"), {
      code: "InternalError",
      query: "SELECT secret FROM users",
      apiKey: "sk-123",
    })
    const { details } = serializeThrownError(err)
    expect(details).toBeNull()
    const frame = toCallErrorFrame("id", err)
    expect(JSON.stringify(frame)).not.toContain("sk-123")
    expect(JSON.stringify(frame)).not.toContain("SELECT secret")
  })
})

describe("inbound sanitization (prototype pollution)", () => {
  it("does not pollute Object.prototype via __proto__ in received details", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}}')
    buildReceivedError("SomeError", "desc", evil)
    expect(({} as any).polluted).toBeUndefined()
  })

  it("strips constructor/prototype keys recursively", () => {
    const cleaned = sanitizeDetails({
      ok: 1,
      constructor: "x",
      nested: { prototype: "y", keep: 2 },
    }) as any
    expect(cleaned.ok).toBe(1)
    expect(cleaned.constructor).toBe(Object) // own key stripped → inherited Object ctor
    expect(Object.prototype.hasOwnProperty.call(cleaned, "constructor")).toBe(false)
    expect(cleaned.nested).toEqual({ keep: 2 })
  })

  it("attaches code and sanitized details to the rejected Error", () => {
    const e = buildReceivedError("NotSupported", "nope", { connectorId: 1 })
    expect(e.code).toBe("NotSupported")
    expect(e.details).toEqual({ connectorId: 1 })
  })
})

describe("action-name guard", () => {
  const handlers: LocalHandlers = {
    Authorize: () => ({ status: "Accepted" }),
  }

  it("resolves a legitimate handler", () => {
    expect(resolveHandler(handlers, "Authorize")).toBeTypeOf("function")
  })

  it("returns undefined for a prototype-property action name", () => {
    expect(resolveHandler(handlers, "constructor")).toBeUndefined()
    expect(resolveHandler(handlers, "__proto__")).toBeUndefined()
    expect(resolveHandler(handlers, "toString")).toBeUndefined()
  })

  it("returns undefined for an unknown action", () => {
    expect(resolveHandler(handlers, "Nope")).toBeUndefined()
  })
})
