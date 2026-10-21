# myagent-writer

An example Kanban worker. It turns a Slack thread into a Markdown document and returns it to the
thread that asked.

| | |
|---|---|
| Who can reach it | Nobody directly: only Kanban tasks from `myagent-slack`'s `handoff_document`. |
| Tools | CLI (the surface Kanban workers run on): `skills`, `todo`, `file`. No `terminal`, `web`, MCP servers, or Slack. |
| Plugin | `myagent-worker-guard`: keeps the Kanban tools on this worker's own task and admits only `.md` deliverables from its workspace. |
| Credentials | None but its model key. |
| Limits | 30 turns; the hand-off fixes a 900-second task runtime and one retry (`workers.json`). |

Copy this profile for every new worker. A worker that needs a shell adds `terminal` here; a worker
that needs a credential declares it in `runtime_env`. Neither belongs on `myagent-slack`.
