// Validates the repository's fleet against the contract in fleet-rules.ts. CI runs this through
// `mise run check`; a root argument validates another checkout (the parity tests use it).

import { resolve } from "node:path";
import { loadRepo, validate } from "./fleet-rules";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
const problems = validate(loadRepo(root));
if (problems.length > 0) {
  for (const problem of problems) console.error(`fleet: ${problem}`);
  process.exit(1);
}
console.log("Fleet contract satisfied.");
