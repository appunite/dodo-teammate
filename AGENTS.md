# Repository guidance

## Purpose

This repository is the reviewed source of truth for MyAgent: every Hermes profile it runs as, the
instructions, skills, schedules, plugins, and credential names of each, and the contract that keeps
them safe. Its job is to make a Hermes Agent installation behave as MyAgent and to give the team a
normal Git review path for changing it.

- **MyAgent** is the team's AI teammate: a name, a Slack handle, and a set of profiles.
- **Hermes Agent** is the software that powers it. Hermes is not MyAgent's name or identity.
- **`myagent-admin`** is the owner's private console. Through it the owner operates MyAgent and
  drafts changes to this repository as pull requests; it never approves or deploys its own work.

## What belongs here

- the default Hermes profile and every named profile, with `SOUL.md`, `config.yaml`,
  `distribution.yaml`, `README.md`, and any plugins, cron jobs, and scripts it ships;
- `profiles/fleet.yaml`, the fleet manifest;
- skills in `shared/skills/`, selected per profile;
- `profiles/fleet.yaml`'s `policy`: everything project-specific the fleet contract checks;
- the fleet contract (`src/fleet-rules.ts`), its bundling for the host, the reconciler, and their
  tests;
- capability specs (`docs/capabilities/`) and the accepted-risk list (`docs/accepted-risks.md`);
- the *names* of the credentials each profile holds, never the values.

## What does not belong here

- credentials, OAuth state, sessions, memories, logs, caches, databases, or the selected model;
- a general event bus, scheduler, or workflow platform around Hermes;
- CI that can operate the agent;
- speculative abstractions added before a real capability needs them.

## Decision rule

Before adding something here, ask:

1. Is it a durable, non-secret definition or selection for a profile MyAgent runs as?
2. Is it validation, delivery, or reconciliation needed to apply that desired state safely?

If both answers are no, it probably does not belong here.

## Working on the fleet contract

- **Answer Hermes questions from source at the deployed release.** Upstream docs have been wrong or
  vague on exactly the safety-relevant details: which profile's config a multiplexed gateway reads,
  how allowlists and environment overrides combine, who may click an approval. Read the code at the
  release you run and cite file and line in the change. Confirm a module or config key exists in
  the Hermes build on the host before a plugin or script relies on it.
- **One validator, run twice.** `src/fleet-rules.ts` is the only implementation of the fleet
  contract. CI runs it (`mise run fleet`); the reconciler runs the same code on the host from a
  bundle (`mise run build-validator` writes `dist/validate-fleet.js` and its SHA-256) before it
  changes anything. `mise run fleet-bundle` checks the bundle is reproducible and accepts the
  checkout. The validator accepts exactly one fleet schema; to go back, revert and reinstall.
- **The validator and the reconciler know nothing about this project.** They hold only generic
  rules and Hermes facts: never a project's profile names, MCP URLs, tool lists, credential names,
  or paths. Everything project-specific lives in the `policy` block of `profiles/fleet.yaml`: the
  reviewed MCP servers with their tools, writes and writers, and restricted tools; every credential
  with the profiles that may hold it and where it may go; restricted paths; the timezone. A new
  capability changes the policy, not the validator; change the validator only for a new kind of
  rule, and keep it generic. The policy deploys with the profiles, so widening it is a reviewed
  change like any other in that file.
- **The validator bundle and the reconciler ship with the host, not with the release.** Your
  infrastructure installs both by hash, so a profile change can never rewrite the code that checks
  it; a change to either takes effect only when your infrastructure installs it.
- **Prompts are not boundaries.** `SOUL.md` and skills guide behaviour. The enforceable controls
  are the Slack allowlists, the gateway kind (`slack_outbound` has no ingress), per-surface
  toolsets, the policy's MCP servers and credentials, run limits, cron schedules
  and delivery targets, the exact `plugins.enabled`, and the hand-off code. Put a safety property
  in validated config, not only in prose.
- **Roles decide reach.** `owner`: one user, DM only, may keep memory, web, and a shell. `team`:
  allowlisted users and channels, no memory, no shell, no web or vision next to an MCP server,
  at most 25 turns. `scheduled`: `slack_outbound`, no ingress, the only role that ships cron jobs.
  `worker`: no gateway, reachable only through a typed hand-off, ships the worker guard.
- **Specialised work goes to a worker profile.** A capability that needs code execution, extra
  credentials, or a heavy skill is never added to the team profile. It becomes a worker profile, a
  typed `handoff_<name>` tool in the hand-off plugin, an entry in `workers.json`, the worker in
  the default profile's `kanban.dispatch_profiles`, and a capability spec.
- **Writes are bounded by the reviewed policy.** A tool that writes appears in a profile only when
  its server's `writes` in the policy lists it and its `writers` list the profile. No profile loads
  a delete tool, and the team profile never loads a server's `restricted` tools.
- **Accepted risks are stated once.** When a design relaxes a rule, write the risk and its controls
  in `docs/accepted-risks.md` and in the capability spec.

## Validation

```sh
mise run check
```

`mise run test` covers the contract in memory and through the validator CLI. Hermes reads YAML with
PyYAML (YAML 1.1), and so does the validator: write lists of URLs that contain `?` as block lists.
