# Foundations

A foundation is a contract change a capability needs, landed before the capability. The starter
fleet already carries the foundations Dodo (Derek's repository) built; their rules are in the
shared validator and their data in the fleet policy:

| Foundation | What it gives a capability |
|---|---|
| Cron in the fleet | Reviewed `no_agent` and model jobs in `cron/jobs.json`, only in profiles without Slack ingress |
| MCP server contract | Exact URLs and tool lists in `policy.mcp_servers`, pinned credentials, no egress next to private data |
| Outbound-only Slack | `gateway: slack_outbound`: a profile that posts to Slack and that nobody can message |
| Runtime credentials | Credential names in `runtime_env` and `policy.credentials`; values only on the host |
| Brokered credentials | Short-lived keys a root-owned broker mints (`policy.brokered_credentials`; Dodo's mints a GitHub read token) |
| Run limits | Turn caps on every profile and a time budget on Slack gateways |
| Code execution | `terminal`, `file`, and `code_execution` only where no teammate can message |
| Deterministic hand-off | Typed Kanban hand-off tools built by code, workers kept on their task by a guard |

Write a new foundation here as `f<n>-<name>.md` when a capability needs a kind of rule the
validator does not have yet. Land the rule in Dodo first, generically, then copy the validator.
