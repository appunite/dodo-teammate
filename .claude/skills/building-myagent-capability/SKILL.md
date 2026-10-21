---
name: building-myagent-capability
description: Use when adding or changing what MyAgent can do in this repository — a new capability, integration, MCP server, plugin or hand-off tool, Kanban worker, scheduled job, credential, Slack surface, or a change to an existing one, up to an open pull request. Trigger on "give MyAgent access to X", "add a capability", "connect <service> to MyAgent", "new worker/profile/cron job", "MyAgent should be able to…", or any edit under profiles/, shared/, or infra/ that changes its behaviour, even when the user does not say "capability". For rolling a merged change out to the host, use deploying-myagent instead.
---

# Building a MyAgent capability

This repository is the reviewed source of truth for MyAgent's Hermes profiles. A capability is
usually a few profile files plus an entry in the fleet policy the validator enforces, and it only works once
it has been proven against the Hermes build that actually runs on the host. This skill gets you
from an idea to a pull request that will deploy cleanly.

## Start from the routing table, not from memory

`infra/docs/changing-myagent.md` → **I want to…** lists, for every kind of change, which files to
edit and which release path (A fleet, B validator, reconciler, or infrastructure, C runtime) it
needs. Find your row first, then read the linked section of `infra/docs/deploy-profiles.md`.

## Start from the spec

Write `docs/myagent-capabilities/capabilities/c<n>-<name>.md` from
`docs/myagent-capabilities/capabilities/TEMPLATE.md` before code: what
MyAgent does, where it runs, the trust and data boundary, credentials (owner, scopes, rotation),
the abuse analysis, and how to test it from Slack. Read `AGENTS.md` → **Working on the fleet
contract** first.

## Pick the profile

- **Read-only answers in Slack** → `myagent-slack`: add an MCP server with an exact
  `tools.include` and a read-only key. No `web`, `vision`, or shell next to it.
- **A write from Slack** → `myagent-slack` only if it is small and reversible; list each write
  tool in its server's `writes` and the profile in its `writers` in the fleet policy, add an
  accepted risk, and make the skill report every write.
- **Code execution, extra credentials, or a heavy skill** → a new Kanban worker behind a typed
  hand-off tool (`profiles/myagent-slack/README.md` → **Adding a hand-off**). Copy
  `profiles/myagent-writer/`.
- **On a clock** → `myagent-scheduled`; a `no_agent` script when no judgement is needed.
- **Owner-only tooling** → `myagent-admin`.

## Design: simplest thing that works, live from the start

- Prefer Hermes's own boundaries (toolsets, allowlists, profiles) to new isolation layers.
- Ship the real behaviour, with its controls in validated config; avoid dry-run or propose-only
  phases. State the risk once in the spec and `docs/myagent-capabilities/accepted-risks.md`.
- If a design needs something heavier, say why in one line and ask before building it.

## Policy in the fleet, rules in the validator

`infra/src/validate-fleet.ts` is the one validator: CI runs it, and the host runs the same code from
a bundle your infrastructure installs by hash. It is Dodo's, copied verbatim: never edit it here.
It and `infra/assets/reconcile-profiles.sh` stay generic: never put a profile name, MCP URL, tool,
credential name, or path in either. Those belong in the `policy` block of `profiles/fleet.yaml`:

- a remote MCP server or tool: `policy.mcp_servers` (exact URL, `tools`, `writes` and their
  `writers`, `restricted` tools a profile teammates can message never loads);
- a credential: `policy.credentials` (the `profiles` that may hold it, and `header` with `urls`, or
  `script: true` with `copy_of` for a copy of a gateway key, or a stdio server that reads it);
- a stdio wrapper or one of the agent's own servers: `policy.stdio_servers`;
- a profile with special standing: `owner_console`, `personal_data_profiles`,
  `model_free_profiles`; a skill that writes to GitHub: `repository_write_skills`;
- a path only some files may name: `policy.restricted_paths`.

Most capabilities change only the policy and profile files: release path A. A genuinely new kind of
rule goes into Dodo first, generically; then copy the newer validator here (`AGENTS.md` → **Staying
in line with Dodo**). A script's own configuration is checked by its unit tests, not the validator.

## Check Hermes against the host, not the docs

Before a plugin, script, or MCP server relies on a Hermes module, function, file path, CLI flag, or
config key:

1. Find it in the source of the Hermes release you run, and cite file and line.
2. Confirm the same name exists in the Hermes build on the host (a read-only probe through
   `deploying-myagent`). Import from the module that defines it, not one that re-exports it.
3. Test the plugin with fakes shaped like the host's modules, driving the real handler entry
   points, as `tests/plugins/test_handoff.py` does.

Match third-party token and ID formats loosely; providers change them.

## Credentials

Declare names only, in `runtime_env`. For each new key, record in the pull request and the
profile README who owns it, its exact scopes, and where to rotate it. Get scopes right up front; a
missing scope shows up only live. Never use a personal login or an interactive OAuth grant.

## Finish the change

- Edit `profiles/fleet.yaml` and the profile's `config.yaml` identically (the validator compares
  them), and keep `agent.disabled_toolsets` listing every unselected built-in toolset.
- Bump `version` in every `distribution.yaml` and `plugin.yaml` you touch.
- Update the profile README, the spec, and `shared/skills/myagent-capabilities/SKILL.md`.
- A new scheduled job arrives paused; say in the pull request who resumes it and when.
- Run `set -o pipefail; mise run check` and fix what you caused.
- The pull request body names the release path (fleet, host, runtime), every runtime step for the
  operator, and the Slack message that proves it works.
