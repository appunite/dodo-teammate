# MyAgent's team capabilities

Each capability has a self-contained spec under [capabilities/](capabilities/TEMPLATE.md): trigger,
profile, skill, tools, credentials, policy entries, rules, abuse analysis, rollout, and
verification. Write the spec before the code, and mark it implemented when it lands instead of
deleting it; [the contract docs](../../infra/docs/deploy-profiles.md) remain the source of truth.

## Capabilities

| # | Capability | Trigger | Runs in | Status |
|---|---|---|---|---|
| C1 | [Daily-update reminder](capabilities/c1-daily-update-reminder.md) | weekdays 12:00 | `myagent-scheduled` | example, dry-run until its IDs are set |

## Foundations

Foundations are contract changes that capabilities need, landed before them. The starter fleet
already carries Dodo's (see [foundations](foundations/README.md)).

## Principles

1. **Do not redesign the trust model; fit inside it.** There are three roles. The owner has full
   control through `myagent-admin`, a DM-only app with one allowed user. The team works through
   `myagent-slack`, which has reviewed allowlists, narrow toolsets, and turn caps. Everyone else
   gets no reply and no reaction. A capability that needs more than its tier allows gets a new
   *profile* whose extra authority is stated in validated config. Prompt text never widens a tier.
2. **Separate ingress from authority.** A profile that people can message holds no write
   credentials, except the writes the policy lists for it (the starter fleet: Linear issues from
   `myagent-slack`, an accepted risk). Scheduled work that writes runs in a profile with **no Slack
   ingress**, so nobody can talk to it.
3. **Write from the first release; control writes in validated config.** A capability that writes
   ships live, with its write credential and tools in its first pull request. The controls are the
   fleet policy: exact tool lists without delete tools, `writes` and their `writers`, keys scoped to
   the teams or repositories the capability needs, and per-run caps in reviewed scripts.
4. **Put every safety property in validated config.** The validator holds generic rules; the
   capability's specifics go in the `policy` block of `profiles/fleet.yaml`. The validator and the
   reconciler never name a profile, URL, tool, or credential.
5. **Never combine private data, untrusted text, and an open egress channel on one surface.** Any
   surface that reads private data through MCP selects no `web`, `vision`, `browser`, `terminal`, or
   `code_execution`, and switches Slack link unfurling off. The owner console is the single accepted
   exception.
6. **Keep `myagent-slack` light; hand specialised work off through Kanban.** A job that needs code
   execution, extra credentials, or a heavy skill goes to a worker profile through a typed hand-off
   tool whose code, not the model, builds the Kanban task.
7. **Prefer deterministic code over the model.** Fetching, diffing, and counting belong in reviewed
   scripts (`no_agent` cron jobs) or in the source system's CI. A script spends no tokens and can't
   be prompt-injected.

## Fleet map

| Profile | Who can reach it | Purpose | Credentials |
|---|---|---|---|
| `default` | Operators, through the dashboard or CLI | The Hermes launch profile: host-wide Slack policy, the session cap, and the Kanban dispatcher | Model provider auth only |
| `myagent-admin` | The owner only, by DM to the owner's app | The owner's console with memory, web, and a host terminal; maintains this repository through pull requests | The owner's app tokens |
| `myagent-slack` | Allowlisted teammates, by mention in an allowed channel or DM | Quick help in Slack: answers from read tools, Linear issues, and typed hand-offs | Team app tokens, `LINEAR_TEAM_TOKEN`, `SENTRY_READ_TOKEN` |
| `myagent-scheduled` | Nobody: `gateway: slack_outbound` | Reminders and reports on reviewed schedules | The team app's bot token and its script copy `MYAGENT_SLACK_BOT_TOKEN` |
| `myagent-writer` | Nobody directly: only `handoff_document` tasks | An example Kanban worker that turns a thread into a Markdown document | None but its model key |

See [accepted risks](accepted-risks.md) for the trade-offs the starter fleet makes.
