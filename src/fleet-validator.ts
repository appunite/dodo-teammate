// Bundles validate-fleet.ts, the one implementation of the fleet contract, into the single
// JavaScript file the reconciler runs on the host. The bundle carries the yaml dependency, so the
// host needs only a root-owned, pinned bun. bun's bundler output is reproducible, so an unchanged
// validator keeps its SHA-256 and your infrastructure installs nothing new.

export async function bundleFleetValidator(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL("./validate-fleet.ts", import.meta.url).pathname],
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  const [output] = result.outputs;
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    throw new Error(`Could not bundle the fleet validator: ${result.logs.join("\n")}`);
  }
  return output.text();
}
