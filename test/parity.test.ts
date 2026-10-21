// Every boundary rule is enforced twice: by the TypeScript contract in CI and by host_rules.py on
// the host. These cases break a fleet on disk and require both to refuse it.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadRepo, validate } from "../src/fleet-rules";
import { type Mutation, mutatedCheckout, repositoryRoot } from "./helpers";

// The host runs the system interpreter, which has PyYAML (python3-yaml on Ubuntu).
const hostPython = process.env.HOST_PYTHON ?? "/usr/bin/python3";

function hostProblems(root: string): string {
  const run = spawnSync(
    hostPython,
    ["-I", join(repositoryRoot, "scripts", "host_rules.py"), root],
    {
      encoding: "utf8",
    },
  );
  if (run.status !== 0 && run.status !== 1) throw new Error(`host_rules.py failed: ${run.stderr}`);
  return run.status === 0 ? "" : run.stderr;
}

const fleet = "profiles/fleet.yaml";
const slackConfig = "profiles/myagent-slack/config.yaml";
const adminConfig = "profiles/myagent-admin/config.yaml";
const outboundConfig = "profiles/myagent-scheduled/config.yaml";

const teamProfile = (document: { profiles: { name: string }[] }) =>
  // biome-ignore lint/suspicious/noExplicitAny: fixtures edit arbitrary YAML documents.
  document.profiles.find((entry) => entry.name === "myagent-slack") as any;

// Each case edits the same thing in the fleet entry and config.yaml where both carry it.
const cases: Record<string, { edits: Record<string, Mutation>; fragment: string }> = {
  "web next to private data": {
    edits: {
      [fleet]: (document) => teamProfile(document).platform_toolsets.slack.push("web"),
      [slackConfig]: (document) => document.platform_toolsets.slack.push("web"),
    },
    fragment: "would open a way out",
  },
  "a delete tool": {
    edits: {
      [fleet]: (document) =>
        teamProfile(document).mcp_servers.linear.tools.include.push("delete_issue"),
      [slackConfig]: (document) => document.mcp_servers.linear.tools.include.push("delete_issue"),
    },
    fragment: "is a delete tool",
  },
  "an unreviewed write": {
    edits: {
      [fleet]: (document) =>
        teamProfile(document).mcp_servers.linear.tools.include.push("create_project"),
      [slackConfig]: (document) => document.mcp_servers.linear.tools.include.push("create_project"),
    },
    fragment: "list it in reviewed_writes",
  },
  "a second user on the owner console": {
    edits: { [adminConfig]: (document) => document.slack.allow_from.push("U000TEAM01") },
    fragment: "exactly [owner_slack_id]",
  },
  "memory on the team profile": {
    edits: { [slackConfig]: (document) => (document.memory.memory_enabled = true) },
    fragment: "keeps no memory",
  },
  "link unfurling": {
    edits: { [outboundConfig]: (document) => (document.slack.unfurl_links = true) },
    fragment: "unfurling must be off",
  },
  "the raw kanban toolset": {
    edits: {
      [fleet]: (document) => teamProfile(document).platform_toolsets.cli.push("kanban"),
      [slackConfig]: (document) => document.platform_toolsets.cli.push("kanban"),
    },
    fragment: "raw kanban toolset",
  },
  "a config that drifts from the fleet": {
    edits: { [slackConfig]: (document) => document.platform_toolsets.cli.push("todo") },
    fragment: "must equal the fleet entry",
  },
  "too many turns on shared Slack": {
    edits: { [slackConfig]: (document) => (document.agent.max_turns = 40) },
    fragment: "max_turns must be 1 to 25",
  },
};

describe("both validators", () => {
  test("accept the template as shipped", () => {
    expect(validate(loadRepo(repositoryRoot))).toEqual([]);
    expect(hostProblems(repositoryRoot)).toBe("");
  });

  for (const [name, { edits, fragment }] of Object.entries(cases)) {
    test(`refuse ${name}`, () => {
      const checkout = mutatedCheckout(edits);
      try {
        const ci = validate(loadRepo(checkout.root));
        expect(ci.some((problem) => problem.includes(fragment))).toBe(true);
        expect(hostProblems(checkout.root)).toContain(fragment);
      } finally {
        checkout.cleanup();
      }
    });
  }
});
