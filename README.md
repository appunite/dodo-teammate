# 🦤 Dodo Teammate

[![Reconstruction of a dodo](https://upload.wikimedia.org/wikipedia/commons/thumb/a/a3/Reconstruction_of_a_dodo.jpg/960px-Reconstruction_of_a_dodo.jpg)](https://commons.wikimedia.org/wiki/File:Reconstruction_of_a_dodo.jpg)

_Photo by [Vera de Kok](https://commons.wikimedia.org/wiki/User:1Veertje), licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)._

> The **dodo** (*Raphus cucullatus*) is an extinct flightless bird that was endemic to Mauritius.
> This one is alive, lives in your Slack, and only changes through pull requests. 🦤

A starting point for giving a project its own AI teammate: an agent that lives in the team's Slack,
reads the systems the team works in, runs reviewed schedules, hands heavier jobs to specialised
workers, and changes only through pull requests to this repository.

Dodo Teammate is Dodo, the repository behind a working agent (Derek, built for one client team), with
the client-specific integrations, IDs, and cloud infrastructure removed: the same layout, the same
fleet schema, and the same validator, copied verbatim. It runs on
[Hermes Agent](https://hermes-agent.nousresearch.com/), an open-source agent runtime.

## 🪪 Three names, three jobs

| Name | What it is |
|---|---|
| **The agent** (`myagent`, `MyAgent` until you rename it) | The teammate: a name, a Slack handle, a voice, and a fixed list of what it may read and write. |
| **Hermes Agent** | The runtime that powers it: profiles, the Slack gateway, cron, skills, MCP servers, plugins, and the Kanban board workers take tasks from. Replaceable plumbing; never the agent's name. |
| **This repository** | The source of truth for everything durable about the agent: every profile, instruction, skill, schedule, plugin, and credential *name*, plus the rules that keep them safe. |

Keeping identity apart from runtime means you can change the model or the runtime without losing
the teammate.

## 🛡️ Principles

1. **Prompts are not boundaries.** Instructions guide behaviour; validated configuration decides
   what is possible. Every property you rely on (who can reach a profile, which tools it loads,
   which credentials it holds, how many turns it gets) lives in config that
   [`infra/src/validate-fleet.ts`](infra/src/validate-fleet.ts) checks.
2. **Authority belongs to a profile, never to a prompt.** A Hermes profile has its own tools,
   credentials, memory, and reach. A capability that needs more than its profile allows gets a new
   profile, not a longer prompt.
3. **Separate ingress from authority.** What teammates can talk to holds read-only keys, plus
   writes the fleet policy lists one by one. What writes on its own runs from a schedule or a
   typed hand-off, where nobody can talk to it.
4. **Never private data, untrusted text, and a way out on one surface.** A surface that reads
   private data through an MCP server never also selects `web`, `vision`, `browser`, or (where
   people can message it) a shell, and Slack link unfurling stays off. The owner-only console is
   the one stated exception.
5. **Scripts first, model second.** Fetching, diffing, and counting belong in reviewed scripts
   (`no_agent` cron jobs). A script spends no tokens and cannot be prompt-injected.
6. **Code builds the hand-off, not the model.** The team profile never gets Hermes's raw Kanban
   tools. A typed hand-off tool takes a few validated arguments; reviewed code picks the worker,
   the limits, the task text, and the Slack thread that hears back. A guard keeps each worker on
   its own task.
7. **One generic validator, run twice.** CI runs the fleet contract
   ([`infra/src/validate-fleet.ts`](infra/src/validate-fleet.ts)); the host runs the same code, from a
   bundle your infrastructure installs by hash, before it changes anything. The validator and the reconciler
   never name your project's URLs, tools, or credentials: everything project-specific lives in the
   `policy` block of [`profiles/fleet.yaml`](profiles/fleet.yaml), reviewed with the profiles.
8. **Accepted risks are written down.** Safety is a list of decisions with an owner and a reason.
   Start [`docs/myagent-capabilities/accepted-risks.md`](docs/myagent-capabilities/accepted-risks.md) on day one.

## 📦 What's in the box

The layout is Dodo's, file for file where it applies.

| Path | What it does |
|---|---|
| [`AGENTS.md`](AGENTS.md) | The repository rules: what belongs here, the fleet contract, and staying in line with Dodo. |
| [`profiles/fleet.yaml`](profiles/fleet.yaml) | The fleet (schema 6): every profile, its reach, toolsets per surface, MCP servers with exact tool lists, plugins, credential names, schedules, and skills, plus the `policy`: the owner console, reviewed MCP servers and tools, where each credential may go, the hand-off contract, the timezone. |
| [`profiles/default/`](profiles/default/README.md) | Hermes's launch profile: host-wide Slack policy and the Kanban dispatcher. |
| [`profiles/myagent-admin/`](profiles/myagent-admin/README.md) | The owner's private console: DM-only, one user, memory, web, and a terminal. |
| [`profiles/myagent-slack/`](profiles/myagent-slack/README.md) | The team's front door: allowlisted people and channels, read tools, one reviewed write, typed hand-offs. |
| [`profiles/myagent-scheduled/`](profiles/myagent-scheduled/README.md) | Reviewed schedules with no Slack ingress, with a no-model daily-update reminder. |
| [`profiles/myagent-writer/`](profiles/myagent-writer/README.md) | An example Kanban worker that turns a thread into a Markdown document. |
| `shared/skills/` | The agent's own skills, selected per profile in `dodo_skills`. |
| [`infra/src/`](infra/src/validate-fleet.ts) | The generic fleet validator and its host bundle, byte for byte Dodo's. |
| [`infra/test/`](infra/test/validate-fleet.test.ts) | The validator run against copies of this fleet that each break one rule. |
| [`infra/assets/reconcile-profiles.sh`](infra/assets/reconcile-profiles.sh) | The host reconciler, Dodo's minus its AWS and GitHub App specifics (marked TODO). |
| [`infra/docs/`](infra/docs/changing-myagent.md) | How to change MyAgent, the deployment contract, and the install runbook. |
| [`docs/myagent-capabilities/`](docs/myagent-capabilities/README.md) | Principles, the fleet map, accepted risks, and one spec per capability. |
| `tests/` | Unit tests for the plugins, scripts, skills, and MCP servers. |
| `.claude/skills/` | Claude Code skills for building a capability and deploying it. |

## 🗂️ Three kinds of state

| Kind | Examples | Source of truth | How it changes |
|---|---|---|---|
| **Fleet** | Profiles, instructions, toolsets, allowlists, skills, schedules, plugins, credential names | This repository | Pull request, merge, reconcile |
| **Infrastructure** | The machine, its identity, the reconciler and the validator bundle, the deployment trigger | Your infrastructure code | Your infrastructure workflow |
| **Runtime** | Model and provider, credential values, sessions, memory, whether a job is paused | The host only, never Git | Hermes dashboard or a host shell |

Anything the reconciler owns is overwritten on the next deployment, so fixing fleet state on the
host is never durable.

## 🚀 Quickstart

```sh
mise install
mise run setup
scripts/rename-agent.sh <name>   # once: replaces myagent / MyAgent / MYAGENT, renames paths
mise run check
```

Then, before the first deployment:

1. Replace the placeholder IDs: `U000OWNER` (the owner's Slack user ID), `U000TEAM01`/`U000TEAM02`
   (the team allowlist), `C000TEAM01` (allowed channels), `D000OWNERDM` (the owner's DM with the
   team app), and `example-org` (your Sentry organisation). Swap the example Linear and Sentry
   servers for the systems your team uses.
2. Create two Slack apps: the team app (used by `myagent-slack`, and by `myagent-scheduled` with
   its bot token only) and the admin app (`myagent-admin`).
3. Provision a small always-on host and install Hermes Agent
   ([runbook](infra/docs/install-hermes.md)). Wire your merge to run
   `infra/assets/reconcile-profiles.sh <sha> <validator bundle>` there, with the reconciler and the
   bundle (`mise run build-validator`) installed by hash; fill in its placeholders and TODOs
   ([deployment](infra/docs/deploy-profiles.md#normal-deployment)).
4. Set runtime values on the host: the model provider and key, the Slack tokens, and every name in
   `runtime_env`. Use service tokens with the narrowest scopes, never your own login.
5. Write your accepted risks down, deploy, resume the scheduled jobs you want, and test in Slack.

`myagent-scheduled`'s reminder ships in `MODE = "dry-run"` only because its IDs are placeholders.
Once they are real, switch it to `live` in a pull request; capabilities ship live, with their
controls in validated config, not in dry-run phases.

## 🧩 How to add a capability

1. Write the spec from
   [`docs/myagent-capabilities/capabilities/TEMPLATE.md`](docs/myagent-capabilities/capabilities/TEMPLATE.md): trigger,
   profile, tools, credentials, rules, abuse analysis, accepted risks, rollout, verification.
2. Decide where it runs. Read-only answers go on the team profile. Anything needing code
   execution, extra credentials, or a heavy skill becomes a worker behind a typed hand-off (see
   [`profiles/myagent-slack/README.md`](profiles/myagent-slack/README.md)). Anything on a clock
   goes to the scheduled profile, as a script when no judgement is needed.
3. Edit `profiles/fleet.yaml` and the profile's `config.yaml` identically. Add the capability's
   MCP servers, tools, writes and writers, and credentials to the fleet `policy` (a write only with
   its accepted risk); bump the profile's `distribution.yaml` version.
4. Add a line to the `myagent-capabilities` skill so the agent can tell people about it.
5. Never edit the validator here: it is Dodo's. If the capability needs a new kind of rule, land it
   in Dodo, generically, then copy the newer validator ([staying in line](AGENTS.md#staying-in-line-with-dodo)).
6. Run `mise run check` and open a pull request that names every runtime step (keys to set, jobs
   to resume) and how to test it in Slack.

The Claude Code skill in `.claude/skills/building-myagent-capability/` walks through the same steps.
