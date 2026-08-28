/**
 * Guards the one coupling this repo cannot express in a single place.
 *
 * `engines.node` is the source of truth. The tsdown build target and the CI
 * Node version are both derived from it (see tsdown.config.ts and the
 * `node-version-file` inputs in .github/workflows), so they cannot drift.
 *
 * Two version pairs cannot be derived, because both halves are pinned
 * dependency versions, and both fail silently when they drift:
 *
 *   - `@types/node` vs `engines.node`: typings newer than the engines floor let
 *     TypeScript accept APIs that do not exist on the supported runtime.
 *   - `@types/bun` vs `packageManager`: typings for a different Bun release
 *     misdescribe `bun:test` and the rest of the Bun API.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const errors: Array<string> = [];

const enginesRange: string | undefined = pkg.engines?.node;
if (!enginesRange) {
  errors.push("engines.node is not set");
}

const enginesMajor = enginesRange ? /(\d+)/.exec(enginesRange)?.[1] : undefined;
if (enginesRange && !enginesMajor) {
  errors.push(`could not read a major version out of engines.node: ${enginesRange}`);
}

const typesRange: string | undefined = pkg.devDependencies?.["@types/node"];
if (!typesRange) {
  errors.push("@types/node is not in devDependencies");
}

const typesMajor = typesRange ? /(\d+)/.exec(typesRange)?.[1] : undefined;

if (enginesMajor && typesMajor && enginesMajor !== typesMajor) {
  const why =
    Number(typesMajor) > Number(enginesMajor)
      ? "Typings ahead of the floor let TypeScript accept APIs that do not exist at runtime."
      : "Typings behind the floor hide APIs the supported runtime actually has.";
  errors.push(
    `@types/node ${typesRange} types Node ${typesMajor}, but engines.node is "${enginesRange}" (Node ${enginesMajor}).\n` +
      `  ${why}\n` +
      `  Set @types/node to the ${enginesMajor}.x line, or change engines.node.`,
  );
}

const bunPin: string | undefined = pkg.packageManager;
const bunVersion = bunPin?.startsWith("bun@") ? bunPin.slice("bun@".length) : undefined;
if (bunPin && !bunVersion) {
  errors.push(`packageManager is "${bunPin}", expected it to start with "bun@"`);
}

const typesBun: string | undefined = pkg.devDependencies?.["@types/bun"];
if (bunVersion && typesBun) {
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  if (minor(bunVersion) !== minor(typesBun)) {
    errors.push(
      `@types/bun ${typesBun} does not match packageManager bun@${bunVersion}.\n` +
        "  Bun typings from a different release misdescribe bun:test and the Bun API.\n" +
        `  Set @types/bun to the ${minor(bunVersion)}.x line, or change packageManager.`,
    );
  }
}

if (errors.length > 0) {
  console.error("✗ engines check failed:\n");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`✓ engines.node "${enginesRange}" and @types/node ${typesRange} agree on Node ${enginesMajor}`);
console.log(`✓ packageManager ${bunPin} and @types/bun ${typesBun} agree`);
