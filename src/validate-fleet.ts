// The one implementation of the fleet contract (fleet-rules.ts). CI runs it over this checkout with
// `mise run fleet`; the reconciler runs the same code on the host, bundled (fleet-validator.ts), over
// the extracted release it is about to apply: --root names that release.

import { resolve } from "node:path";
import { loadRepo, validate } from "./fleet-rules";

const roots = process.argv.slice(2).map((argument) => /^--root=(\/.+)$/.exec(argument)?.[1]);
if (roots.length > 1 || roots.some((root) => root === undefined)) {
  console.error("usage: validate-fleet.ts [--root=/absolute/release]");
  process.exit(2);
}
const root = roots[0] ?? resolve(import.meta.dir, "..");
const problems = validate(loadRepo(root));
if (problems.length > 0) {
  for (const problem of problems) console.error(`fleet: ${problem}`);
  process.exit(1);
}
console.log("Fleet contract satisfied.");
