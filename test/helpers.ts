import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { loadRepo, type Repo } from "../src/fleet-rules";

export const repositoryRoot = resolve(import.meta.dir, "..");

// A fresh in-memory copy of this repository's fleet, safe to mutate.
export function freshRepo(): Repo {
  return structuredClone(loadRepo(repositoryRoot));
}

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit arbitrary YAML documents.
export type Mutation = (document: any) => void;

// A copy of the repository on disk with YAML files edited, for checks that read files.
export function mutatedCheckout(edits: Record<string, Mutation>): {
  root: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "fleet-"));
  cpSync(repositoryRoot, root, {
    recursive: true,
    filter: (source) => !source.includes("node_modules") && !source.includes("/.git"),
  });
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(root, file);
    const document = parse(readFileSync(path, "utf8"), { version: "1.1" });
    edit(document);
    writeFileSync(path, stringify(document, { lineWidth: 0 }));
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
