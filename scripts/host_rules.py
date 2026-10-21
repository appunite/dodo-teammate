"""Re-check the boundary rules of a release on the host, before the reconciler touches anything.

CI runs the full contract (src/fleet-rules.ts). The host does not trust what arrives, so the
reconciler runs this file on the extracted release first. It is installed on the host with the
reconciler, never taken from the release it checks. Every rule here has the same meaning as its
counterpart in src/fleet-rules.ts; test/parity.test.ts proves both refuse the same broken fleets.

Run as root with the system interpreter in isolated mode: /usr/bin/python3 -I host_rules.py <release>.
Exit 0 with no output when the release passes; exit 1 listing every problem otherwise.
"""

from pathlib import Path
import re
import sys

import yaml

SCHEMA_VERSION = 1
PLATFORMS = ("cli", "api_server", "slack", "cron")
SLACK_SAFE = {"clarify", "memory", "session_search", "skills", "todo", "vision", "web"}
OWNER_SLACK = {"file", "terminal"}
PERSONAL = {"memory", "session_search"}
EGRESS = {"browser", "vision", "web"}
MESSAGEABLE_EGRESS = EGRESS | {"code_execution", "terminal"}
EXECUTION = {"code_execution", "file", "terminal"}
MAX_TURNS = 50
SHARED_SLACK_MAX_TURNS = 25
NO_MCP = "no_mcp"
DM_ONLY_CHANNEL = "C0000000000"
DELETE_TOOL = re.compile(r"(?:^|[_-])(?:delete|destroy|purge|drop)(?:[_-]|$)", re.IGNORECASE)
WRITE_TOOL = re.compile(
    r"^(?:save|create|update|delete|post|send|write|put|set|add|remove|upload|merge|publish|run|"
    r"execute|edit|patch|assign|close|archive)(?:[_-]|$)",
    re.IGNORECASE,
)
HEADER_VALUE = re.compile(r"^(?:Bearer |Sentry-Bearer )?\$\{([A-Z][A-Z0-9_]*)\}$")


def check(release: Path) -> list[str]:
    problems: list[str] = []
    fail = problems.append
    fleet = yaml.safe_load((release / "profiles" / "fleet.yaml").read_text(encoding="utf-8"))
    if not isinstance(fleet, dict) or fleet.get("schema_version") != SCHEMA_VERSION:
        return [f"fleet: schema_version must be {SCHEMA_VERSION}."]
    owner = fleet.get("owner_slack_id")
    profiles = [fleet.get("default_profile") or {}, *(fleet.get("profiles") or [])]
    writes = fleet.get("reviewed_writes") or []
    owners = [profile for profile in profiles if profile.get("role") == "owner"]
    if len(owners) != 1:
        fail("fleet: exactly one profile has role owner.")

    for profile in profiles:
        name = profile.get("name")
        at = f"profile {name}"
        role = profile.get("role")
        gateway = profile.get("gateway")
        servers = profile.get("mcp_servers") or {}
        plugin_toolsets = {
            plugin.get("toolset")
            for plugin in (profile.get("plugins") or {}).values()
            if isinstance(plugin, dict) and plugin.get("toolset")
        }
        config_path = release / "profiles" / str(name) / "config.yaml"
        config = yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.is_file() else {}
        config = config if isinstance(config, dict) else {}

        if config.get("platform_toolsets") != profile.get("platform_toolsets"):
            fail(f"{at}: config.yaml platform_toolsets must equal the fleet entry.")
        if (config.get("mcp_servers") or {}) != servers:
            fail(f"{at}: config.yaml mcp_servers must equal the fleet entry.")

        for platform in PLATFORMS:
            toolsets = (profile.get("platform_toolsets") or {}).get(platform) or []
            where = f"{at} {platform}"
            mcp = [toolset for toolset in toolsets if toolset in servers]
            if "kanban" in toolsets:
                fail(f"{where}: no profile selects the raw kanban toolset.")
            egress = MESSAGEABLE_EGRESS if gateway == "slack" else EGRESS
            if role != "owner" and mcp:
                out = [toolset for toolset in toolsets if toolset in egress]
                if out:
                    fail(f"{where}: {', '.join(out)} next to MCP servers would open a way out for private data.")
            if platform == "slack" and gateway == "slack":
                for toolset in toolsets:
                    allowed = (
                        toolset == NO_MCP or toolset in servers or toolset in plugin_toolsets
                        or toolset in SLACK_SAFE or (role == "owner" and toolset in OWNER_SLACK)
                    )
                    if not allowed:
                        fail(f"{where}: {toolset} is not allowed on a Slack surface.")
                    if role != "owner" and toolset in PERSONAL:
                        fail(f"{where}: {toolset} would share one person's history with another.")
            if gateway == "slack" and role != "owner":
                code = [toolset for toolset in toolsets if toolset in EXECUTION]
                if code:
                    fail(f"{where}: {', '.join(code)} only where nobody but the owner can message.")
            if gateway == "slack_outbound" and {"terminal", "code_execution"} & set(toolsets):
                fail(f"{where}: an outbound profile runs no shell next to its bot token.")

        for server, definition in servers.items():
            where = f"{at} mcp {server}"
            definition = definition if isinstance(definition, dict) else {}
            include = (definition.get("tools") or {}).get("include") or []
            if not include:
                fail(f"{where}: tools.include must list the exact tools it loads.")
            for tool in include:
                if DELETE_TOOL.search(tool):
                    fail(f"{where}: {tool} is a delete tool; no profile loads one.")
                elif WRITE_TOOL.search(tool) and not any(
                    entry.get("profile") == name and entry.get("server") == server
                    and tool in (entry.get("tools") or [])
                    for entry in writes
                ):
                    fail(f"{where}: {tool} writes; list it in reviewed_writes for {name}/{server}.")
            headers = {**(definition.get("headers") or {}), **(definition.get("env") or {})}
            for header, value in headers.items():
                if not isinstance(value, str) or not HEADER_VALUE.match(value):
                    fail(f"{where}: {header} must be a ${{NAME}} reference, never a literal value.")

        turns = (config.get("agent") or {}).get("max_turns")
        limit = SHARED_SLACK_MAX_TURNS if role == "team" else MAX_TURNS
        if not isinstance(turns, int) or not 1 <= turns <= limit:
            fail(f"{at}: agent.max_turns must be 1 to {limit}.")

        slack = config.get("slack") if isinstance(config.get("slack"), dict) else None
        if role == "owner":
            if not slack or slack.get("allow_from") != [owner]:
                fail(f"{at}: slack.allow_from must be exactly [owner_slack_id]; this profile keeps memory and a shell.")
            if slack and slack.get("group_allow_from"):
                fail(f"{at}: the owner console takes no channel users.")
            if slack and slack.get("allowed_channels") != [DM_ONLY_CHANNEL]:
                fail(f"{at}: slack.allowed_channels must be [{DM_ONLY_CHANNEL}], so only DMs reach it.")
        if role == "team":
            memory = config.get("memory") or {}
            if memory.get("memory_enabled") is not False or memory.get("user_profile_enabled") is not False:
                fail(f"{at}: a profile several people talk to keeps no memory.")
            if not slack or slack.get("allow_bots") != "none":
                fail(f"{at}: slack.allow_bots must be none.")
        if gateway in ("slack", "slack_outbound"):
            if not slack or slack.get("unfurl_links") is not False or slack.get("unfurl_media") is not False:
                fail(f"{at}: Slack link unfurling must be off.")
    return problems


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: host_rules.py <release directory>", file=sys.stderr)
        return 2
    problems = check(Path(sys.argv[1]))
    for problem in problems:
        print(f"host: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
