# myagent-slack

The team's front door: the team Slack app, answering allowlisted teammates in allowed channels.

| | |
|---|---|
| Who can reach it | The user IDs in `slack.allow_from` and `slack.group_allow_from` (identical), by mention in a channel in `slack.allowed_channels`, or by DM. Everyone else gets no reply. |
| Tools | Slack: `clarify`, `skills`, `todo`, the `myagent_handoff` plugin toolset, Linear (reads plus `save_issue` and `save_comment`), Sentry (four reads). No `web`, `vision`, `browser`, `terminal`, `file`, `code_execution`, or `memory`. |
| Limits | 25 turns and 300 seconds a run; no memory. |
| Credentials | Team app `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`; `LINEAR_TEAM_TOKEN` (Read and Write, one team, never Admin); `SENTRY_READ_TOKEN` (read scopes only). |
| Plugin | `myagent-handoff`: typed hand-offs to worker profiles, built by code (see `plugins/myagent-handoff/__init__.py`). |

Record each key's owner, exact scopes, and rotation source in the pull request that adds it.

## Adding a hand-off

1. Add a Kanban worker profile (`kanban_worker` in the fleet) that ships the policy's worker guard.
2. Add a typed tool to the plugin that calls `create_handoff`, and its entry in `workers.json`.
3. List the tool in this profile's `plugins.myagent-handoff.tools` in `profiles/fleet.yaml`.
4. Add the worker to the default profile's `kanban.dispatch_profiles`.
5. Write the capability spec in `docs/myagent-capabilities/capabilities/`.
