import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "balance/index": "src/balance/index.ts",
    "testing/index": "src/testing/index.ts",
    node: "src/node.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["break_eternity.js", "zod"],
});
