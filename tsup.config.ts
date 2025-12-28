import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      enterprise: "src/enterprise/index.ts"
    },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: true,
    outDir: "dist"
  },
  {
    entry: {
      cli: "src/cli.ts",
      mcp: "src/mcp.ts"
    },
    format: ["esm"],
    platform: "node",
    target: "node20",
    sourcemap: true,
    dts: false,
    clean: false,
    outDir: "dist"
  }
]);

