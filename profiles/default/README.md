# default

The Hermes launch profile, stored directly in Hermes's home. It is not installed like the named
profiles; the reconciler rewrites its reviewed `SOUL.md` and the owned fields of `config.yaml`.

It holds the host-wide settings Hermes reads only from the launch profile:

- the Slack admin list and the commands non-admins may run (`slack.*`);
- the gateway session cap (`max_concurrent_sessions`) and `timezone`;
- the Kanban dispatcher (`kanban.dispatch_profiles`), which must list exactly the worker profiles.

It declares no `runtime_env`: its only secret is the model provider key, set on the host.
