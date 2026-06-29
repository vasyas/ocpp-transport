import {
  MessageType,
  type Frame,
  type MessageParser,
  type MessageSerializer,
} from "./types.js"

/** Raised when an inbound frame cannot be parsed or is structurally invalid. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FrameError"
  }
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/

/**
 * JSON.parse reviver that turns ISO-8601 strings into Date objects. OCPP
 * payloads carry timestamps as strings; this restores them on decode.
 */
export function isoDateReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE.test(value)) {
    const ms = Date.parse(value)
    if (!Number.isNaN(ms)) return new Date(ms)
  }
  return value
}

/** Default parser: JSON.parse with ISO-date revival. */
export const defaultMessageParser: MessageParser = (raw) =>
  JSON.parse(raw, isoDateReviver)

/**
 * Default serializer: plain JSON.stringify. This does NOT mutate the input —
 * Date fields serialize to ISO strings via Date.prototype.toJSON during
 * stringification, leaving the caller's payload object untouched. (push-rpc's
 * serializer mutated Date fields in place; we deliberately do not.)
 */
export const defaultMessageSerializer: MessageSerializer = (frame) =>
  JSON.stringify(frame)

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

export interface DecodeOptions {
  parser?: MessageParser
  /** Max raw frame size in bytes; 0/undefined disables. Default 65536. */
  maxFrameSize?: number
}

/**
 * Decode a raw inbound text frame into a typed OCPP-J Frame.
 *
 * The size guard runs BEFORE the parser, so an oversized frame is rejected
 * without ever invoking (a potentially expensive or lenient) custom parser.
 * Throws FrameError on size violation, parse failure, or structural mismatch.
 */
export function decode(raw: string, options: DecodeOptions = {}): Frame {
  const max = options.maxFrameSize ?? 65536
  if (max > 0 && byteLength(raw) > max) {
    throw new FrameError(`Frame exceeds max size of ${max} bytes`)
  }

  const parser = options.parser ?? defaultMessageParser
  let value: unknown
  try {
    value = parser(raw)
  } catch (e) {
    throw new FrameError(
      `Failed to parse frame: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (!Array.isArray(value) || value.length < 2) {
    throw new FrameError("Frame is not a non-empty OCPP-J array")
  }

  const type = value[0]
  const id = value[1]
  if (typeof id !== "string") {
    throw new FrameError("Frame message id is not a string")
  }

  switch (type) {
    case MessageType.Call: {
      const action = value[2]
      if (typeof action !== "string") {
        throw new FrameError("CALL action is not a string")
      }
      return [MessageType.Call, id, action, value[3] ?? null]
    }
    case MessageType.CallResult:
      return [MessageType.CallResult, id, value[2] ?? null]
    case MessageType.CallError: {
      const code = value[2]
      const description = value[3]
      return [
        MessageType.CallError,
        id,
        typeof code === "string" ? code : "GenericError",
        typeof description === "string" ? description : "",
        value[4] ?? null,
      ]
    }
    default:
      throw new FrameError(`Unknown message type id: ${String(type)}`)
  }
}

export interface EncodeOptions {
  serializer?: MessageSerializer
}

/** Encode a frame array to a wire string without mutating its contents. */
export function encode(frame: unknown[], options: EncodeOptions = {}): string {
  const serializer = options.serializer ?? defaultMessageSerializer
  return serializer(frame)
}
