import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Derive the build target from engines.node so the two cannot drift.
// Targeting the runtime beats targeting an ES year: an ES year still downlevels
// anything newer than itself (a `using` declaration costs ~1.8 kB of helpers
// under es2025 versus 170 bytes native under node26), and a pinned runtime stays
// reproducible where "esnext" drifts with tool versions.
const nodeMajor = /(\d+)/.exec(pkg.engines.node)?.[1];
if (!nodeMajor) {
  throw new Error(`Could not derive a build target from engines.node: ${pkg.engines.node}`);
}

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm", "cjs"],
  platform: "node",
  target: `node${nodeMajor}`,
  sourcemap: false,
  // Off deliberately: this option prefixes builtin specifiers with `node:`,
  // and it treats `bun:sqlite` as one, emitting `import { Database } from
  // "node:bun:sqlite"` into the .d.ts — a specifier that resolves nowhere.
  // Nothing here imports a node builtin, so there is nothing to prefix.
  nodeProtocol: false,
  fixedExtension: false,
  // Validate the published package shape on every build.
  publint: true,
  attw: true,
});
