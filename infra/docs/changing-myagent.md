# Changing MyAgent

Where to make a change to MyAgent, how it reaches the running agent, and how to confirm it worked.
The detailed contracts live in [the profile deployment contract](deploy-profiles.md) and
[the installation runbook](install-hermes.md); this page routes you to them.

## Three kinds of state

| Kind | Examples | Source of truth | How it changes |
| --- | --- | --- | --- |
| **Fleet** | profiles, SOULs, toolsets, skill selections, Slack allowlists and caps, slash-command admins, the names of each profile's credentials, scheduled job definitions and their scripts, plugins, Kanban workers and the dispatcher allowlist, and the fleet `policy` (reviewed MCP URLs and tools, where each credential may go, stdio servers, profiles with special standing) | `main` | pull request → merge → [deployment](#release-paths) |
| **Infrastructure** | the host, its identity, the reconciler, the fleet validator bundle, and whatever runs them; the pinned `bun` | your infrastructure code (Dodo: a Pulumi program in `infra/`) | pull request → merge → apply |
| **Runtime** | model and provider, model keys, credential and Slack token values, the gateway service, whether a scheduled job is active, sessions, memory | the host only, never Git | Hermes dashboard, or a host shell when the dashboard cannot |

Anything the reconciler owns is overwritten on the next deployment. Fixing fleet state on the host
is therefore never durable: make the change here.

## Release paths

**A. Fleet change** (anything under `profiles/`, `shared/skills/`, or `shared/mcp-servers/`,
including the `policy` block of `profiles/fleet.yaml`):

1. Open a pull request; `mise run check` must pass locally and in CI.
2. Merge. Your deployment runs the reconciler with the merged revision.
3. Confirm the run succeeded; its last line is `Reconciled default … at <sha> with shared skills …`.

**B. Validator, reconciler, or infrastructure change** (`infra/assets/`, `infra/src/`):

1. Pull request and merge as above. If the validator or the reconciler changed, the next deployment
   still runs the previous ones and will normally fail without changing anything; that is expected.
2. Install the new reconciler and validator bundle (`mise run build-validator`) on the host through
   your infrastructure, by hash, from a freshly pulled `main`.
3. Run the deployment again and confirm it succeeded.

**C. Runtime change**: use the Hermes dashboard, then run the deployment once so the host checks
confirm nothing bypasses the reviewed policy.

Reconcile only through your deployment, never by running the reconciler by hand. To undo a fleet
change, revert it on `main`.

## I want to…

| Change | Edit | Path | Notes |
| --- | --- | --- | --- |
| Change how a profile behaves or speaks | `profiles/<profile>/SOUL.md`; bump `version` in its `distribution.yaml` | A | Prompts guide behaviour; they are not a security boundary |
| Let a teammate use MyAgent on Slack | `profiles/myagent-slack/config.yaml`: the same Slack user ID (`U…`) in `slack.allow_from` (DMs) and `slack.group_allow_from` (channels); bump `version` | A | `myagent-admin` must stay single-user, because it keeps memory |
| Let MyAgent answer in another channel | `profiles/myagent-slack/config.yaml`: the channel ID (`C…`) in `slack.allowed_channels`; bump `version`; invite the team app to the channel | A, then C | MyAgent ignores mentions in any channel not listed. Never set `SLACK_ALLOWED_CHANNELS` in a `.env` |
| Make someone a slash-command admin | `profiles/default/config.yaml`: `slack.allow_admin_from`, `slack.group_allow_admin_from` | A | Admins can run `/model`, `/yolo`, and every other command |
| Change run limits | profile `config.yaml`: `agent.max_turns` (≤ 50, ≤ 25 on a Slack gateway more than one person can reach), `agent.run_budget_seconds` (≤ 900; required on Slack gateways); `profiles/default/config.yaml`: `max_concurrent_sessions` (≤ 8) | A | The turn cap is the hard per-run stop; the time budget is advisory |
| Add a skill of MyAgent's own | `shared/skills/<name>/SKILL.md`, then select it in `dodo_skills` | A | A skill in `policy.repository_write_skills` is refused on any Slack profile but the owner console |
| Change what MyAgent tells people it can do | `shared/skills/myagent-capabilities/SKILL.md`; bump the selecting profiles' `version` | A | `mise run skills` fails when a fleet profile or job is missing from it |
| Change a profile's tools | `profiles/fleet.yaml` `platform_toolsets` **and** the profile's `config.yaml` (both, identical), plus `agent.disabled_toolsets` listing every unselected built-in toolset (a Kanban worker keeps `kanban` out of it) | A | Every surface lists its MCP servers or `no_mcp`; validation explains any mismatch |
| Connect a remote MCP server | `policy.mcp_servers` (its exact URL and reviewed `tools`, `writes` with their `writers`, any `restricted` tools); the server under the profile's `mcp_servers` in `fleet.yaml` and `config.yaml`; its credential in `policy.credentials` (`header`, `urls`) and the profile's `runtime_env` | A, then C for the key value | Use a scoped service key, never an interactive OAuth grant, and record its owner, scopes, and rotation in the pull request |
| Give a profile a credential for a script | `policy.credentials` with `script: true` (and `copy_of` for a Slack token copy); the profile's `runtime_env` and `terminal.env_passthrough` | A, then C | A script credential never travels as an MCP header |
| Add a stdio MCP server | `policy.stdio_servers`; a server of MyAgent's own in `shared/mcp-servers/<name>/server.py` (standard library only) with tests in `tests/mcp-servers/` | A (B for a new root-owned wrapper your infrastructure installs) | |
| Add a Kanban worker | a `kanban_worker` profile shipping `policy.worker_guard`; a `handoff_<name>` tool in the hand-off plugin and its `workers.json`; the worker in `kanban.dispatch_profiles` | A | See [plugins and Kanban workers](deploy-profiles.md#plugins-and-kanban-workers) |
| Add a scheduled job | the job in the profile's `cron/jobs.json` and `cron` list, its script in `scripts/`, delivery targets in `delivery_targets` | A, then C to resume | New jobs arrive paused until an operator resumes them |
| Change the fleet policy | the `policy` block of `profiles/fleet.yaml` | A | Widening it is a reviewed change like any other; keep the validator generic |
| Change how deployments reconcile | `infra/assets/reconcile-profiles.sh` for host steps, the validator only by copying a newer Dodo version | B | Both stay generic: no profile names, URLs, tools, or credential names |
| Update Hermes | [Operate and update](install-hermes.md#operate-and-update) | C, then deploy | Re-check the toolset lists against the new release first |

## When something fails

| Symptom | Meaning | Fix |
| --- | --- | --- |
| A validation error after a merge | The host still runs the previous validator or reconciler | Path B: install the new ones, then deploy |
| `The root-owned bun is missing …` or `The fleet validator bundle is missing …` | The host bootstrap has not installed the pinned `bun`, or the deployment did not pass the bundle; nothing was changed | Fix the bootstrap or the deployment, then deploy |
| `Host runtime state would bypass the reviewed Slack access policy` | Runtime settings (an extra `SLACK_*` key, a pairing grant, a nested Slack block) override the reviewed policy | Remove what the log lists in the dashboard, then deploy |
| `Host runtime credentials do not match the reviewed fleet` | A `.env` holds an undeclared credential or a line that is not plain `KEY=value`, a declared one is unset, or a file mode or secret source is wrong | Fix what the log lists, then deploy |
| `Host cron or run-limit state does not match the reviewed fleet` | A job is active on the host but not declared, or a setting overrides the reviewed timezone or turn cap | Pause or remove the job, or remove the setting, then deploy |
