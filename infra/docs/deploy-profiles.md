# Deploying profiles and shared skills

Reviewed `main` is the source of truth for every Hermes profile MyAgent uses and for each
profile's skill selection. Authorized contributors create or change profiles through normal pull
requests; after merge, the host reconciles the declared fleet. This is Dodo's deployment contract
(Derek's repository) with the parts that depend on Derek's AWS host left to you, marked TODO.

## Selection model

`profiles/fleet.yaml` declares the special Hermes default profile, every named distribution, each
active surface's positive toolset list, the [MCP servers](#mcp-servers) each surface may reach and
their exact tool allowlists, terminal home policy and [backend](#code-execution), whether the
profile owns a Slack gateway or posts to Slack without one, the names of the
[runtime credentials](#runtime-credentials) it holds and of the brokered credentials the host writes
for it (`brokered_env`), the ids of the [scheduled jobs](#scheduled-jobs) it ships (`cron`) and the
Slack targets they may deliver to (`delivery_targets`), the [plugins](#plugins-and-kanban-workers)
it ships and whether it is a Kanban worker (`plugins`, `kanban_worker`), and the selected skills:
the agent's own (`dodo_skills`, from `shared/skills/`), a shared skills repository's
(`raven_skills`), and Hermes's bundled ones (`hermes_skills`). The top level records
`owner_slack_id` and the [fleet policy](#fleet-policy). All fleet keys use `snake_case`. No skill
catalog is enabled implicitly.

Hermes stores the default profile directly at `/var/lib/hermes/.hermes`; it cannot be installed,
renamed, or deleted like a named distribution. The repository represents it under
`profiles/default`, and the reconciler atomically reconciles its reviewed `SOUL.md` plus the
supported non-secret configuration fields, including the host-wide Slack policy. Its model,
provider, authentication, memories, sessions, logs, and all other runtime-owned state remain local.

Only declared skill directories are projected beneath
`/var/lib/hermes/.dodo-deployment/{dodo,raven,hermes}-skills/<profile>`, where Hermes loads them
read-only. Every profile carries `.no-bundled-skills`, and its profile-local `skills` directory is
root-owned and non-writable by the `hermes` account, so `skill_manage` cannot change what a profile
knows. The `.dodo-deployment` path is fixed by the validator, which is shared with Dodo.

## Fleet policy

`infra/src/validate-fleet.ts` is the one implementation of the fleet contract, copied verbatim from
Dodo. CI runs it over the checkout (`mise run fleet`), and the reconciler runs the same code on the
host over the release it is about to deploy. Its rules are generic: it names no profile, MCP URL,
tool, credential, or plugin. Everything specific to MyAgent that those rules check against is the
`policy` block at the top of `profiles/fleet.yaml`:

| Key | What it holds |
| --- | --- |
| `owner_console` | The owner's DM-only profile (`myagent-admin`), the one Slack profile that may keep egress and code tools next to its MCP servers, load `restricted` tools, and select a repository write skill, while its only allowed user is `owner_slack_id` |
| `personal_data_profiles` | Profiles whose runs read client personal data: DM-only delivery, nothing but `skills`, `todo`, and their own MCP servers |
| `model_free_profiles` | Profiles that run no model: only `no_agent` jobs, every surface `no_mcp` |
| `repository_write_skills` | Skills that give a profile a write identity on GitHub |
| `timezone` | The IANA timezone of every profile that ships jobs, and of the default profile |
| `restricted_paths` | Paths only the listed files may name, such as where a write key lives |
| `handoff` | The [hand-off plugin](#plugins-and-kanban-workers), its profile, own tools, hooks, and `bot_mention_patterns` |
| `worker_guard` | The hook plugin every Kanban worker ships |
| `brokered_credentials` | Credentials a root-owned broker on the host mints (none in the starter fleet) |
| `credentials` | Every [runtime credential](#runtime-credentials), the profiles that may hold it, and where it may go |
| `mcp_servers` | Every remote [MCP server](#mcp-servers) by exact URL, with its `tools`, `writes` and their `writers`, and `restricted` tools |
| `stdio_servers` | Every stdio server: root-owned wrappers by `command`, and the agent's own servers in `shared/mcp-servers/` |

The policy deploys with the profiles (release path A), so widening it is a reviewed change like any
other in that file; only a change to the validator itself is a host change. The validator reads
`profiles/fleet.yaml` as YAML 1.1, as Hermes and PyYAML do. PyYAML cannot parse a URL that contains
`?` inside a flow list (`[...]`), so such lists are block lists. The validator accepts exactly one
fleet schema, today 6.

## Normal deployment

TODO: your deployment. Dodo's: a merge to `main` runs a CI workflow that gets a 15-minute cloud
session through OIDC, finds the one host, and runs a fixed command document on it with the exact
commit SHA. Whatever you use, it must:

1. pass the exact merged commit SHA, never a branch name;
2. run the reconciler and the validator bundle your infrastructure installed by hash (or download
   both and check their SHA-256s before running), never ones taken from the release;
3. run `infra/assets/reconcile-profiles.sh <sha> <validator bundle>` as root on the host;
4. keep the run's log where you can read it.

The reconciler is templated before your infrastructure installs it:

| Placeholder | Value |
| --- | --- |
| `__AGENT_REPOSITORY_URL__` | The clone URL of this repository, for a read-only mirror on the host |
| `__AGENT_ALLOWED_REFS__` | Space-separated refs a deployable revision must be reachable from, such as `refs/heads/main` |
| `__AGENT_BUN_PATH__` | A root-owned `bun`, pinned by version and SHA-256, that your host bootstrap installs |
| `__AGENT_SKILLS_REPOSITORY_URL__` | Optional: a shared skills repository for `raven_skills`; leave empty to disable |

`mise run build-validator` writes `infra/dist/validate-fleet.js` and its SHA-256. The bundle is
reproducible, so an unchanged validator keeps its hash; `mise run fleet-bundle`, part of
`mise run check`, builds it twice, checks that the two match, and runs it over the checkout the way
the host does. Before changing anything, the reconciler's `validate_release` runs the bundle over
the extracted release as root, from an empty directory with a minimal environment and
`--no-install --no-env-file`, so no `.env`, `bunfig.toml`, or auto-install changes what runs.

The host then verifies that the revision is reachable from an allowed ref, checks runtime state (see
below), projects the selected skills, installs or updates every named profile, reconciles the
default profile, reapplies the repository-owned config fields (Hermes keeps an existing profile's
config on update), reports each declared cron job's state, and asks the gateway to reload plugins.
Profile updates preserve model, provider, authentication, memories, sessions, and other
runtime-owned state. A failure restores the previous release and skill views.

TODO: git access for the mirror. Give the host read access to this repository without storing a
credential in the `hermes`-owned tree, for example a read-only deploy key in a root-owned file, or a
short-lived token narrowed to the repository (Dodo mints one from a GitHub App on every run and
revokes it on exit).

### Runtime checks

Runtime state can widen access past the reviewed config. Before changing anything, the reconciler
refuses a run and lists the offending key or file, never a value, when it finds:

- a `SLACK_*` key other than the two tokens and the home channel, or a `GATEWAY_ALLOW*` key, in a
  profile's `.env`; a nested `platforms.slack` block or `profile_routes` in its `config.yaml`; an
  approved pairing grant;
- `SLACK_APP_TOKEN` in a profile that does not declare `gateway: slack`, or a script copy (a policy
  credential with `copy_of`) that differs from the key it copies;
- a credential in `.env` the profile's `runtime_env` does not declare (other than model-provider
  keys and the Slack tokens), or a declared one that is unset; a `.env` that is not mode `600` and
  owned by `hermes`; an external secret source or an MCP OAuth grant;
- an active cron job the fleet does not declare, or a setting that overrides the reviewed timezone
  or turn cap.

## Slack gateway profiles

A named profile becomes reachable from Slack only when the fleet declares `gateway: slack` for it.
Each such profile owns exactly one Slack app, and that app's tokens live only in the profile's
runtime `.env`. Trust is separated by Slack app: the team app and the owner's app are different
apps bound to different profiles.

- `slack.allow_from` (DMs) and optional `slack.group_allow_from` (channels) are reviewed lists of
  Slack user IDs. Everyone else gets no reply, no reaction, no pairing prompt.
- A profile without `group_allow_from` is DM-only and sets `slack.allowed_channels: [C0000000000]`,
  a channel that does not exist, so channel events are dropped. A channel-facing profile lists the
  real channels it answers in.
- `slack.allow_bots: none` and `slack.require_mention: true` are mandatory, except on the hand-off
  profile while its plugin declares `pre_gateway_dispatch`: it then accepts bot posts matching
  exactly `policy.handoff.bot_mention_patterns`.
- A profile that names MCP servers on Slack switches link unfurling off.
- `gateway: slack_outbound` holds only the bot token: Hermes delivers its cron output but cannot
  open Socket Mode for it, so nobody can message it.

## Runtime credentials

A profile declares the names of the credentials it holds in `runtime_env`; values are set in the
Hermes dashboard (profile switcher → **API Keys**) and never enter Git. Every name must be listed in
`policy.credentials` with the profiles that may hold it, and:

- a **header** credential travels only as its server's one header, `Authorization: <header>
  ${NAME}`, to the listed URLs, and some server must send it;
- a **script** credential reaches only scripts, through `terminal.env_passthrough`; `copy_of` names
  the gateway key it duplicates, because Hermes never forwards `SLACK_BOT_TOKEN` to a child;
- any other credential is read only by the stdio server that lists it.

Use a scoped service key, never an interactive OAuth grant, and record its owner, scopes, and
rotation in the pull request that adds it.

## MCP servers

Every remote server a profile declares must match a `policy.mcp_servers` entry by its exact URL,
with `strict_redirect_headers: true`, an explicit `trust`, exact `tools.include` names (no globs),
`resources` and `prompts` off, and sampling and elicitation off. A profile loads only the entry's
`tools`, a write tool only if the entry's `writers` lists it, and never a `restricted` tool where
teammates can message it. No profile loads a `delete_*` tool. Every surface names its MCP servers or
`no_mcp`, and a surface that reads MCP data selects no egress toolset (`web`, `vision`, `browser`,
`terminal`, `code_execution`), except the owner console's Slack surface.

A stdio server runs a `policy.stdio_servers` entry: a root-owned wrapper by its `command`, or one of
the agent's own servers as `/usr/bin/python3 -I
/var/lib/hermes/.dodo-deployment/current/shared/mcp-servers/<name>/server.py <profile>`. Such a
server is standard-library Python and never starts a process.

## Scheduled jobs

A profile ships jobs in `cron/jobs.json` and lists their ids in `cron`. Jobs run only in profiles
without Slack ingress, with a five-field numeric schedule, the policy's timezone, and
`approvals.cron_mode: deny`. A `no_agent` job runs a reviewed script from the profile's `scripts/`
and no model; a script imports only a reviewed standard-library subset. A job delivers to `local` or
one of the profile's `delivery_targets`. New jobs arrive paused; an operator resumes each one.

## Run limits

Every profile caps its turns (`agent.max_turns` ≤ 50, ≤ 25 on a Slack gateway more than one person
can reach); a Slack gateway also sets `agent.run_budget_seconds` (≤ 900). The default profile's
`max_concurrent_sessions` (≤ 8) bounds gateway turns.

## Code execution

`terminal`, `file`, and `code_execution` run on the host as `hermes`, with `terminal.backend: local`
stated in the profile's `config.yaml`. Only a profile nobody but the owner can message may select
them: never a `gateway: slack` profile other than the owner console, and never a `slack_outbound`
profile next to its bot token. There is no container: such a terminal can read every profile's
`.env`, an accepted risk ([accepted risks](../../docs/myagent-capabilities/accepted-risks.md)).

## Plugins and Kanban workers

A capability that needs code execution, extra credentials, or a heavy skill runs in a **Kanban
worker** profile nothing can message. The hand-off profile gives it a job through a typed tool of
the policy's hand-off plugin, whose code, not the model, builds the Kanban task: a fixed assignee,
template, time limit, and the Slack thread to answer, taken from the session. No profile selects
Hermes's raw `kanban` toolset.

- A plugin directory holds exactly `plugin.yaml` and `__init__.py` (the hand-off plugin also
  `workers.json`). `plugin.yaml` has exactly `name`, a semantic `version`, a `description`,
  `kind: standalone`, and `provides_tools` equal to the fleet's `tools`, or for a hook plugin
  `provides_hooks` equal to its `hooks`.
- Every profile's config sets `plugins.enabled` to exactly its declared plugins.
- The hand-off plugin's tools are `policy.handoff.tools` followed by every worker's
  `handoff_tool`, sorted; `workers.json` maps each to its worker's name, `max_runtime_seconds`, and
  `max_retries`.
- A worker declares `gateway: false`, ships no jobs (a job worker's own `no_agent` job aside), selects
  nothing but `skills`, `todo`, `file`, `terminal`, `code_execution`, and its own MCP servers, sets
  `approvals: {mode: manual, single_query_mode: deny}`, and ships the policy's worker guard, byte
  for byte the same in every worker.
- The default profile's `kanban.dispatch_profiles` lists exactly the workers the dispatcher runs,
  with `max_in_progress_per_profile: 1` and no automatic decomposition or review dispatch.

## Removing a profile

The reconciler never interprets an absent manifest entry as permission to destroy runtime data.

1. Open a pull request removing the profile directory and manifest entry, with every job of the
   profile paused (`hermes -p <name> cron list --all`).
2. Merge it and let the reconciliation update the remaining fleet.
3. On the host, as the `hermes` user, run `hermes profile delete <name> --yes`, then verify the
   profile directory, alias, gateway, jobs, and projected skills are gone.

## Running a reconciliation

Reconcile only through your deployment. To return to an earlier state, revert the change on `main`
and let the deployment run the revert. TODO: the command that re-runs your deployment on `main`.

## Recovery and inspection

The deployed revision is root-owned and readable by the `hermes` group:

```sh
sudo cat /var/lib/hermes/.dodo-deployment/deployed-revision
```

A run that stops between swapping the skill views and finishing leaves
`/var/lib/hermes/.dodo-deployment/.{dodo,raven,hermes}-skills.previous` behind. The views are
derived entirely from Git, so the next run moves any leftover into `retired-profile-skills/` and
rebuilds every view. If reconciliation fails after switching behaviour, the reconciler restores the
prior release and skill views; a failed fresh install removes only profiles that run began creating.
