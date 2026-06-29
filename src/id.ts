/**
 * Generate a unique message id for call correlation. Uses the Web Crypto
 * `crypto.randomUUID()` global (present in browsers and Node >=18), so it
 * works in both environments without importing `node:crypto`. Falls back to a
 * timestamp+random id in the rare context where the global is unavailable
 * (message ids need uniqueness, not cryptographic strength).
 */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
