"""Unit tests for the workers' myagent-worker-guard plugin, without Hermes.

Run with `mise run plugins`.
"""

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

PLUGIN = Path(__file__).resolve().parents[2] / "profiles" / "myagent-writer" / "plugins" / "myagent-worker-guard"


def load_plugin():
    spec = importlib.util.spec_from_file_location("worker_guard_under_test", PLUGIN / "__init__.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


guard = load_plugin()
TASK = "t_0123abcd"


class WorkerGuardTest(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.env = {
            "HERMES_KANBAN_TASK": TASK,
            "HERMES_KANBAN_WORKSPACE": self.workspace.name,
            "HERMES_HOME": "/var/lib/hermes/.hermes/profiles/myagent-writer",
        }

    def tearDown(self):
        self.workspace.cleanup()

    def decide(self, tool, args):
        return guard.decide(tool, args, self.env)

    def test_other_tools_pass_untouched(self):
        self.assertIsNone(self.decide("write_file", {"path": "document.md"}))

    def test_blocks_tools_that_reach_past_the_task(self):
        for tool in ("kanban_create", "kanban_list", "kanban_unblock", "kanban_future_tool"):
            with self.subTest(tool=tool):
                self.assertEqual(self.decide(tool, {})["action"], "block")

    def test_own_task_only(self):
        self.assertIsNone(self.decide("kanban_show", {"task_id": TASK}))
        self.assertEqual(self.decide("kanban_show", {"task_id": "t_99999999"})["action"], "block")
        self.assertEqual(self.decide("kanban_show", {"board": "other"})["action"], "block")

    def test_blocks_everything_outside_a_task(self):
        self.assertEqual(guard.decide("kanban_show", {}, {})["action"], "block")

    def test_completion_needs_the_document(self):
        decision = self.decide("kanban_complete", {"summary": "Done\nA summary."})
        self.assertEqual(decision["action"], "block")
        self.assertIn(".md", decision["message"])

    def test_completion_admits_a_markdown_file_from_the_workspace(self):
        Path(self.workspace.name, "document.md").write_text("# Title\n", encoding="utf-8")
        decision = self.decide("kanban_complete", {
            "summary": "Wrote the summary\nThree sections.",
            "artifacts": ["document.md"],
        })
        self.assertEqual(decision["action"], "modify")
        self.assertEqual(len(decision["args"]["artifacts"]), 1)
        self.assertTrue(decision["args"]["summary"].startswith("Document written;"))

    def test_completion_refuses_other_file_types(self):
        Path(self.workspace.name, "notes.txt").write_text("x", encoding="utf-8")
        decision = self.decide("kanban_complete", {"summary": "a\nb", "artifacts": ["notes.txt"]})
        self.assertEqual(decision["action"], "block")

    def test_completion_refuses_a_path_outside_the_workspace(self):
        decision = self.decide("kanban_complete", {"summary": "a\nb", "artifacts": ["../../etc/hostname"]})
        self.assertEqual(decision["action"], "block")


if __name__ == "__main__":
    unittest.main()
