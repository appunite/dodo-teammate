# Teammate template

A starting point for giving a project its own AI teammate: an agent that lives in the team's Slack,
reads the systems the team works in, runs reviewed schedules, hands heavier jobs to specialised
workers, and changes only through pull requests to this repository.

It is the common skeleton of a working agent (Derek, built for one client team), with the
client-specific integrations, IDs, and cloud infrastructure removed. It runs on
[Hermes Agent](https://hermes-agent.nousresearch.com/), an open-source agent runtime.

## Three names, three jobs

| Name | What it is |
|---|---|
| **The agent** (`myagent`, `MyAgent` until you rename it) | The teammate: a name, a Slack handle, a voice, and a fixed list of what it may read and write. |
| **Hermes Agent** | The runtime that powers it: profiles, the Slack gateway, cron, skills, MCP servers, plugins, and the Kanban board workers take tasks from. Replaceable plumbing; never the agent's name. |
| **This repository** | The source of truth for everything durable about the agent: every profile, instruction, skill, schedule, plugin, and credential *name*, plus the rules that keep them safe. |

Keeping identity apart from runtime means you can change the model or the runtime without losing
the teammate.

## Principles

1. **Prompts are not boundaries.** Instructions guide behaviour; validated configuration decides
   what is possible. Every property you rely on (who can reach a profile, which tools it loads,
   which credentials it holds, how many turns it gets) lives in config that
   [`src/fleet-rules.ts`](src/fleet-rules.ts) checks.
2. **Authority belongs to a profile, never to a prompt.** A Hermes profile has its own tools,
   credentials, memory, and reach. A capability that needs more than its profile allows gets a new
   profile, not a longer prompt.
3. **Separate ingress from authority.** What teammates can talk to holds read-only keys, plus
   writes listed one by one in `reviewed_writes`. What writes on its own runs from a schedule or a
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
7. **Every rule is enforced twice.** CI runs the contract in TypeScript; the host re-checks the
   boundary rules in Python ([`scripts/host_rules.py`](scripts/host_rules.py)) before it changes
   anything, and [`test/parity.test.ts`](test/parity.test.ts) proves both refuse the same broken
   fleets.
8. **Accepted risks are written down.** Safety is a list of decisions with an owner and a reason.
   Start [`docs/accepted-risks.md`](docs/accepted-risks.md) on day one.

## What's in the box

| Path | What it does |
|---|---|
| [`profiles/fleet.yaml`](profiles/fleet.yaml) | The fleet: every profile, its role, reach, toolsets per surface, MCP servers with exact tool lists, plugins, credential names, schedules, and skills. |
| [`profiles/default/`](profiles/default/README.md) | Hermes's launch profile: host-wide Slack policy and the Kanban dispatcher. |
| [`profiles/myagent-admin/`](profiles/myagent-admin/README.md) | The owner's private console (role `owner`): DM-only, one user, memory, web, and a terminal. |
| [`profiles/myagent-slack/`](profiles/myagent-slack/README.md) | The team's front door (role `team`): allowlisted people and channels, read tools, one reviewed write, typed hand-offs. |
| [`profiles/myagent-scheduled/`](profiles/myagent-scheduled/README.md) | Reviewed schedules with no Slack ingress (role `scheduled`), with a no-model daily-update reminder. |
| [`profiles/myagent-writer/`](profiles/myagent-writer/README.md) | An example Kanban worker (role `worker`) that turns a thread into a Markdown document. |
| `shared/skills/` | Skills, selected per profile: `untrusted-input`, `evidence-and-provenance`, `authority-boundaries`, a capabilities map, and the change workflow. |
| [`src/fleet-rules.ts`](src/fleet-rules.ts) | The fleet contract, run in CI by [`src/validate-fleet.ts`](src/validate-fleet.ts). |
| [`scripts/host_rules.py`](scripts/host_rules.py) | The boundary rules again, for the host. |
| [`scripts/reconcile.sh`](scripts/reconcile.sh) | A host reconciler skeleton: verify the revision, re-validate, snapshot, install, reapply owned config, roll back on failure. Host-specific parts are marked TODO. |
| [`docs/capabilities/`](docs/capabilities/TEMPLATE.md) | The capability spec template and a worked example. |
| `.claude/skills/` | Claude Code skills for building a capability and deploying it. |

## Three kinds of state

| Kind | Examples | Source of truth | How it changes |
|---|---|---|---|
| **Fleet** | Profiles, instructions, toolsets, allowlists, skills, schedules, plugins, credential names | This repository | Pull request, merge, reconcile |
| **Host** | The machine, its identity, the reconciler and `host_rules.py`, the deployment trigger | Your infrastructure code | Your infrastructure workflow |
| **Runtime** | Model and provider, credential values, sessions, memory, whether a job is paused | The host only, never Git | Hermes dashboard or a host shell |

Anything the reconciler owns is overwritten on the next deployment, so fixing fleet state on the
host is never durable.

## Quickstart

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
3. Provision a small always-on host, install Hermes Agent, and wire your merge to run
   `scripts/reconcile.sh <sha>` there (fill in its TODOs).
4. Set runtime values on the host: the model provider and key, the Slack tokens, and every name in
   `runtime_env`. Use service tokens with the narrowest scopes, never your own login.
5. Write your accepted risks down, deploy, resume the scheduled jobs you want, and test in Slack.

`myagent-scheduled`'s reminder ships in `MODE = "dry-run"` only because its IDs are placeholders.
Once they are real, switch it to `live` in a pull request; capabilities ship live, with their
controls in validated config, not in dry-run phases.

## How to add a capability

1. Write the spec from [`docs/capabilities/TEMPLATE.md`](docs/capabilities/TEMPLATE.md): trigger,
   profile, tools, credentials, rules, abuse analysis, accepted risks, rollout, verification.
2. Decide where it runs. Read-only answers go on the team profile. Anything needing code
   execution, extra credentials, or a heavy skill becomes a worker behind a typed hand-off (see
   [`profiles/myagent-slack/README.md`](profiles/myagent-slack/README.md)). Anything on a clock
   goes to the scheduled profile, as a script when no judgement is needed.
3. Edit `profiles/fleet.yaml` and the profile's `config.yaml` identically; add a write tool to
   `reviewed_writes` only with its accepted risk; bump the profile's `distribution.yaml` version.
4. Add a line to the `myagent-capabilities` skill so the agent can tell people about it.
5. If the capability needs a new kind of rule, add it to `src/fleet-rules.ts` and, if it guards a
   boundary, to `scripts/host_rules.py` and `test/parity.test.ts`.
6. Run `mise run check` and open a pull request that names every runtime step (keys to set, jobs
   to resume) and how to test it in Slack.

The Claude Code skill in `.claude/skills/building-myagent-capability/` walks through the same steps.
