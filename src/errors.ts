import {
  MessageType,
  type CallErrorFrame,
  type LocalHandlers,
} from "./types.js"

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** An Error surfaced from a received CALLERROR. */
export interface CallError extends Error {
  code: string
  details?: unknown
}

/**
 * Recursively strip prototype-pollution keys, rebuilding plain objects so a
 * merged result can never reach Object.prototype. Arrays and primitives pass
 * through; objects are copied key-by-key skipping dangerous keys.
 */
export function sanitizeDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDetails)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (DANGEROUS_KEYS.has(key)) continue
      out[key] = sanitizeDetails((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/**
 * Serialize a thrown handler error into the CALLERROR fields, using an
 * explicit allowlist — never a blanket spread of all enumerable properties,
 * which would leak stacks, query strings, or secrets to field devices.
 *
 * - `code`: `error.code` if a non-empty string, else the fixed fallback
 *   "GenericError" so the frame is always structurally valid (the vocabulary
 *   itself is not validated — staying OCPP-version-agnostic).
 * - `description`: `error.message`.
 * - `details`: only an explicit `error.details` / `error.data` field.
 */
export function serializeThrownError(err: unknown): {
  code: string
  description: string
  details: unknown
} {
  const e = (err ?? {}) as Record<string, unknown>
  const code = typeof e.code === "string" && e.code ? e.code : "GenericError"
  const description = typeof e.message === "string" ? e.message : ""
  const details = e.details ?? e.data ?? null
  return { code, description, details }
}

/** Build the CALLERROR wire frame for a thrown handler error. */
export function toCallErrorFrame(id: string, err: unknown): CallErrorFrame {
  const { code, description, details } = serializeThrownError(err)
  return [MessageType.CallError, id, code, description, details]
}

/**
 * Build the rejected Error for a received CALLERROR. The incoming details are
 * sanitized before being attached, preventing prototype pollution from
 * untrusted charger input.
 */
export function buildReceivedError(
  code: string,
  description: string,
  details: unknown,
): CallError {
  const err = new Error(description || code || "Remote call failed") as CallError
  err.name = "CallError"
  err.code = code
  if (details != null) err.details = sanitizeDetails(details)
  return err
}

/**
 * Resolve an inbound handler by action name, guarding against action names
 * that match Object.prototype members (e.g. "constructor", "__proto__",
 * "toString"). Only own, non-dangerous keys resolve; everything else returns
 * undefined so the caller can reject the frame with a CALLERROR.
 */
export function resolveHandler(
  handlers: LocalHandlers,
  action: string,
): LocalHandlers[string] | undefined {
  if (DANGEROUS_KEYS.has(action)) return undefined
  if (!Object.prototype.hasOwnProperty.call(handlers, action)) return undefined
  const fn = handlers[action]
  return typeof fn === "function" ? fn : undefined
}
