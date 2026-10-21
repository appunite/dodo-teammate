"""Keeps the myagent-capabilities skill in step with the fleet it describes.

Run with `mise run skills`. myagent-slack answers "what can you do?" from that skill, so a profile
or scheduled job added to the fleet without an entry there would be invisible to the team.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "shared" / "skills" / "myagent-capabilities" / "SKILL.md"
FLEET = ROOT / "profiles" / "fleet.yaml"

# Where the skill describes each profile. A new profile needs a line in the skill and an entry here.
PROFILE_TEXT = {
    "default": None,  # the shared gateway settings, not a part people use
    "myagent-admin": None,  # the owner's console, not a part the team uses
    "myagent-slack": "What people can ask MyAgent here",
    "myagent-scheduled": "Daily-update reminder",
    "myagent-writer": "Documents",
}


def fleet_profiles() -> list[str]:
    names = re.findall(r"^  - name: (\S+)$", FLEET.read_text(encoding="utf-8"), re.MULTILINE)
    return ["default", *names]


class MyAgentCapabilitiesSkillTest(unittest.TestCase):
    def setUp(self):
        self.skill = SKILL.read_text(encoding="utf-8")

    def test_every_profile_is_described(self):
        profiles = fleet_profiles()
        self.assertGreater(len(profiles), 1)
        for name in profiles:
            with self.subTest(profile=name):
                self.assertIn(name, PROFILE_TEXT, f"describe {name} in {SKILL.name}, then map it here")
                text = PROFILE_TEXT[name]
                if text is not None:
                    self.assertTrue(text in self.skill, f"{text!r} is missing from {SKILL.name}")

    def test_every_scheduled_job_is_described(self):
        jobs = []
        for store in sorted((ROOT / "profiles").glob("*/cron/jobs.json")):
            jobs += json.loads(store.read_text(encoding="utf-8"))["jobs"]
        self.assertTrue(jobs)
        for job in jobs:
            with self.subTest(job=job["id"]):
                self.assertTrue(job["name"] in self.skill, f"add {job['name']!r} to the skill")

    def test_myagent_slack_selects_it(self):
        block = FLEET.read_text(encoding="utf-8").split("  - name: myagent-slack\n", 1)[1]
        block = block.split("\n  - name: ", 1)[0]
        self.assertRegex(block, r"dodo_skills:\n(?:      - \S+\n)*      - myagent-capabilities\n")

    def test_names_no_credentials(self):
        self.assertIsNone(re.search(r"\b[A-Z][A-Z0-9]*_(?:TOKEN|KEY|SECRET)\b", self.skill))


if __name__ == "__main__":
    unittest.main()
