# Accepted risks

Safety here is a list of decisions with an owner and a reason, not a promise of zero risk. Each
entry names the rule it relaxes, why, the controls that remain, and who accepted it. Review the list
whenever a capability changes.

The entries below are the template's defaults. Keep, change, or remove each one deliberately.

## Team profile writes issues without an approval click

- **Relaxes:** profiles people can message hold no write credentials.
- **Why:** approval prompts flood threads, and filing issues from a thread is the most useful thing
  a team agent does.
- **Controls:** the user allowlist; the policy's Linear `writes` are exactly `save_issue` and `save_comment`, for `myagent-slack` only;
  no delete tools anywhere; a key scoped to one team; the skill reports every write in the thread.
- **Accepted by:** &lt;owner&gt;, &lt;date&gt;.

## Workers run on the host without a container

- **Relaxes:** defence in depth for code execution.
- **Why:** a container, image registry, and egress proxy add infrastructure and rollout steps for
  little gain while no teammate can message a worker.
- **Controls:** a shell (`terminal`, `code_execution`) only on profiles no teammate can message;
  the worker guard keeps each worker on its own task; turn and time caps. A worker shell can read
  other profiles' `.env` files on the same host.
- **Accepted by:** &lt;owner&gt;, &lt;date&gt;.

## The dashboard opens every profile

- **Relaxes:** nothing in the fleet; it is a property of Hermes's dashboard.
- **Why:** operators need it.
- **Controls:** the dashboard's sign-in group stays owners-only. It shows every transcript,
  including teammates' conversations, and can run shell commands as the Hermes user.
- **Accepted by:** &lt;owner&gt;, &lt;date&gt;.

## Personal data may appear in answers about errors

- **Relaxes:** nothing enforceable in config.
- **Why:** error payloads can carry emails, names, and IP addresses.
- **Controls:** the skill tells the agent to leave them out; link unfurling is off; the channel
  allowlist decides who can see answers.
- **Accepted by:** &lt;owner&gt;, &lt;date&gt;.
