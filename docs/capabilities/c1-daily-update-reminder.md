# C1. Daily-update reminder

Status: shipped in the template in `MODE = "dry-run"` because its channel and roster are
placeholders. Live after the IDs are set, `MODE = "live"` is merged, the tokens are set on the host,
and an operator resumes the job.

A worked example of [the spec template](TEMPLATE.md).

## Purpose

On weekdays at noon, MyAgent DMs the people who have not posted their daily update in the day's
thread, with a link to it. Nobody has to remember to chase updates.

## Trigger and profile

- **Trigger:** `0 12 * * 1-5`, UTC (`profiles/myagent-scheduled/cron/jobs.json`).
- **Profile:** `myagent-scheduled`, role `scheduled`, `gateway: slack_outbound`: it posts as the
  team app and nobody can message it.
- **Who can start it:** nobody; only the schedule. An operator can run it by hand on the host.

## How it works

A `no_agent` job runs `scripts/standup-reminder.py`. **No model and zero tokens.** The script:

1. finds today's thread in `CHANNEL`: the first message today starting with `THREAD_PREFIX`;
2. reads the thread's replies and keeps only their author IDs;
3. for each user on `ROSTER` without a reply, opens their DM and skips them if MyAgent already
   sent them a message linking today's thread;
4. sends each remaining person one fixed nudge with the thread's link, never more than
   `MAX_MESSAGES` in a run.

## Skill

None: no model runs.

## Tools and credentials

| Credential | Profile | Owner | Exact scopes | Rotation |
|---|---|---|---|---|
| `SLACK_BOT_TOKEN` | `myagent-scheduled` | the team Slack app's owner | `channels:history`, `chat:write`, `im:write`, `im:history` | the Slack app's OAuth page |
| `MYAGENT_SLACK_BOT_TOKEN` | `myagent-scheduled` | the same value | the same | the same |

Hermes never passes a `SLACK_*` key to a script, so the script reads the same value under a second
name, passed through `terminal.env_passthrough`.

## Rules

- Reads only user IDs, the start of channel messages (to find the thread), and its own DMs.
- Sends only the fixed `NUDGES` plus a permalink. Enforced in the reviewed script.
- At most one DM per person a day and `MAX_MESSAGES` a run. Enforced in the script.

## Abuse analysis

- **Teammates:** cannot reach the profile; it has no Slack ingress.
- **Untrusted text:** a message starting with `THREAD_PREFIX` could be taken as the thread. The
  worst effect is a link to the wrong thread; nothing else is read as text.
- **Private data:** none leaves; it reads IDs and posts fixed text.
- **Worst write:** `MAX_MESSAGES` DMs with a wrong link, once a day.

## Accepted risks

None beyond the above.

## Rollout

1. Set `CHANNEL`, `THREAD_PREFIX`, `ROSTER`, and `MODE = "live"`; merge.
2. Set `SLACK_BOT_TOKEN` and `MYAGENT_SLACK_BOT_TOKEN` in the profile's `.env` on the host, then
   reconcile.
3. Resume the job: `hermes -p myagent-scheduled cron resume standup-reminder`.

## Verification

- Run it once by hand on the host and read the output: who it DM'd, who was already reminded.
- The next weekday at noon, the people without an update get one DM each.
