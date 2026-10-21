// biome-ignore-all lint/suspicious/noExplicitAny: the fixtures edit arbitrary YAML documents.
// The fleet validator, run the way the host runs it, against copies of this repository's fleet that
// each break one rule. Run with `mise run fleet-tests`.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse, stringify } from "yaml";

const repository = resolve(import.meta.dir, "../..");
const validator = resolve(import.meta.dir, "../src/validate-fleet.ts");

type Edit = (root: string) => void;

function editYaml(root: string, file: string, edit: (document: any) => void): void {
  const path = join(root, file);
  const document = parse(readFileSync(path, "utf8"), { version: "1.1" });
  edit(document);
  writeFileSync(path, stringify(document, { lineWidth: 0 }));
}

const fleet =
  (edit: (document: any) => void): Edit =>
  (root) =>
    editYaml(root, "profiles/fleet.yaml", edit);
const profile = (document: any, name: string): any =>
  name === "default"
    ? document.default_profile
    : document.profiles.find((p: any) => p.name === name);
// The same edit on a profile's fleet entry and on its config.yaml, so only the rule under test fails.
const both =
  (name: string, edit: (entry: any) => void): Edit =>
  (root) => {
    editYaml(root, "profiles/fleet.yaml", (document) => edit(profile(document, name)));
    editYaml(root, `profiles/${name}/config.yaml`, edit);
  };

// Copies profiles/ and shared/, applies the edits, and returns the validator's error, or "" when
// it accepts the fleet.
function validate(...edits: Edit[]): string {
  const root = mkdtempSync(join(tmpdir(), "fleet-"));
  try {
    cpSync(join(repository, "profiles"), join(root, "profiles"), { recursive: true });
    cpSync(join(repository, "shared"), join(root, "shared"), { recursive: true });
    for (const edit of edits) {
      edit(root);
    }
    const run = spawnSync(process.execPath, [validator, `--root=${root}`], { encoding: "utf8" });
    return run.status === 0 ? "" : run.stderr;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the fleet validator", () => {
  test("accepts the fleet as shipped", () => {
    expect(validate()).toBe("");
  });

  const refusals: Record<string, [Edit[], string]> = {
    "an older fleet schema": [[fleet((d) => (d.schema_version = 5))], "schema_version 6"],
    "a named profile that is not installed": [
      [fleet((d) => (profile(d, "myagent-writer").desired_state = "present"))],
      "desired_state: installed",
    ],
    "web next to MCP data on a teammate surface": [
      [both("myagent-slack", (p) => p.platform_toolsets.slack.push("web"))],
      "egress toolset",
    ],
    "a terminal teammates can reach": [
      [both("myagent-slack", (p) => p.platform_toolsets.slack.push("terminal"))],
      "terminal",
    ],
    "a second user on the owner console": [
      [
        (root) =>
          editYaml(root, "profiles/myagent-admin/config.yaml", (c) =>
            c.slack.allow_from.push("U000TEAM01"),
          ),
      ],
      "unsafe toolsets",
    ],
    "a delete tool": [
      [both("myagent-slack", (p) => p.mcp_servers.linear.tools.include.push("delete_issue"))],
      "delete tools",
    ],
    "an MCP URL the policy does not review": [
      [
        both(
          "myagent-slack",
          (p) => (p.mcp_servers.sentry.url = "https://mcp.sentry.dev/mcp/other"),
        ),
      ],
      "not a reviewed server",
    ],
    "a tool the policy does not review for its URL": [
      [both("myagent-slack", (p) => p.mcp_servers.sentry.tools.include.push("update_issue"))],
      "does not review",
    ],
    "a write from a profile that is not a writer": [
      [fleet((d) => (d.policy.mcp_servers[0].writers = ["myagent-admin"]))],
      "writes through",
    ],
    "a restricted tool on a teammate surface": [
      [fleet((d) => (d.policy.mcp_servers[0].restricted = ["save_issue"]))],
      "never loads",
    ],
    "a credential the policy does not list": [
      [fleet((d) => profile(d, "myagent-slack").runtime_env.push("EXTRA_READ_TOKEN"))],
      "not in the fleet policy's credentials",
    ],
    "a credential in a profile the policy does not allow": [
      [fleet((d) => profile(d, "myagent-admin").runtime_env.push("SENTRY_READ_TOKEN"))],
      "belongs only to",
    ],
    "a header credential sent to another URL": [
      [
        fleet(
          (d) => (d.policy.credentials.SENTRY_READ_TOKEN.urls = ["https://mcp.linear.app/mcp"]),
        ),
      ],
      "may send SENTRY_READ_TOKEN only",
    ],
    "personal data delivered to a channel": [
      [
        fleet((d) => {
          d.policy.personal_data_profiles = ["myagent-scheduled"];
          profile(d, "myagent-scheduled").delivery_targets = ["slack:C000TEAM01"];
        }),
      ],
      "only to Slack DMs",
    ],
    "a model in a model-free profile": [
      [fleet((d) => (d.policy.model_free_profiles = ["myagent-scheduled"]))],
      "Model-free profile myagent-scheduled",
    ],
    "a restricted path named outside its users": [
      [
        fleet((d) => (d.policy.restricted_paths = { ".config/myagent-key": [] })),
        (root) =>
          appendFileSync(
            join(root, "shared/skills/untrusted-input/SKILL.md"),
            "\n.config/myagent-key\n",
          ),
      ],
      "names .config/myagent-key",
    ],
    "a policy naming an unknown profile": [
      [fleet((d) => (d.policy.owner_console = "nobody"))],
      "does not declare: nobody",
    ],
    "hand-off tools that drift from the workers": [
      [fleet((d) => d.policy.handoff.tools.push("handoff_extra"))],
      "tools must be exactly",
    ],
    "bot posts the policy does not list": [
      [fleet((d) => (d.policy.handoff.bot_mention_patterns = ["anything"]))],
      "bot_mention_patterns",
    ],
    "an MCP URL without a host": [
      [fleet((d) => d.policy.mcp_servers.push({ url: "https:mcp.example.com/mcp", tools: ["x"] }))],
      "https URL",
    ],
    "a stdio server the policy does not list": [
      [
        both("myagent-writer", (p) => {
          p.mcp_servers.tool = {
            command: "/opt/other/server",
            args: ["myagent-writer"],
            tools: { include: ["read"], resources: false, prompts: false },
            sampling: { enabled: false },
            elicitation: { enabled: false },
            trust: "full",
            lifecycle: { max_lifetime_seconds: 600 },
          };
        }),
      ],
      "stdio_servers",
    ],
  };

  for (const [name, [edits, fragment]] of Object.entries(refusals)) {
    test(`refuses ${name}`, () => {
      expect(validate(...edits)).toContain(fragment);
    });
  }
});
