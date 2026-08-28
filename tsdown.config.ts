import { defineConfig } from "tsdown";

// A syntax baseline, not a runtime claim. This package runs on Bun, and every
// release in `engines.bun` supports more syntax than this — but pinning a level
// keeps output reproducible where "esnext" drifts with tool versions, and
// targeting a runtime beats targeting an ES year, which downlevels anything
// newer than itself (a `using` declaration costs ~1.8 kB of helpers under
// es2025 versus 170 bytes native here).
const SYNTAX_TARGET = "node24";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  platform: "node",
  target: SYNTAX_TARGET,
  sourcemap: false,
  nodeProtocol: true,
  // `nodeProtocol` prefixes builtin specifiers with `node:`, and it counts
  // `bun:sqlite` as a builtin, emitting `import { Database } from
  // "node:bun:sqlite"` into the .d.ts — a specifier that resolves nowhere, and
  // one neither publint nor attw flags. Exempting it keeps the normalization
  // working for actual node builtins instead of disabling it repo-wide.
  deps: { neverBundle: ["bun:sqlite"] },
  fixedExtension: false,
  // Validate the published package shape on every build.
  publint: true,
  attw: true,
});
