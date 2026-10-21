// The validator run as the host runs it: the CLI with --root against a copy of this repository that
// breaks one rule. The in-memory cases are in validate-fleet.test.ts; these also cover the policy.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { type Mutation, mutatedCheckout, repositoryRoot } from "./helpers";

function cliProblems(root: string): string {
  const run = spawnSync(
    process.execPath,
    [join(repositoryRoot, "src", "validate-fleet.ts"), `--root=${root}`],
    { encoding: "utf8" },
  );
  if (run.status !== 0 && run.status !== 1) throw new Error(`validator crashed: ${run.stderr}`);
  return run.status === 0 ? "" : run.stderr;
}

const fleet = "profiles/fleet.yaml";
const slackConfig = "profiles/myagent-slack/config.yaml";
const adminConfig = "profiles/myagent-admin/config.yaml";
const outboundConfig = "profiles/myagent-scheduled/config.yaml";

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit arbitrary YAML documents.
const named = (document: any, name: string): any =>
  document.profiles.find((entry: { name: string }) => entry.name === name);
// biome-ignore lint/suspicious/noExplicitAny: fixtures edit arbitrary YAML documents.
const team = (document: any): any => named(document, "myagent-slack");

// Each case edits the same thing in the fleet entry and config.yaml where both carry it.
const cases: Record<string, { edits: Record<string, Mutation>; fragment: string }> = {
  "web next to private data": {
    edits: {
      [fleet]: (document) => team(document).platform_toolsets.slack.push("web"),
      [slackConfig]: (document) => document.platform_toolsets.slack.push("web"),
    },
    fragment: "would open a way out",
  },
  "a delete tool": {
    edits: {
      [fleet]: (document) => team(document).mcp_servers.linear.tools.include.push("delete_issue"),
      [slackConfig]: (document) => document.mcp_servers.linear.tools.include.push("delete_issue"),
    },
    fragment: "is a delete tool",
  },
  "a tool the policy does not review": {
    edits: {
      [fleet]: (document) => team(document).mcp_servers.linear.tools.include.push("create_project"),
      [slackConfig]: (document) => document.mcp_servers.linear.tools.include.push("create_project"),
    },
    fragment: "the policy does not review create_project",
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
      [fleet]: (document) => team(document).platform_toolsets.cli.push("kanban"),
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
  "an MCP URL the policy does not review": {
    edits: {
      [fleet]: (document) => (team(document).mcp_servers.linear.url = "https://mcp.linear.app/sse"),
      [slackConfig]: (document) => (document.mcp_servers.linear.url = "https://mcp.linear.app/sse"),
    },
    fragment: "not a reviewed server in policy.mcp_servers",
  },
  "a write from a profile that is not a writer": {
    edits: { [fleet]: (document) => (document.policy.mcp_servers[0].writers = ["myagent-admin"]) },
    fragment: "save_issue writes, and only myagent-admin may",
  },
  "a restricted tool on the team profile": {
    edits: {
      [fleet]: (document) => (document.policy.mcp_servers[1].restricted = ["search_errors"]),
    },
    fragment: "search_errors is restricted",
  },
  "a credential the policy does not list": {
    edits: { [fleet]: (document) => delete document.policy.credentials.SENTRY_READ_TOKEN },
    fragment: "SENTRY_READ_TOKEN is not in policy.credentials",
  },
  "a credential in a profile the policy does not allow": {
    edits: {
      [fleet]: (document) =>
        (document.policy.credentials.SENTRY_READ_TOKEN.profiles = ["myagent-admin"]),
    },
    fragment: "SENTRY_READ_TOKEN belongs only to myagent-admin",
  },
  "a header credential sent to another URL": {
    edits: {
      [fleet]: (document) =>
        (document.policy.credentials.SENTRY_READ_TOKEN.urls = ["https://mcp.linear.app/mcp"]),
    },
    fragment: "SENTRY_READ_TOKEN may travel only",
  },
  "a script credential not passed to scripts": {
    edits: { [outboundConfig]: (document) => delete document.terminal.env_passthrough },
    fragment: "must be passed in terminal.env_passthrough",
  },
  "an older fleet schema": {
    edits: { [fleet]: (document) => (document.schema_version = 1) },
    fragment: "schema_version must be 2",
  },
};

describe("the validator CLI", () => {
  test("accepts the template as shipped", () => {
    expect(cliProblems(repositoryRoot)).toBe("");
  });

  for (const [name, { edits, fragment }] of Object.entries(cases)) {
    test(`refuses ${name}`, () => {
      const checkout = mutatedCheckout(edits);
      try {
        expect(cliProblems(checkout.root)).toContain(fragment);
      } finally {
        checkout.cleanup();
      }
    });
  }
});
