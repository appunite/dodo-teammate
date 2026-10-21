# Dodo Teammate repository guidance

## Purpose

This repository is the reviewed source of truth for an AI teammate's infrastructure and recovery
baseline **and for the complete Hermes profile fleet the teammate runs as**. Its job is to make a
fresh or replacement Hermes Agent installation capable of continuing as the teammate, and to give
the team a normal Git review path for creating and evolving its profiles.

It is the template form of Dodo, the repository behind Derek (an AI teammate built for one client
team). The layout, the fleet schema, and the validator are Dodo's; everything specific to Derek, its
client, and its AWS host is removed.

The repository, the teammate, and Hermes are different things:

- **This repository** owns the source-controlled recovery seed and the teammate's complete Hermes
  profile catalog: profile definitions, fleet lifecycle metadata, per-profile skill selection,
  the teammate's own shared behaviour, delivery, reconciliation, and deterministic validation.
- **The teammate** (`MyAgent` until you run `scripts/rename-agent.sh`) is the name and handle of the
  team's AI agent. The deployed Hermes Agent instance, its runtime state, credentials, sessions,
  integrations, and behaviour collectively constitute the teammate.
- **Hermes / Hermes Agent** is the software that powers the teammate. Hermes is not the teammate's
  name, personality, or team identity.
- **`myagent-admin`** is the owner's private Hermes profile and the teammate's operator console:
  through it the owner works with the teammate on the quality and maintenance of this fleet.

Reach a working conversation with the teammate quickly, then build further capabilities with it.
Every durable profile addition or change is reviewed and merged here, after which the host reconciles
the fleet. Keeping the repository focused means avoiding a second runtime or general workflow
platform here; it does **not** mean limiting it to the starter profiles.

## What belongs here

- the infrastructure and narrowly scoped identities needed to run the teammate, in whatever tool
  your project uses (Dodo uses Pulumi on AWS; this template leaves that to you);
- the host bootstrap and the Hermes installation and recovery runbook;
- the special default Hermes profile and every named profile distribution the teammate uses;
- the fleet manifest (`profiles/fleet.yaml`), its `policy`, and the lifecycle rules for creating,
  updating, and eventually removing profiles;
- profile instructions, non-secret configuration, scripts, the teammate's own skills, and the Hermes
  plugins a profile ships (`profiles/<name>/plugins/`), with their unit tests in `tests/`;
- the teammate's own standard-library stdio MCP servers (`shared/mcp-servers/<name>/server.py`),
  with their unit tests in `tests/mcp-servers/`;
- the Hermes cron jobs a profile ships and the scripts they run, with the scripts' unit tests in
  `tests/scripts/`. Hermes schedules and runs them, and an operator activates each one; this
  repository only defines and validates them;
- the names of the credentials each profile holds (`runtime_env`) and of those a host broker mints
  for it (`brokered_env`), never the values;
- deterministic checks and an explicit deployment and recovery path for the declared fleet.

## What does not belong here

- a general event bus, scheduler, release platform, or permanent control plane around Hermes;
- source-repository CI that can operate the teammate;
- reusable team skills that belong in a shared skills repository rather than to this teammate;
- runtime credentials, OAuth state, sessions, memories, logs, caches, databases, or the chosen model;
- speculative abstractions added before a real use case needs them.

## Repository and authority boundaries

All Hermes profiles the teammate uses are defined here. Teammates with the appropriate repository
access may create or change them through ordinary pull requests, and authorized maintainers may
merge those changes. Reviewed `main` is the desired fleet state the host must reconcile. The
teammate may help prepare a change, but the live installation is not the durable authorship
surface, and the teammate never approves its own changes.

CI may validate the declared fleet. It must not become the execution engine for the work those
profiles perform.

## Decision rule

Before adding something here, ask:

1. Is it part of the infrastructure, identity, installation, or recovery baseline needed to run the
   teammate?
2. Is it a durable, non-secret definition or selection for a Hermes profile the host should import?
3. Is it validation, delivery, or reconciliation needed to apply that desired state?

If all three answers are no, it probably does not belong here.

## Working on the fleet contract

[Changing MyAgent](infra/docs/changing-myagent.md) maps each kind of change to the files to edit and
its release path; keep it current when a change alters either.

- **Answer Hermes questions from source at the deployed tag.** The fleet contract tracks a specific
  Hermes release (see [the profile deployment contract](infra/docs/deploy-profiles.md)). Upstream
  docs are useful orientation but have been wrong or vague on exactly the safety-relevant details:
  which profile's config a multiplexed gateway reads, how allowlists, pairing, and environment
  overrides combine, and who may click an approval. Read the code at the tag and cite file and line.
- **One validator, run twice.** `infra/src/validate-fleet.ts` is the only implementation of the
  fleet contract. CI runs it over the checkout (`mise run fleet`), and the reconciler runs the same
  code on the host over the extracted release, from a bundle (`mise run build-validator`) your
  infrastructure installs by hash next to the reconciler. `mise run fleet-bundle` checks that the
  bundle is reproducible and accepts the checkout. The validator accepts exactly one fleet schema:
  a schema change ships with the validator that reads it, so going back is a revert plus a reinstall
  of the previous bundle.
- **The validator and the reconciler know nothing about the teammate.** They hold only generic rules
  and Hermes facts: no profile names, capability numbers, MCP URLs or tool lists, credential names,
  plugin names, or client specifics. Everything they check that is specific to the teammate lives in
  the `policy` block of `profiles/fleet.yaml`: the owner console, personal-data and model-free
  profiles, repository write skills, the timezone, restricted paths, the hand-off plugin's contract,
  the worker guard, brokered credentials, every credential and where it may go, the reviewed MCP
  URLs with their tools, writers, and restricted tools, and the stdio servers. A new capability
  changes the policy, not the validator. The policy deploys with the profiles, so widening it is a
  reviewed change like any other in that file. A script's own configuration is checked by its unit
  tests.
- **The validator and the reconciler ship through your infrastructure, not through the profile
  deployment.** Install both by hash; until then the previous ones validate new profiles and
  normally reject them. A profile change can never change the code that checks it.
- **Root never trusts what `hermes` owns.** In the bootstrap and the reconciler, run Python as root
  only with `/usr/bin/python3 -I` (the Hermes venv only through `run_as_hermes`), and never follow a
  path inside `/var/lib/hermes` as root (copy or write there as `hermes`, or create without
  dereferencing).
- **Toolset names are release-specific.** Re-check `configurableToolsets`, `knownLeafToolsets`, the
  reserved MCP server names, and `bundledPluginToolsets` against the Hermes release before moving to
  it, by updating the validator from Dodo (see below).
- **Code runs only where nobody but the owner can message the profile.** `terminal`, `file`, and
  `code_execution` run on the host as `hermes`, with `terminal.backend: local` stated in the
  profile's `config.yaml`. They are refused on every surface of a `gateway: slack` profile except the
  policy's owner console, which must stay single-user; a Kanban worker or a scheduled profile may
  select them. There is no container: such a terminal can read every profile's `.env`, an accepted
  risk. "Nobody can message" means no Slack ingress only: the Hermes dashboard chats with every
  profile and runs `!command` as `hermes`, so its administrators stay owners only.
- **Specialised work goes to a worker profile.** A capability that needs code execution, extra
  credentials, or a heavy skill is never added to `myagent-slack`. It becomes a `kanban_worker`
  profile, a typed `handoff_<name>` tool in the policy's hand-off plugin, an entry in the plugin's
  `workers.json`, the worker in the default profile's `kanban.dispatch_profiles`, and a capability
  spec. No profile selects the raw `kanban` toolset. A worker selects nothing but `skills`, `todo`,
  `file`, `terminal`, `code_execution`, and its own MCP servers, and ships the policy's worker guard,
  which keeps it on its own task. Every worker ships the same guard files.
- **Every profile loads only reviewed MCP tools.** Every remote server's exact URL is in the policy's
  `mcp_servers` with every tool a profile may load from it; every stdio server is in
  `stdio_servers`. Every header carries a credential the policy's `credentials` pins to that profile,
  URL, and authorization scheme. A profile teammates can message never loads a server's `restricted`
  tools. A skill that makes a write reports the exact change afterwards.
- **Writes are bounded by the reviewed policy, not by skills.** No profile includes a `delete_*`
  tool. A server's `writes` load only in the profiles its `writers` lists. A capability that only
  reads uses a read-only URL with a read-only key. Changing what a profile can write is a reviewed
  change to the policy, never to a skill. A profile in `personal_data_profiles` delivers only to DMs
  and selects no toolset but `skills`, `todo`, and its own MCP servers.
- **Prompts are not boundaries.** SOUL and skill text guide behaviour; the enforceable controls are
  the Slack allowlists, the gateway kind (`slack_outbound` has no ingress), per-surface toolsets, MCP
  tool allowlists, pinned credentials, which profiles may run code, approval mode, turn caps, cron
  schedules and delivery targets, the exact `plugins.enabled`, the hand-off code that builds every
  task, the guard that keeps a worker on its task, and the credentials a profile and its scripts can
  reach. Put a safety property in validated config rather than only in prose.

## Staying in line with Dodo

`infra/src/validate-fleet.ts`, `fleet-contract.ts`, `fleet-validator.ts`, and
`check-fleet-validator.ts` are copied verbatim from Dodo (HaverAnalytics/dodo, Derek's repository)
and must not be edited here. To pick up a newer contract, copy those files from a newer Dodo
revision, then adapt `profiles/fleet.yaml` and the profiles until `mise run check` passes. A rule this
template needs that Dodo does not have belongs in Dodo first, written generically.

## Validation

Run the repository-owned deterministic checks:

```shell
mise run check
```

Live host changes require explicit task-specific authorization. Documentation and scripts must
describe generic authorized credentials, never an operator's workstation configuration.
