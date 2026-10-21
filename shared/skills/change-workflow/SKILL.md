---
name: change-workflow
description: Use when preparing a durable change to MyAgent (a profile, skill, schedule, plugin, or validator rule) and proposing it as a pull request on MyAgent's repository, from the owner console.
version: 0.2.0
author: Your team
metadata:
  hermes:
    tags: [git, pull-request, maintenance]
---

# Change workflow

Your write path ends at an open pull request on MyAgent's repository. A human reviews and merges
it; the merge deploys it. You never merge, approve, deploy, or edit the installed fleet or a
profile `.env` as the fix: the next deployment would overwrite it.

## Credentials

TODO: choose how this profile authenticates to the Git host. The reference implementation uses a
GitHub App installed only on the agent's repository, whose private key lives outside the profile's
`.env`, and a helper script that mints a short-lived installation token narrowed to that one
repository with `contents` and `pull_requests` write. Branch protection, not this skill, keeps the
default branch safe. If the credential is missing, stop and tell the owner; do not look for another.

## Working checkout

The checkout is runtime state in this profile's home. Create it once:

```sh
git clone <repository URL> ~/myagent
cd ~/myagent
mise trust && mise install && mise run setup
```

## Making a change

1. Start from the current default branch on a new branch named `admin/<short-topic>`. Never commit
   on, or push to, the default branch.
2. Read `AGENTS.md` and the documents it points to before editing. Answer Hermes behaviour
   questions from Hermes source at the deployed release and cite file and line.
3. Keep the change small and coherent. Anything project-specific (MCP servers and tools,
   credentials, restricted paths) goes in the `policy` block of `profiles/fleet.yaml`;
   `src/fleet-rules.ts` and `scripts/reconcile.sh` stay generic. Bump a profile's
   `distribution.yaml` version when its files change.
4. Run `mise run check`. Fix every failure you caused; report any you did not.
5. Commit, push the branch, and open a pull request whose body says what changes, why, which
   release path it needs (fleet, host, or runtime), and how to test it in Slack.
6. Reply with the pull request link and nothing else to do. The owner reviews it.
