import type { Logger } from "./types.js"

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

let current: Logger = noopLogger

/** Inject a logger for the library to use. Pass nothing to reset to no-op. */
export function setLogger(logger?: Logger): void {
  current = logger ?? noopLogger
}

/** Internal: the active logger. */
export function log(): Logger {
  return current
}
