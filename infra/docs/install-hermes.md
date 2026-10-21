# Install and recover Hermes Agent for MyAgent

This runbook installs the Hermes Agent that powers MyAgent on its host. It follows Dodo's runbook
(Derek's repository), with the cloud-specific steps left to you as TODO. It starts after your
infrastructure has created the host and keeps application deployment separate from infrastructure
deployment.

## Deployment contract

TODO: record your host's facts here: account and region, how the host is reached, the dashboard URL
and how browsers authenticate to it, and where the persistent Hermes home lives. Dodo's host is a
private EC2 instance with a separate persistent volume mounted at `/var/lib/hermes`, a dashboard
behind a load balancer with OIDC, and no SSH.

- Persistent Hermes home: `/var/lib/hermes`
- Service manager: systemd user units `hermes-dashboard.service` and `hermes-gateway.service`
- The reconciler and the validator bundle are installed by your infrastructure, by hash
  ([deployment](deploy-profiles.md#normal-deployment)).

## Security and recovery facts

- Never continue installation unless `/var/lib/hermes` is the persistent filesystem. Otherwise
  Hermes state would be written to a replaceable disk.
- Every profile's `.env`, OAuth credential files, and provider credentials are runtime secrets.
  Never commit or paste their values.
- Every credential a profile holds besides its model key is declared by name in
  `profiles/fleet.yaml` and in its `policy.credentials`
  ([runtime credentials](deploy-profiles.md#runtime-credentials)). TODO: give each one a recovery
  or rotation source (Dodo keeps an empty secret container per credential that an operator fills).
- All profiles run as the `hermes` account, so a profile with a `terminal` toolset can read every
  other profile's `.env`. Only the owner console and Kanban workers run code. That injected input
  could leak a credential this way is an accepted risk
  ([code execution](deploy-profiles.md#code-execution)).
- Root never runs Python from the `hermes`-owned Hermes venv, and never follows a path inside
  `/var/lib/hermes` as root.
- Never run `chown -R` over `/var/lib/hermes`: the `.dodo-deployment` tree inside it belongs to root
  and the reconciler, and `hermes` must not own it.

## 1. Prepare the host

TODO: in your host bootstrap, create the `hermes` account with home `/var/lib/hermes`, mount the
persistent volume there, and install as root:

- the system packages Hermes needs (`build-essential curl git jq libffi-dev python3-dev ripgrep
  xz-utils`, plus `docker.io` if a profile uses it) and `python3-yaml` for the reconciler;
- a root-owned `bun`, pinned by version and SHA-256, at the path templated into the reconciler as
  `__AGENT_BUN_PATH__`. The reconciler runs the validator bundle with it, as root.

## 2. Install Hermes as the Hermes user

```sh
sudo -iu hermes
HERMES_INSTALLER="$(mktemp /tmp/hermes-install.XXXXXX)"
curl -fsSL https://hermes-agent.nousresearch.com/install.sh -o "${HERMES_INSTALLER:?}"
test -s "${HERMES_INSTALLER:?}"
bash "${HERMES_INSTALLER:?}" --skip-setup --non-interactive
source ~/.bashrc
hermes --version
hermes doctor --fix
```

Expected paths: launcher `/var/lib/hermes/.local/bin/hermes`, managed checkout
`/var/lib/hermes/.hermes/hermes-agent`, configuration and state `/var/lib/hermes/.hermes`.

## 3. Configure inference

Use `hermes setup`, `hermes model`, or the supported authentication flow for your provider. Do not
record the provider or its credentials in this repository. Prove a real response:

```sh
hermes chat -q 'Reply with exactly: MYAGENT_MODEL_OK'
```

## 4. Install the dashboard as a user service

```sh
exit
loginctl enable-linger hermes
sudo -iu hermes
install -d -m 0700 ~/.config/systemd/user
cat >~/.config/systemd/user/hermes-dashboard.service <<'EOF'
[Unit]
Description=Hermes Agent dashboard
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/var/lib/hermes
Environment=HOME=/var/lib/hermes
Environment=HERMES_HOME=/var/lib/hermes/.hermes
Environment=PATH=/var/lib/hermes/.local/bin:/var/lib/hermes/.hermes/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-/var/lib/hermes/.hermes/.env
ExecStart=/var/lib/hermes/.local/bin/hermes dashboard --host 127.0.0.1 --port 9119 --no-open
Restart=always
RestartSec=5
RestartPreventExitStatus=78
KillMode=mixed
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
EOF
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
systemctl --user daemon-reload
systemctl --user enable --now hermes-dashboard.service
```

TODO: expose the dashboard only behind your authentication. Its **Chat** tab runs `!command` as
`hermes`, so only owners may reach it.

## 5. Deploy the fleet

Run your [deployment](deploy-profiles.md#normal-deployment) once, so every reviewed profile and its
Slack allowlist exists before any Slack token does.

## 6. Connect Slack

1. Create one Slack app per `gateway: slack` profile (the team's and the owner's). Generate the
   manifest with the profile's own Hermes (`hermes -p <profile> slack manifest --agent-view
   --write`) and review its scopes. Socket Mode is required.
2. As `hermes`, add exactly `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` to
   `~/.hermes/profiles/<profile>/.env`, then `chmod 0600` it. Never put `SLACK_ALLOWED_USERS` or any
   other `SLACK_*` policy key there: the reconciler refuses to deploy while one exists.
3. Install the gateway: `hermes gateway install`, then check `systemctl --user is-active
   hermes-gateway.service`.
4. For `myagent-scheduled` (`gateway: slack_outbound`), add the team app's bot token as
   `SLACK_BOT_TOKEN` and again as `MYAGENT_SLACK_BOT_TOKEN` (its script copy). Never add
   `SLACK_APP_TOKEN` there.
5. Prove the boundary, not just the connection: an allowed user gets a reply; a user outside the
   allowlist gets no reply and no reaction; the owner's app ignores a mention in a channel.

## 7. Set capability keys

For every `runtime_env` name, set the value in the dashboard (profile switcher → **API Keys**), then
run the deployment again so the host checks confirm it. Use scoped service keys, never interactive
OAuth grants.

## Operate and update

Before moving to a new Hermes release, update the validator from Dodo (it holds the release's
toolset names) and merge that first. Then run the update as `hermes` and deploy again:

```sh
hermes update --check
hermes update
hermes --version
```

`hermes update` restarts the dashboard but not the gateway; restart the gateway after the following
deployment.

## Upstream references

- [Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation)
- [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration)
