"""Remind teammates who have not posted in today's daily-update thread.

The myagent-scheduled cron job standup-reminder runs this as a no_agent job: no model and no
tokens. Hermes starts it with no arguments and its scripts/ directory as the working directory.
Stdout is the run's output, empty output is a silent run, and a non-zero exit sends stderr to the
job's failure_deliver (Hermes Agent v0.21.5: cron/scheduler_script.py, cron/scheduler.py).

It decides whom to remind from user IDs only: who replied in the thread and who is on ROSTER. The
only text it reads is the start of channel messages, to find the thread, and its own earlier DMs,
to avoid reminding anyone twice. Everything it sends is one of the fixed NUDGES plus a permalink.
Each run sends at most one DM per person and never more than MAX_MESSAGES messages in total.

Generalised from Dodo's standup reminder. Set CHANNEL, THREAD_PREFIX, and ROSTER before enabling.
"""

from datetime import date, datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

# "live" sends; "dry-run" only reads Slack and prints whom it would remind. Hermes passes cron
# scripts no arguments, so only a reviewed pull request changes it.
MODE = "dry-run"

TOKEN_ENV = "MYAGENT_SLACK_BOT_TOKEN"
API = "https://slack.com/api/"
TZ = ZoneInfo("UTC")
# The channel the daily thread is posted in, and how its root message starts.
CHANNEL = "C000TEAM01"
THREAD_PREFIX = "Daily update"
# Whom to remind. A static list reviewed in Git; changing it is a pull request.
ROSTER = ("U000TEAM01", "U000TEAM02")
REMINDER_DAYS = frozenset({0, 1, 2, 3, 4})  # Monday is 0.
MAX_MESSAGES = 15
NUDGES = (
    "No daily update from you yet; please post one in {thread}",
    "Friendly reminder: your daily update goes in {thread}",
    "Daily update not found (404); please post one in {thread}",
)
USER_ID = re.compile(r"[UW][A-Z0-9]{2,}")
MAX_PAGES = 20


class SlackError(Exception):
    def __init__(self, method: str, error: str):
        super().__init__(f"Slack {method} failed: {error}")
        self.method = method
        self.error = error


class CapExceeded(Exception):
    pass


class Slack:
    """A minimal Slack Web API client. Errors name the method and Slack's error code only."""

    def __init__(self, token: str, opener=urllib.request.urlopen):
        self._token = token
        self._open = opener

    def call(self, method: str, **params) -> dict:
        fields = {
            key: ("true" if value else "false") if isinstance(value, bool) else value
            for key, value in params.items()
            if value is not None
        }
        request = urllib.request.Request(
            API + method,
            data=urllib.parse.urlencode(fields).encode(),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            },
        )
        try:
            with self._open(request, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise SlackError(method, f"http_{error.code}") from None
        except urllib.error.URLError as error:
            raise SlackError(method, f"network error: {error.reason}") from None
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise SlackError(method, "invalid_response") from None
        if not isinstance(body, dict) or body.get("ok") is not True:
            error = body.get("error") if isinstance(body, dict) else None
            raise SlackError(method, str(error or "unknown_error"))
        return body

    def pages(self, method: str, key: str, **params) -> list:
        items = []
        cursor = None
        for _ in range(MAX_PAGES):
            body = self.call(method, cursor=cursor, **params)
            items.extend(body.get(key) or [])
            cursor = (body.get("response_metadata") or {}).get("next_cursor")
            if not cursor:
                return items
        raise SlackError(method, "too_many_pages")


def ids(values) -> str:
    return ", ".join(values) if values else "none"


def run(slack: Slack, mode: str, now: datetime) -> list[str]:
    today: date = now.astimezone(TZ).date()
    if today.weekday() not in REMINDER_DAYS:
        return [f"{today}: skipped, not a reminder day."]
    nudge = NUDGES[today.toordinal() % len(NUDGES)]
    oldest = f"{datetime(today.year, today.month, today.day, tzinfo=TZ).timestamp():.6f}"

    bot_user = slack.call("auth.test").get("user_id")
    if not isinstance(bot_user, str) or not USER_ID.fullmatch(bot_user):
        raise SlackError("auth.test", "no_bot_user")

    threads = [
        message
        for message in slack.pages(
            "conversations.history", "messages", channel=CHANNEL, oldest=oldest, limit=200
        )
        if str(message.get("text", "")).lstrip().startswith(THREAD_PREFIX)
    ]
    if not threads:
        return [f"{today}: no daily thread yet; nobody was reminded."]
    thread_ts = min(threads, key=lambda message: float(message["ts"]))["ts"]
    link = slack.call("chat.getPermalink", channel=CHANNEL, message_ts=thread_ts)["permalink"]
    thread_id = "p" + thread_ts.replace(".", "")

    replies = slack.pages(
        "conversations.replies", "messages", channel=CHANNEL, ts=thread_ts, limit=200
    )
    repliers = {
        message["user"]
        for message in replies
        if message.get("ts") != thread_ts and isinstance(message.get("user"), str)
    }
    pending = [user for user in ROSTER if user not in repliers and user != bot_user]
    if len(pending) > MAX_MESSAGES:
        raise CapExceeded(
            f"{today}: would send {len(pending)} messages, more than MAX_MESSAGES "
            f"({MAX_MESSAGES}); nothing was sent."
        )

    targets = []
    reminded = []
    for user in pending:
        channel = slack.call("conversations.open", users=user)["channel"]["id"]
        history = slack.pages(
            "conversations.history", "messages", channel=channel, oldest=oldest, limit=50
        )
        if any(
            message.get("user") == bot_user and thread_id in str(message.get("text", ""))
            for message in history
        ):
            reminded.append(user)
        else:
            targets.append((user, channel))

    if mode != "live":
        return [
            f"Daily-update reminder, dry run for {today}. Nothing was sent.",
            f"Thread: {link}",
            f"Would DM: {ids([user for user, _ in targets])}",
            f"Already reminded today: {ids(reminded)}",
        ]
    for _, channel in targets:
        slack.call(
            "chat.postMessage",
            channel=channel,
            text=nudge.format(thread=f"the thread: {link}"),
            unfurl_links=False,
            unfurl_media=False,
        )
    return [
        f"{today}: reminded {len(targets)} by DM, {len(reminded)} already reminded, "
        f"{len(repliers)} replied.",
        f"DM'd: {ids([user for user, _ in targets])}",
    ]


def main() -> int:
    token = os.environ.get(TOKEN_ENV, "").strip()
    if not token:
        print(
            f"{TOKEN_ENV} is not set; check the profile's runtime_env, terminal.env_passthrough, "
            "and .env.",
            file=sys.stderr,
        )
        return 3
    if MODE not in {"dry-run", "live"}:
        print(f"MODE must be dry-run or live, not {MODE!r}.", file=sys.stderr)
        return 3
    try:
        lines = run(Slack(token), MODE, datetime.now(TZ))
    except (SlackError, CapExceeded) as error:
        print(str(error), file=sys.stderr)
        return 2 if isinstance(error, CapExceeded) else 1
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
