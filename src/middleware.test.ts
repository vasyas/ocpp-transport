import { describe, it, expect } from "vitest"
import { composeMiddleware, runLocal } from "./middleware.js"
import { MessageType, type ConnectionContext, type Middleware } from "./types.js"

const ctx: ConnectionContext = { id: "cp1" }

describe("composeMiddleware", () => {
  it("runs middleware in order and reaches the handler with transformed params", async () => {
    const order: string[] = []
    const a: Middleware = async (_c, next, p: any) => {
      order.push("a")
      return next({ ...p, a: true })
    }
    const b: Middleware = async (_c, next, p: any) => {
      order.push("b")
      return next({ ...p, b: true })
    }
    const result = await composeMiddleware(a, b)(
      ctx,
      async (p) => {
        order.push("handler")
        return p
      },
      { start: 1 },
      MessageType.Call,
    )
    expect(order).toEqual(["a", "b", "handler"])
    expect(result).toEqual({ start: 1, a: true, b: true })
  })

  it("rejects when next() is called twice in one middleware", async () => {
    const bad: Middleware = async (_c, next, p) => {
      await next(p)
      return next(p)
    }
    await expect(
      composeMiddleware(bad)(ctx, async (p) => p, {}, MessageType.Call),
    ).rejects.toThrow(/next\(\) called multiple times/)
  })

  it("lets a middleware short-circuit without invoking the handler", async () => {
    let handlerRan = false
    const shortCircuit: Middleware = async () => ({ blocked: true })
    const result = await composeMiddleware(shortCircuit)(
      ctx,
      async () => {
        handlerRan = true
        return { ok: true }
      },
      {},
      MessageType.Call,
    )
    expect(handlerRan).toBe(false)
    expect(result).toEqual({ blocked: true })
  })

  it("passes messageType through to each middleware", async () => {
    let seen: MessageType | undefined
    const mw: Middleware = async (_c, next, p, mt) => {
      seen = mt
      return next(p)
    }
    await composeMiddleware(mw)(ctx, async (p) => p, {}, MessageType.Call)
    expect(seen).toBe(MessageType.Call)
  })
})

describe("runLocal", () => {
  it("invokes directly when there is no middleware", async () => {
    const result = await runLocal([], ctx, { x: 1 }, MessageType.Call, async (p) => p)
    expect(result).toEqual({ x: 1 })
  })
})
