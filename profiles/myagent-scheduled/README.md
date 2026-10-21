# myagent-scheduled

Reminders, digests, and reports on reviewed schedules. `gateway: slack_outbound`: the profile holds
the team app's bot token and never its app token, so Hermes cannot open a Socket Mode connection
for it and nobody can message it.

| | |
|---|---|
| Jobs | `standup-reminder` (`cron/jobs.json`): a `no_agent` job that runs `scripts/standup-reminder.py`. No model, no tokens. |
| Delivery | Failures go to `slack:D000OWNERDM`, declared in `delivery_targets`. The script sends its own DMs. |
| Credentials | `SLACK_BOT_TOKEN` (team app, from `gateway: slack_outbound`) and the same value as `MYAGENT_SLACK_BOT_TOKEN` for the script. |
| Tools | `skills` and `todo` only. No `web`, `terminal`, `file`, or `code_execution`. |

New jobs arrive paused on the host. An operator resumes each one after checking its first effect.

Before enabling the reminder, set `CHANNEL`, `THREAD_PREFIX`, and `ROSTER` in the script.
