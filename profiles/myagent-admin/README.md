# myagent-admin

The owner's private console: a separate Slack app (the "admin app") that only the owner can DM.

| | |
|---|---|
| Who can reach it | `owner_slack_id` only, by DM. Channel events are dropped (`allowed_channels` is a channel that does not exist). |
| Tools | Every surface: `clarify`, `web`, `vision`, `file`, `terminal`, `skills`, `todo`, `memory`, `session_search`. No MCP servers. |
| Credentials | The admin app's `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (declared by `gateway: slack`), and the model key. Set on the host. |
| Skills | `change-workflow` for repository pull requests, plus the baseline skills. |

This is the single accepted exception to the egress rule: memory, web, and a terminal sit next to
each other because nobody else can talk to this profile. The validator refuses a second allowed
user. Keep it that way.
