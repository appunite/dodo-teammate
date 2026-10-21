"""Unit tests for myagent-scheduled's standup reminder, with a fake Slack. Run with `mise run scripts`."""

from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).resolve().parents[2] / "profiles" / "myagent-scheduled" / "scripts" / "standup-reminder.py"


def load_script():
    spec = importlib.util.spec_from_file_location("standup_reminder_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


reminder = load_script()
THREAD = "1790000000.000100"
TUESDAY = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)


class FakeSlack:
    def __init__(self, replied=(), already_reminded=()):
        self.replied = replied
        self.already_reminded = already_reminded
        self.posted = []

    def call(self, method, **params):
        if method == "auth.test":
            return {"user_id": "U000BOT001"}
        if method == "chat.getPermalink":
            return {"permalink": f"https://example.slack.com/archives/C000TEAM01/p{THREAD.replace('.', '')}"}
        if method == "conversations.open":
            return {"channel": {"id": "D" + params["users"][1:]}}
        if method == "chat.postMessage":
            self.posted.append(params)
            return {}
        raise AssertionError(method)

    def pages(self, method, key, **params):
        if method == "conversations.replies":
            return [{"ts": THREAD, "user": "U000HOST01"}, *({"ts": "2", "user": u} for u in self.replied)]
        if params["channel"] == reminder.CHANNEL:
            return [{"ts": THREAD, "text": f"{reminder.THREAD_PREFIX} thread"}]
        user = "U" + params["channel"][1:]
        if user in self.already_reminded:
            return [{"user": "U000BOT001", "text": f"link p{THREAD.replace('.', '')}"}]
        return []


class ReminderTest(unittest.TestCase):
    def test_dms_only_people_who_have_not_replied(self):
        slack = FakeSlack(replied=("U000TEAM01",))
        lines = reminder.run(slack, "live", TUESDAY)
        self.assertEqual([post["channel"] for post in slack.posted], ["D000TEAM02"])
        self.assertIn("reminded 1 by DM", lines[0])

    def test_never_reminds_twice_a_day(self):
        slack = FakeSlack(already_reminded=("U000TEAM01", "U000TEAM02"))
        reminder.run(slack, "live", TUESDAY)
        self.assertEqual(slack.posted, [])

    def test_dry_run_sends_nothing(self):
        slack = FakeSlack()
        lines = reminder.run(slack, "dry-run", TUESDAY)
        self.assertEqual(slack.posted, [])
        self.assertIn("Would DM: U000TEAM01, U000TEAM02", lines)

    def test_skips_other_days(self):
        saturday = datetime(2026, 10, 24, 12, tzinfo=timezone.utc)
        self.assertIn("not a reminder day", reminder.run(FakeSlack(), "live", saturday)[0])


if __name__ == "__main__":
    unittest.main()
