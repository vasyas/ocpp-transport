import type { ConnectionContext, MessageType, Middleware } from "./types.js"

/**
 * Compose middleware into a single Middleware, invoked left-to-right with the
 * handler at the tail. Each middleware receives `next`; calling it more than
 * once throws. Compatible with @push-rpc/core's composeMiddleware.
 */
export function composeMiddleware(...middleware: Middleware[]): Middleware {
  return function composed(ctx, next, params, messageType) {
    let lastIndex = -1
    function dispatch(i: number, p: unknown): Promise<unknown> {
      if (i <= lastIndex) {
        return Promise.reject(new Error("next() called multiple times"))
      }
      lastIndex = i
      const fn = i === middleware.length ? next : middleware[i]
      if (!fn) return Promise.resolve(p)
      try {
        if (i === middleware.length) {
          return Promise.resolve((fn as typeof next)(p))
        }
        return Promise.resolve(
          (fn as Middleware)(ctx, (np) => dispatch(i + 1, np), p, messageType),
        )
      } catch (e) {
        return Promise.reject(e)
      }
    }
    return dispatch(0, params)
  }
}

/**
 * Run a local (inbound-handler) middleware chain around `invoke`. Returns the
 * handler's (possibly middleware-transformed) result.
 */
export function runLocal(
  middleware: Middleware[],
  ctx: ConnectionContext,
  params: unknown,
  messageType: MessageType,
  invoke: (params: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (middleware.length === 0) return invoke(params)
  return composeMiddleware(...middleware)(ctx, invoke, params, messageType)
}
