"""Keeps shared/mcp-servers/ in step with the fleet policy's stdio servers.

Run with `mise run mcp-servers`. Each of the agent's own stdio servers lives in
shared/mcp-servers/<name>/server.py and is listed, without a command, in policy.stdio_servers; the
fleet validator enforces both directions. Add a test module per server next to this one, as Dodo
does (tests/mcp-servers/test_<server>.py).
"""

from __future__ import annotations

from pathlib import Path
import re
import sys
import unittest

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
SERVERS = ROOT / "shared" / "mcp-servers"
FLEET = ROOT / "profiles" / "fleet.yaml"


def policy_block() -> str:
    text = FLEET.read_text(encoding="utf-8")
    return text.split("\npolicy:\n", 1)[1].split("\ndefault_profile:\n", 1)[0]


class ServersMatchPolicyTest(unittest.TestCase):
    def test_every_server_directory_is_a_policy_entry(self):
        block = policy_block()
        stdio = block.split("  stdio_servers:", 1)[1]
        for directory in sorted(SERVERS.iterdir()) if SERVERS.is_dir() else []:
            with self.subTest(server=directory.name):
                self.assertRegex(stdio, rf"(?m)^    {re.escape(directory.name)}:$")
                self.assertTrue((directory / "server.py").is_file())

    def test_policy_declares_stdio_servers(self):
        self.assertIn("  stdio_servers:", policy_block())


if __name__ == "__main__":
    unittest.main()
