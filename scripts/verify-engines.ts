/**
 * Guards the version couplings this repo cannot express in a single place.
 *
 * This package runs on Bun, so `engines.bun` is the whole runtime contract and
 * there is deliberately no `engines.node`. The built JavaScript never imports
 * `bun:sqlite` — it only accepts a `Database` the caller hands it — so a Node
 * floor would constrain every consumer over what is purely a build concern.
 * Node appears in exactly one place, the release workflows, where the npm CLI
 * performs OIDC trusted publishing; those pin it directly.
 *
 * Two pairs cannot be derived from each other, and both fail silently when they
 * drift:
 *
 *   - `@types/bun` vs `packageManager`: typings from a different Bun release
 *     misdescribe `bun:test`, `bun:sqlite` and the rest of the Bun API.
 *   - `engines.bun` vs `packageManager`: a floor above the Bun that actually
 *     builds and tests the package is a floor nothing verifies.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const errors: Array<string> = [];

const parse = (version: string) => version.split(".").map(Number);
const minor = (version: string) => version.split(".").slice(0, 2).join(".");

const bunPin: string | undefined = pkg.packageManager;
const bunVersion = bunPin?.startsWith("bun@") ? bunPin.slice("bun@".length) : undefined;
if (!bunPin) {
  errors.push("packageManager is not set");
} else if (!bunVersion) {
  errors.push(`packageManager is "${bunPin}", expected it to start with "bun@"`);
}

if (pkg.engines?.node) {
  errors.push(
    `engines.node is set to "${pkg.engines.node}", but this package needs no Node at runtime.\n` +
      "  Declaring a Node floor makes npm and pnpm warn or fail for consumers over a build concern.\n" +
      "  The build target lives in tsdown.config.ts and the release workflows pin Node themselves.",
  );
}

const bunRange: string | undefined = pkg.engines?.bun;
if (!bunRange) {
  errors.push("engines.bun is not set — it is this package's only runtime contract");
}

const bunFloor = bunRange ? /(\d+\.\d+\.\d+)/.exec(bunRange)?.[1] : undefined;
if (bunRange && !bunFloor) {
  errors.push(`could not read a floor version out of engines.bun: ${bunRange}`);
}

if (bunFloor && bunVersion) {
  const [floorMajor, floorMinor, floorPatch] = parse(bunFloor);
  const [pinMajor, pinMinor, pinPatch] = parse(bunVersion);
  const floorIsAbovePin =
    floorMajor > pinMajor ||
    (floorMajor === pinMajor && floorMinor > pinMinor) ||
    (floorMajor === pinMajor && floorMinor === pinMinor && floorPatch > pinPatch);

  if (floorIsAbovePin) {
    errors.push(
      `engines.bun "${bunRange}" floors Bun at ${bunFloor}, above the packageManager pin bun@${bunVersion}.\n` +
        "  Nothing then builds or tests the oldest Bun the package claims to support.\n" +
        `  Lower engines.bun, or raise packageManager to ${bunFloor} or newer.`,
    );
  }
}

const typesBun: string | undefined = pkg.devDependencies?.["@types/bun"];
if (!typesBun) {
  errors.push("@types/bun is not in devDependencies");
}

if (bunVersion && typesBun && minor(bunVersion) !== minor(typesBun)) {
  errors.push(
    `@types/bun ${typesBun} does not match packageManager bun@${bunVersion}.\n` +
      "  Bun typings from a different release misdescribe bun:test and the Bun API.\n" +
      `  Set @types/bun to the ${minor(bunVersion)}.x line, or change packageManager.`,
  );
}

if (errors.length > 0) {
  console.error("✗ engines check failed:\n");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}

console.log(`✓ engines.bun "${bunRange}" is at or below the packageManager pin ${bunPin}`);
console.log(`✓ packageManager ${bunPin} and @types/bun ${typesBun} agree`);
console.log("✓ no engines.node — this package needs no Node at runtime");
