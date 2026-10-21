# C&lt;n&gt;. &lt;Capability name&gt;

Status: proposed | implemented on `<branch>` | live since `<date>`. Say what still has to happen
before it is live (keys to set, jobs to resume, host changes).

Part of [MyAgent's capabilities](../README.md). Keep this spec short: one screen is plenty for most capabilities.

## Purpose

What MyAgent does, for whom, and why it is worth having. One paragraph.

## Trigger and profile

- **Trigger:** a mention or DM, a schedule (`<cron>`, timezone), or a typed hand-off.
- **Profile:** which profile runs it and why that profile (its gateway and the policy decide its
  reach). A new profile needs a line on why no existing one fits.
- **Who can start it:** the allowlist, nobody (a schedule), or only the team profile's hand-off.

## How it works

The steps, in order. Mark which steps are deterministic code (a script, a plugin) and which need
the model's judgement. Prefer code for fetching, diffing, and counting.

## Skill

The skill that tells the model how to do the job, and the profiles that select it.

## Tools and credentials

| Credential | Profile | Owner | Exact scopes | Rotation |
|---|---|---|---|---|
| `NAME_TOKEN` | `myagent-…` | who issued it | read-only? which projects or teams? | where to rotate it |

The MCP servers and the exact tools each loads.

**Policy entries** (`profiles/fleet.yaml` `policy`; the validator itself does not change):

- `mcp_servers`: each server's exact URL (or command), its `tools`, its `writes` and the `writers`
  that may load them, and any `restricted` tools the team profile must never load;
- `credentials`: each credential, the `profiles` that may hold it, and either `header` with its
  `urls` or `script: true` (with `copy_of` for a copy of a gateway key);
- `stdio_servers`: each stdio server it runs, with its tools, credentials, and `restricted` tools;
- `restricted_paths`: any path only some files may name (where a write key lives on the host);
- a profile with special standing: `owner_console`, `personal_data_profiles`,
  `model_free_profiles`, or a skill in `repository_write_skills`.

## Rules

What MyAgent must always or never do in this capability, and which of these are enforced in
validated config (preferred) versus only in the skill.

## Abuse analysis

- What can a teammate on the allowlist make it do that they should not?
- What can untrusted text (an issue, a log, an error payload, another person's message) make it do?
- Could private data leave through any tool, link, or file on the same surface?
- What is the worst write it can make, and what limits it (scoped key, exact tool list, per-run cap,
  idempotency)?

## Accepted risks

Each risk this capability accepts, its controls, and who accepted it. Copy each one into
[the accepted-risk list](../accepted-risks.md).

## Rollout

The release path: fleet only (merge, reconcile), host (infrastructure workflow first), or runtime
(keys, models, resuming jobs on the host). The exact steps, in order, and who does each.

## Verification

How to prove it works: the Slack message to send, what a good answer looks like and where it
appears, and what to check on the host. Note anything not verified yet.
