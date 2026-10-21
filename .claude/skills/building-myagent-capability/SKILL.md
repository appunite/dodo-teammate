---
name: building-myagent-capability
description: Use when adding or changing what MyAgent can do in this repository — a new capability, integration, MCP server, plugin or hand-off tool, Kanban worker, scheduled job, credential, Slack surface, or a change to an existing one, up to an open pull request. Trigger on "give MyAgent access to X", "add a capability", "connect <service> to MyAgent", "new worker/profile/cron job", "MyAgent should be able to…", or any edit under profiles/, shared/, src/, or scripts/ that changes its behaviour, even when the user does not say "capability". For rolling a merged change out to the host, use deploying-myagent instead.
---

# Building a MyAgent capability

This repository is the reviewed source of truth for MyAgent's Hermes profiles. A capability is
usually a few profile files plus, sometimes, a rule the validators enforce, and it only works once
it has been proven against the Hermes build that actually runs on the host. This skill gets you
from an idea to a pull request that will deploy cleanly.

## Start from the spec

Write `docs/capabilities/c<n>-<name>.md` from `docs/capabilities/TEMPLATE.md` before code: what
MyAgent does, where it runs, the trust and data boundary, credentials (owner, scopes, rotation),
the abuse analysis, and how to test it from Slack. Read `AGENTS.md` → **Working on the fleet
contract** first.

## Pick the profile by role

- **Read-only answers in Slack** → the `team` profile: add an MCP server with an exact
  `tools.include` and a read-only key. No `web`, `vision`, or shell next to it.
- **A write from Slack** → the `team` profile only if it is small and reversible; list each write
  tool in `reviewed_writes`, add an accepted risk, and make the skill report every write.
- **Code execution, extra credentials, or a heavy skill** → a new `worker` profile behind a typed
  hand-off tool (`profiles/myagent-slack/README.md` → **Adding a hand-off**). Copy
  `profiles/myagent-writer/`.
- **On a clock** → the `scheduled` profile; a `no_agent` script when no judgement is needed.
- **Owner-only tooling** → `myagent-admin`.

## Design: simplest thing that works, live from the start

- Prefer Hermes's own boundaries (toolsets, allowlists, roles) to new isolation layers.
- Ship the real behaviour, with its controls in validated config; avoid dry-run or propose-only
  phases. State the risk once in the spec and `docs/accepted-risks.md`.
- If a design needs something heavier, say why in one line and ask before building it.

## Every boundary rule lives in two places

A new kind of rule goes into `src/fleet-rules.ts`; if it guards a boundary, also into
`scripts/host_rules.py` with the same meaning and a case in `test/parity.test.ts`. Changing
`host_rules.py` or `scripts/reconcile.sh` is a host change: it takes effect only when your
infrastructure workflow installs them on the host.

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
