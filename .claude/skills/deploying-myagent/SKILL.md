---
name: deploying-myagent
description: Use when rolling a merged change out to MyAgent's Hermes host and proving it works — after a pull request merges, "deploy it", "set the keys", "resume the jobs", "is MyAgent up?", "MyAgent says <error> in Slack", or when checking the gateway, profiles, credentials, MCP servers, or cron jobs on the host. For writing the change itself, use building-myagent-capability.
---

# Deploying MyAgent

A merged change is not live until the reconciler has installed it, every runtime value it needs is
set on the host, and someone has seen it work in Slack. This skill walks that path.

TODO: fill in your host access (for example SSH over a private network, or your cloud's session
manager), the command that triggers a reconciliation, and where its log lands.

## Boundaries

- Reach only MyAgent's host. Never run commands on other machines in the same account.
- **Deploy only through the deployment workflow**, never by running the reconciler by hand.
- **Never print a secret.** List `.env` key names (`cut -d= -f1`), never values. Do not copy, write,
  or move credential values yourself; hand the user a paste-in snippet instead. If a tool call is
  denied, stop and explain.
- **The user merges pull requests** and sends the Slack test messages.
- **Scheduled jobs stay paused until the user says to resume them.**

## 1. Pick the path

From the changed files:

- **Fleet** (`profiles/`, `shared/`): merging triggers a reconciliation. Read its result.
- **Validator, reconciler, or infrastructure** (`infra/assets/reconcile-profiles.sh`, `infra/src/`
  (the validator bundle), your infrastructure code): the user
  applies the infrastructure change first, so the host runs the new reconciler; then trigger a
  reconciliation. Until then the old reconciler checks the new release and may refuse it, which is
  the safe direction.
- **Runtime** (keys, models, gateway, jobs): host only, then reconcile once so the checks confirm
  the state.

## 2. Reconcile and read the result

A good run ends with `Reconciled default … at <sha>.` A run that refuses a release names the rule;
fix it in the repository, never on the host.

Before the first reconciliation, list every `runtime_env` name the change adds, per profile, and
have the user set the values in the Hermes dashboard (profile switcher → **API Keys**), or in the
profile's `.env` for Slack tokens on an outbound profile.

## 3. Check the host

Useful read-only probes (with `H` as the Hermes CLI run as the hermes user):

```sh
H gateway status
H profile list
H -p <profile> cron list --all
H kanban list
```

- An outbound profile shows its Slack adapter as fatal or "same credential": that is by design, it
  holds only the bot token. Confirm the team and admin apps connected instead.
- A 403 from an MCP server naming a missing scope means the key needs that scope; the user edits
  the key in the service.

Restart the gateway when a new profile, a plugin, or a timezone arrives, if the reconciliation did
not reload it.

## 4. Resume jobs and test in Slack

New jobs arrive paused. List each with its schedule and first effect, and ask the user which to
resume: `H -p <profile> cron resume <job>`. Then give the user one Slack message per capability,
what a good answer looks like, and where it should appear. When MyAgent replies with an error, find
it in the host's logs and Hermes source and fix it in the repository with
`building-myagent-capability`; a hot-fix on the host is overwritten by the next deployment.

## 5. Report

One message: what is live (profiles, commit), what the user still has to do (each key, each job,
each Slack test), and anything unverified.
