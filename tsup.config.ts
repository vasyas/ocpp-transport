import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/browser.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  // `ws` is an optional peer; never bundle it. The browser entry's graph does
  // not reference it at all.
  external: ["ws"],
  // No shared chunks, so the browser entry stays fully independent of the
  // node-only modules (server, ws socket factories).
  splitting: false,
  sourcemap: true,
})
