"""Confine a Kanban worker's board tools to its own task.

Copied from Dodo (profiles/derek-ci/plugins/derek-worker-guard). The Hermes file and line citations
below are from Hermes Agent v0.21.5 (tag v2026.9.24); re-check them against the release you run.

Hermes gives every dispatcher-spawned worker the Kanban tools whatever its config, and only the
lifecycle ones are owner-checked: kanban_show, kanban_attachments, and kanban_comment reach any
task, kanban_create takes any assignee, and every tool takes a board (tools/kanban_tools.py:83-102,
:225-239, :1183-1204; tools/kanban_tools_schemas.py). A completion's artifacts, and any workspace
path its summary or result mentions, are copied into the task's attachments and uploaded into the
Slack thread that asked, as is any other host file the summary or result names that the media
policy allows, such as another task's attachment or a cached upload (hermes_cli/kanban_db.py:
2894-2905, :2967-3075; gateway/kanban_watchers.py:146-200; gateway/platforms/base.py:836-858).

This plugin registers one pre_tool_call hook (hermes_cli/plugins.py:1852-1906). For a kanban_* tool
it allows only kanban_show, kanban_attachments, kanban_heartbeat, kanban_comment, kanban_block, and
kanban_complete, each on the worker's own task (HERMES_KANBAN_TASK) and the default board, and
blocks every other one. It rewrites kanban_complete so it names no workspace path and carries no
file, except the deliverables a worker in DELIVERABLES declares: those must be regular files of an
allowed type inside the task's workspace, and their completion leads with a fixed line, because the
first summary line reaches later tasks' prompts (hermes_cli/kanban_db.py:4150-4170). It refuses a
summary or result that names any other existing host file, and requires a summary that fits
handoff_result. A worker without deliverables reports in the summary alone, so its summary needs a
headline line and at least one line of analysis: a task completes once, and a later
kanban_complete is refused, so a stub summary such as "placeholder" would be all the thread ever
gets.

Every Kanban worker ships this same file. A worker's terminal and file tools run on the host with
the task's workspace as their working directory (hermes_cli/kanban_db_dispatch.py:2830-2838), so
the guard rewrites the workspace's absolute path in a completion's text to a relative one: Hermes
attaches only files named by an absolute workspace path (hermes_cli/kanban_db.py:2970-2985).

Hermes ignores a hook that raises (model_tools.py:775-787), so every error here blocks the call
instead. Other tools pass untouched.
"""

import os
from pathlib import Path
import re

TASK_ID = re.compile(r"t_[0-9a-f]{8}")
OWN_TASK_TOOLS = {
    "kanban_attachments", "kanban_block", "kanban_comment", "kanban_complete", "kanban_heartbeat",
    "kanban_show",
}
# myagent-handoff's handoff_result returns at most 4 KiB of the summary; the first line becomes the
# status line in the thread (gateway/kanban_watchers_notifier.py:378-387).
MAX_SUMMARY_BYTES = 3800
TEXT_FIELDS = ("summary", "result", "reason", "body")
# Workers whose completion carries files, by profile (the name of HERMES_HOME): the allowed
# suffixes, how many files and how large, and the fixed first summary line.
DELIVERABLES = {
    "myagent-writer": {
        "suffixes": (".md",),
        "max_files": 1,
        "max_bytes": 1024 * 1024,
        "headline": "Document written; the Markdown file is attached below.",
    },
}
# A host path in text, absolute or home-relative, as the notifier's extractor finds one
# (gateway/platforms/base.py:3283-3313).
HOST_PATH = re.compile(r"(?<![\w.:/])~?/[^\s`\"'<>|]+")


def _block(message: str) -> dict:
    return {"action": "block", "message": f"myagent-worker-guard: {message}"}


def _scrub(value, workspace: str):
    """Make paths inside the workspace relative to it, so Hermes finds no deliverable path in the
    text."""
    root = workspace.rstrip("/")
    if isinstance(value, str) and root:
        return value.replace(root + "/", "").replace(root, ".")
    return value


def _named_host_file(text) -> str | None:
    """The first existing host file a text names, which the notifier would upload."""
    if not isinstance(text, str):
        return None
    for match in HOST_PATH.finditer(text):
        candidate = os.path.expanduser(match.group(0).rstrip(".,;:!?)]}"))
        if os.path.isfile(candidate):
            return candidate
    return None


def _deliverables(args: dict, rule: dict, workspace: str):
    """The completion's files as host paths inside the workspace, or a block."""
    raw = args.get("artifacts") or []
    if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
        return _block("artifacts must be a list of file paths.")
    if not raw or len(raw) > rule["max_files"]:
        return _block(
            f"attach the rendered files: one to {rule['max_files']} artifacts in the task's "
            f"workspace, of type {', '.join(rule['suffixes'])}."
        )
    root = os.path.realpath(workspace)
    paths = []
    for item in raw:
        # A relative path is relative to the workspace, the worker's working directory.
        path = os.path.join(workspace, item.strip())
        resolved = os.path.realpath(path)
        if (
            resolved == root
            or os.path.commonpath([resolved, root]) != root
            or not os.path.isfile(resolved)
            or os.path.splitext(resolved)[1].lower() not in rule["suffixes"]
            or os.path.getsize(resolved) > rule["max_bytes"]
            or resolved in paths
        ):
            return _block(
                f"{item} is not a {' or '.join(rule['suffixes'])} file of at most "
                f"{rule['max_bytes'] // (1024 * 1024)} MiB in the task's workspace."
            )
        paths.append(resolved)
    return paths


def decide(tool_name: str, args, environ) -> dict | None:
    task = environ.get("HERMES_KANBAN_TASK", "")
    in_task = bool(TASK_ID.fullmatch(task))
    if not isinstance(tool_name, str) or not tool_name.startswith("kanban_"):
        return None
    if not in_task:
        return _block("Kanban tools work only inside this worker's own task.")
    if tool_name not in OWN_TASK_TOOLS:
        return _block(
            f"{tool_name} is not available to this worker. Finish the task with kanban_complete, "
            "or stop with kanban_block."
        )
    if not isinstance(args, dict):
        return _block("the call has no arguments object.")
    if args.get("board") not in (None, "", "default"):
        return _block("this worker uses the default board only.")
    if args.get("task_id") not in (None, "", task):
        return _block(f"this worker may touch only its own task, {task}.")
    workspace = environ.get("HERMES_KANBAN_WORKSPACE", "")
    changes = {
        field: _scrub(args[field], workspace)
        for field in TEXT_FIELDS
        if field in args and _scrub(args[field], workspace) != args[field]
    }
    if tool_name == "kanban_complete":
        texts = {field: changes.get(field, args.get(field)) for field in ("summary", "result")}
        for field, text in texts.items():
            named = _named_host_file(text)
            if named is not None:
                return _block(f"the {field} names the host file {named}; attach files only as artifacts.")
        summary = texts["summary"]
        if not isinstance(summary, str) or not summary.strip():
            return _block("kanban_complete needs a summary: a headline line, then the analysis.")
        rule = DELIVERABLES.get(Path(environ.get("HERMES_HOME", "")).name)
        artifacts = []
        if rule is None:
            if len([line for line in summary.splitlines() if line.strip()]) < 2:
                return _block(
                    "the summary is the whole result: write the headline line, then the analysis "
                    "on the lines below it."
                )
        else:
            if not os.path.isabs(workspace) or not os.path.isdir(workspace):
                return _block("this task has no workspace to take files from.")
            artifacts = _deliverables(args, rule, workspace)
            if isinstance(artifacts, dict):
                return artifacts
            summary = f"{rule['headline']}\n{summary}"
            changes["summary"] = summary
        if len(summary.encode("utf-8")) > MAX_SUMMARY_BYTES:
            return _block(f"the summary is longer than {MAX_SUMMARY_BYTES} bytes; shorten it.")
        metadata = args.get("metadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        changes.update({
            "artifacts": artifacts,
            "created_cards": [],
            "metadata": {key: value for key, value in metadata.items() if key != "artifacts"},
        })
    return {"action": "modify", "args": changes} if changes else None


def pre_tool_call(tool_name="", args=None, **_kwargs):
    try:
        return decide(tool_name, args, os.environ)
    except Exception:  # noqa: BLE001 - Hermes would ignore a raising hook and run the call
        if isinstance(tool_name, str) and tool_name.startswith("kanban_"):
            return _block("the guard failed, so the call was blocked.")
        return None


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
