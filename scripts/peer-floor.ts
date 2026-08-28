/**
 * Prints the floor version of a peerDependency range.
 *
 * A peer floor is a promise about versions the test suite does not otherwise
 * run against, so it rots silently: the floor stays as written while the code
 * grows a dependency on something newer. CI installs the version this prints
 * and runs the suite against it, which turns the promise into a check.
 */
import { readFileSync } from "node:fs";

const name = process.argv[2];

if (!name) {
  console.error("usage: bun scripts/peer-floor.ts <dependency>");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const range: string | undefined = pkg.peerDependencies?.[name];

if (!range) {
  console.error(`${name} is not in peerDependencies`);
  process.exit(1);
}

const floor = /(\d+\.\d+\.\d+)/.exec(range)?.[1];

if (!floor) {
  console.error(`could not read a floor version out of peerDependencies.${name}: "${range}"`);
  process.exit(1);
}

console.log(floor);
