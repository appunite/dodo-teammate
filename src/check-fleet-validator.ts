// Checks the artifact the host runs, not just the source: the bundle must be reproducible (or every
// install would ship a new one) and must validate this checkout the way `mise run fleet` does, when
// run the way the reconciler runs it. With --out=<path> it also writes the bundle and its SHA-256
// for your infrastructure to install next to the reconciler.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { bundleFleetValidator } from "./fleet-validator";

const first = await bundleFleetValidator();
const second = await bundleFleetValidator();
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
if (sha256(first) !== sha256(second)) {
  console.error("The fleet validator bundle is not reproducible.");
  process.exit(1);
}

// The reconciler runs the bundle from an empty directory, so no .env or bunfig.toml applies.
const work = mkdtempSync(join(tmpdir(), "fleet-validator-"));
try {
  const bundle = join(work, "validate-fleet.js");
  writeFileSync(bundle, first);
  const run = spawnSync(
    process.execPath,
    ["--no-install", "--no-env-file", bundle, `--root=${resolve(import.meta.dir, "..")}`],
    { cwd: work, encoding: "utf8", stdio: "inherit" },
  );
  if (run.status !== 0) {
    console.error("The bundled fleet validator refused this checkout.");
    process.exit(1);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const out = /^--out=(.+)$/.exec(process.argv[2] ?? "")?.[1];
if (out !== undefined) {
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, first);
  writeFileSync(`${out}.sha256`, `${sha256(first)}  validate-fleet.js\n`);
}
console.log(`Fleet validator bundle ${sha256(first)} is reproducible and accepts this checkout.`);
