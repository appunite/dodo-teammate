#!/usr/bin/env bash

# -E (errtrace) makes the ERR trap fire for failures inside functions. Nearly every host action
# runs in a function, so without it a failed step exits without restoring the previous state.
set -Eeuo pipefail

umask 077

# Your deployment passes the revision (a full commit SHA), then the fleet validator bundle it
# downloaded and checked against its SHA-256 (validate_release). Install this script and the bundle
# through your infrastructure tooling, by hash, never from the release they check: Dodo uploads both
# to S3 under their SHA-256 and an SSM document fetches, checks, and runs them.
readonly REQUESTED_REVISION="${1:-}"
readonly FLEET_VALIDATOR="${2:-}"
# TODO: a root-owned bun, pinned by version and SHA-256, that your host bootstrap installs (Dodo
# installs it under /opt/dodo/release-tools).
readonly FLEET_VALIDATOR_BUN="__AGENT_BUN_PATH__"
# The agent's repository, kept as a read-only mirror. How git authenticates is a TODO below.
readonly AGENT_REPOSITORY="__AGENT_REPOSITORY_URL__"
# Optional: a team repository of shared skills that profiles select in raven_skills (Raven is the
# one Dodo uses). Leave it empty to disable; a fleet that selects raven_skills is then refused.
readonly RAVEN_REPOSITORY="__AGENT_SKILLS_REPOSITORY_URL__"
readonly DEPLOY_ROOT="/var/lib/hermes/.dodo-deployment"
readonly AGENT_MIRROR="${DEPLOY_ROOT}/repository.git"
readonly RAVEN_CHECKOUT="${DEPLOY_ROOT}/raven"
readonly DODO_SKILLS_ROOT="${DEPLOY_ROOT}/dodo-skills"
readonly RAVEN_SKILLS_ROOT="${DEPLOY_ROOT}/raven-skills"
readonly HERMES_SKILLS_ROOT="${DEPLOY_ROOT}/hermes-skills"
readonly RETIRED_PROFILE_SKILLS_ROOT="${DEPLOY_ROOT}/retired-profile-skills"
readonly RELEASES_ROOT="${DEPLOY_ROOT}/releases"
readonly CURRENT_LINK="${DEPLOY_ROOT}/current"
readonly DEPLOYED_REVISION_FILE="${DEPLOY_ROOT}/deployed-revision"
readonly HERMES_HOME="/var/lib/hermes"
readonly DEFAULT_PROFILE_HOME="${HERMES_HOME}/.hermes"
readonly HERMES_BIN="${HERMES_HOME}/.local/bin/hermes"
readonly HERMES_PYTHON="${HERMES_HOME}/.hermes/hermes-agent/venv/bin/python"
# hermes owns the Hermes venv, so a planted sitecustomize.py or .pth file there would run as root.
# Python that runs as root uses the system interpreter in isolated mode (-I: no user site, no
# PYTHON* variables, no script directory on sys.path); the venv runs only through run_as_hermes.
readonly SYSTEM_PYTHON="/usr/bin/python3"
readonly HERMES_SOURCE="${HERMES_HOME}/.hermes/hermes-agent"
readonly HERMES_BUNDLED_SKILLS_ROOT="${HERMES_SOURCE}/skills"
readonly PROFILE_ROOT="${DEFAULT_PROFILE_HOME}/profiles"
# Space-separated refs a deployable revision must be reachable from, such as refs/heads/main.
readonly ALLOWED_REFS="__AGENT_ALLOWED_REFS__"

rollback_armed=false
declared_profiles=()
all_profiles=()
default_backup=""
profile_skills_backup=""

log() {
  printf '[dodo-profile-reconciler] %s\n' "$*"
}

fail() {
  printf '[dodo-profile-reconciler] ERROR: %s\n' "$*" >&2
  if test "${rollback_armed}" = true; then
    rollback_profiles "${old_release}" "${previous_raven_skills}" "${newly_installed[@]}"
  fi
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

run_as_hermes() {
  sudo -iu hermes env \
    HOME="${HERMES_HOME}" \
    PATH="${HERMES_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    "$@"
}

profile_home() {
  local profile="$1"

  if test "${profile}" = default; then
    printf '%s\n' "${DEFAULT_PROFILE_HOME}"
  else
    printf '%s\n' "${PROFILE_ROOT}/${profile}"
  fi
}

fleet_manifest_path() {
  local release="$1"

  if test -f "${release}/profiles/fleet.yaml"; then
    printf '%s\n' "${release}/profiles/fleet.yaml"
  elif test -f "${release}/profiles/fleet.json"; then
    printf '%s\n' "${release}/profiles/fleet.json"
  else
    fail "Revision contains neither profiles/fleet.yaml nor the legacy profiles/fleet.json."
  fi
}

set_distribution_source() {
  local profile="$1"
  local source="$2"
  local manifest="${PROFILE_ROOT}/${profile}/distribution.yaml"

  test -f "${manifest}" || fail "Installed profile ${profile} has no distribution manifest."
  # Parse rather than edit lines: a line-based edit leaves a wrapped or multi-line value behind,
  # which Hermes then reads as one source string joined with a space.
  run_as_hermes "${HERMES_PYTHON}" - "${manifest}" "${source}" <<'PYTHON'
import os
from pathlib import Path
import stat
import sys
import tempfile

import yaml

manifest = Path(sys.argv[1])
source = sys.argv[2]
data = yaml.safe_load(manifest.read_text(encoding="utf-8"))
if not isinstance(data, dict):
    raise SystemExit(f"Distribution manifest is not a mapping: {manifest}")
previous = data.get("source")
if previous is not None and not (isinstance(previous, str) and Path(previous).is_dir()):
    print(
        f"[dodo-profile-reconciler] {manifest.parent.name}: replacing unusable distribution "
        f"source {previous!r}",
        file=sys.stderr,
    )
data["source"] = source
mode = stat.S_IMODE(manifest.stat().st_mode)
descriptor, temporary = tempfile.mkstemp(prefix=".distribution.", dir=manifest.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        yaml.safe_dump(data, output, sort_keys=False, default_flow_style=False, allow_unicode=True)
    os.chmod(temporary, mode)
    os.replace(temporary, manifest)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PYTHON
}

reconcile_profile_config() {
  local profile="$1"
  local release="$2"
  local source_config="${release}/profiles/${profile}/config.yaml"
  local installed_config
  local fleet

  installed_config="$(profile_home "${profile}")/config.yaml"
  fleet="$(fleet_manifest_path "${release}")"
  test -f "${source_config}" || fail "Release profile ${profile} has no config.yaml."
  test -f "${installed_config}" || fail "Installed profile ${profile} has no config.yaml."

  run_as_hermes "${HERMES_PYTHON}" - \
    "${source_config}" "${installed_config}" "${HERMES_SOURCE}" "${fleet}" "${profile}" <<'PYTHON'
import copy
import os
from pathlib import Path
import stat
import sys
import tempfile

import yaml

source_path = Path(sys.argv[1])
installed_path = Path(sys.argv[2])
hermes_source = sys.argv[3]
# The release's fleet manifest (YAML, or the legacy JSON, which YAML also reads).
fleet = yaml.safe_load(Path(sys.argv[4]).read_text(encoding="utf-8"))
profile_name = sys.argv[5]
source = yaml.safe_load(source_path.read_text(encoding="utf-8"))
installed = yaml.safe_load(installed_path.read_text(encoding="utf-8"))
if not isinstance(installed, dict):
    raise SystemExit(f"Installed profile config is not a mapping: {installed_path}")
if not isinstance(source, dict):
    raise SystemExit(f"Release profile config is not a mapping: {source_path}")

if set(source) == {"security", "skills"}:
    # Backward-compatible rollback path for releases using fleet schema 2.
    installed["security"] = copy.deepcopy(source["security"])
    installed_skills = installed.setdefault("skills", {})
    if not isinstance(installed_skills, dict):
        raise SystemExit(f"Installed profile skills config is not a mapping: {installed_path}")
    installed_skills["external_dirs"] = copy.deepcopy(source["skills"]["external_dirs"])
else:
    expected = {"agent", "mcp_servers", "platform_toolsets", "security", "skills", "terminal"}
    # Slack gateway profiles also own approvals, memory and slack, and an outbound-only profile with
    # Slack targets owns a slack block that switches link previews off; the default profile owns the
    # host-wide Slack policy and session cap that Hermes reads only from the launch profile.
    # Profiles that ship cron jobs own approvals and timezone, and may own a cron block that
    # switches off Hermes's delivery wrapper (removed again when a release drops it). The default's
    # timezone is pinned too. Plugins are owned on every profile, as are the dispatcher's kanban
    # block on the default profile, approvals on Kanban workers, and the hand-off profile's gateway
    # media policy. A release without kanban leaves the installed block alone: an absent
    # dispatch_profiles lets the dispatcher claim a task for any profile.
    optional = {
        "approvals", "cron", "delegation", "gateway", "kanban", "max_concurrent_sessions",
        "memory", "plugins", "slack", "timezone",
    }
    if not expected.issubset(source) or not set(source).issubset(expected | optional):
        raise SystemExit(f"Release profile config violates the Dodo-owned field contract: {source_path}")
    for key in source:
        installed[key] = copy.deepcopy(source[key])
    if "slack" not in source:
        # A profile that no longer declares Slack policy must not keep a stale allowlist.
        installed.pop("slack", None)
    if "delegation" not in source:
        # A profile that no longer delegates must not keep a stale model pin or caps.
        installed.pop("delegation", None)
    if "cron" not in source:
        # A profile that no longer switches off the cron delivery wrapper gets Hermes's default back.
        installed.pop("cron", None)

    installed_skills = installed["skills"]
    installed_skills["disabled"] = []
    installed_skills["platform_disabled"] = {}
    installed_skills["write_approval"] = True

    os.environ["HERMES_HOME"] = str(installed_path.parent)
    sys.path.insert(0, hermes_source)
    from hermes_cli.tools_config import CONFIGURABLE_TOOLSETS, _get_plugin_toolset_keys
    from toolsets import TOOLSETS

    platforms = list(source["platform_toolsets"])
    builtin_toolsets = sorted(item[0] for item in CONFIGURABLE_TOOLSETS)
    # Discovery reads the plugins.enabled already on disk (hermes_cli/plugins.py:1683-1723), so on
    # a plugin's first deployment it misses that plugin's toolset, which Hermes would then switch on
    # for every platform. Add every toolset the fleet declares, and the bundled ones, too.
    declared_profiles = [
        fleet.get("default_profile") or fleet.get("defaultProfile") or {}, *fleet.get("profiles", [])
    ]
    # A worker's hook plugin (its guard) registers no toolset.
    fleet_plugin_toolsets = {
        plugin["toolset"]
        for declared in declared_profiles
        for plugin in (declared.get("plugins") or {}).values()
        if "toolset" in plugin
    }
    plugin_toolsets = sorted(
        set(_get_plugin_toolset_keys()) | fleet_plugin_toolsets | {"a2a", "google_meet", "spotify"}
    )
    # A job worker gets no Kanban tools: its script, not a model, takes its tasks.
    is_kanban_worker = any(
        declared.get("name") == profile_name
        and declared.get("kanban_worker") not in (None, False)
        and "job" not in declared["kanban_worker"]
        for declared in declared_profiles
    )
    enabled_toolsets = {
        toolset
        for selected in source["platform_toolsets"].values()
        for toolset in selected
    }
    installed_leaf_toolsets = {
        name
        for name, definition in TOOLSETS.items()
        if not name.startswith("hermes-")
        and not definition.get("includes")
        and not definition.get("posture")
    }
    disabled_toolsets = (
        set(source["agent"]["disabled_toolsets"])
        | (installed_leaf_toolsets - enabled_toolsets)
        | (set(plugin_toolsets) - enabled_toolsets)
    )
    # A Kanban worker needs the kanban tools the dispatcher adds; the CLI subtracts this list last.
    if is_kanban_worker:
        disabled_toolsets.discard("kanban")
    installed["agent"]["disabled_toolsets"] = sorted(disabled_toolsets)
    installed["known_builtin_toolsets"] = {
        platform: builtin_toolsets for platform in platforms
    }
    installed["known_plugin_toolsets"] = {
        platform: plugin_toolsets for platform in platforms
    }

mode = stat.S_IMODE(installed_path.stat().st_mode)
descriptor, temporary = tempfile.mkstemp(prefix=".config.", dir=installed_path.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        yaml.safe_dump(installed, output, sort_keys=False, allow_unicode=True)
    os.chmod(temporary, mode)
    os.replace(temporary, installed_path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PYTHON
}

# A leftover .*-skills.previous directory means an earlier run swapped views and then exited
# without finishing or rolling back. The views are derived entirely from Git sources and rebuilt by
# this run, so keep the leftover for diagnosis in the retired area instead of refusing to deploy.
retire_interrupted_view() {
  local previous="$1"
  local target

  test -e "${previous}" || return 0
  target="${RETIRED_PROFILE_SKILLS_ROOT}/interrupted${previous##*/}.$(date -u +%Y%m%dT%H%M%SZ)"
  test ! -e "${target}" || fail "Cannot retire ${previous}: ${target} already exists."
  log "An earlier reconciliation was interrupted mid-swap; retiring ${previous} to ${target}."
  mv "${previous}" "${target}"
}

prepare_profile_skill_boundary() {
  local profile="$1"
  local home
  local backup_home="${profile_skills_backup}/${profile}"

  home="$(profile_home "${profile}")"
  test -d "${home}" || fail "Profile ${profile} has no Hermes home."
  install -d -o root -g hermes -m 0750 "${backup_home}"
  if test -d "${home}/skills"; then
    mv "${home}/skills" "${backup_home}/skills"
  fi
  if test -e "${home}/.no-bundled-skills"; then
    : >"${backup_home}/marker-existed"
  fi
  # hermes owns the profile home, and install -d would follow a symlink planted at skills. mkdir
  # fails on any existing path instead, and chown -h never dereferences.
  mkdir -m 0550 "${home}/skills"
  chown -h root:hermes "${home}/skills"
  install -o root -g hermes -m 0440 /dev/null "${home}/.no-bundled-skills"
}

reconcile_default_profile() {
  local release="$1"
  local source_soul="${release}/profiles/default/SOUL.md"
  local installed_soul="${DEFAULT_PROFILE_HOME}/SOUL.md"

  test -f "${source_soul}" || fail "Release default profile has no SOUL.md."
  test -f "${installed_soul}" || fail "Installed default profile has no SOUL.md."

  run_as_hermes "${HERMES_PYTHON}" - "${source_soul}" "${installed_soul}" <<'PYTHON'
import os
from pathlib import Path
import stat
import sys
import tempfile

source_path = Path(sys.argv[1])
installed_path = Path(sys.argv[2])
mode = stat.S_IMODE(installed_path.stat().st_mode)
descriptor, temporary = tempfile.mkstemp(prefix=".SOUL.", dir=installed_path.parent)
try:
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(source_path.read_text(encoding="utf-8"))
    os.chmod(temporary, mode)
    os.replace(temporary, installed_path)
except BaseException:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    raise
PYTHON

  reconcile_profile_config default "${release}"
}

# The fleet contract is infra/src/validate-fleet.ts, the same code CI runs. `mise run
# build-validator` bundles it, your deployment installs the bundle by hash and passes it here. It runs as root
# under the bootstrap's root-owned, pinned bun, from an empty directory with a minimal environment,
# so no .env, bunfig.toml, or auto-install can change what runs.
validate_release() {
  local release="$1"
  local work
  local status=0

  test -z "$(find "${release}" -type l -print -quit)" || fail "Revision contains a symlink."
  work="$(mktemp -d)"
  (
    cd "${work}" &&
      env -i PATH=/usr/bin:/bin HOME="${work}" \
        "${FLEET_VALIDATOR_BUN}" --no-install --no-env-file "${FLEET_VALIDATOR}" \
        --root="${release}" --python="${SYSTEM_PYTHON}"
  ) || status=$?
  rm -rf -- "${work}"
  test "${status}" -eq 0 || fail "Revision does not satisfy the fleet contract; nothing was changed."
}

# Runtime state can widen Slack access past the reviewed config: environment overrides win over
# config.yaml, pairing approvals bypass allow_from, an undeclared bot token adds an ingress, and an
# app token opens Socket Mode for a profile declared outbound-only. Inspect key names and grant files,
# and compare an outbound profile's two copies of its bot token; never print a value.
verify_slack_runtime_boundary() {
  local fleet_json="$1"

  "${SYSTEM_PYTHON}" -I - "${fleet_json}" "${DEFAULT_PROFILE_HOME}" "${PROFILE_ROOT}" <<'PYTHON'
import codecs
import json
from pathlib import Path
import re
import sys

import yaml

fleet = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
default_home = Path(sys.argv[2])
profile_root = Path(sys.argv[3])
declared = [fleet.get("default_profile") or fleet.get("defaultProfile") or {}, *fleet["profiles"]]
slack_gateways = {profile["name"] for profile in declared if profile.get("gateway") == "slack"}
# Outbound-only profiles (schema 5) hold the bot token for delivery and never the app token, without
# which Hermes cannot open Socket Mode (plugins/platforms/slack/adapter.py:1771-1783).
slack_outbound = {
    profile["name"] for profile in declared if profile.get("gateway") == "slack_outbound"
}
# The script copies of Slack keys, declared in a profile's runtime_env (the fleet policy's
# credentials with copy_of).
policy_credentials = (fleet.get("policy") or {}).get("credentials") or {}
script_copies = {
    name: entry["copy_of"] for name, entry in policy_credentials.items() if entry.get("copy_of")
}
homes = {"default": default_home}
if profile_root.is_dir():
    homes.update({path.name: path for path in profile_root.iterdir() if path.is_dir()})
token_keys = {"SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"}
delivery_keys = {"SLACK_HOME_CHANNEL", "SLACK_HOME_CHANNEL_NAME"}
problems = []


def mapping(value):
    return value if isinstance(value, dict) else {}


# Hermes reads .env with python-dotenv for the launch profile and with agent/secret_scope.py
# load_env_file for routed profiles; both strip a BOM, and they accept quoted or non-identifier
# keys. Read only plain KEY=value lines, and report every other non-blank, non-comment line, so no
# key Hermes loads goes unseen. Keep in step with the copy in verify_runtime_credentials.
assignment = re.compile(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)")


def read_env(path):
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.removeprefix(codecs.BOM_UTF8).decode("latin-1")
    values = {}
    unreadable = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.strip().startswith("#"):
            continue
        match = assignment.match(line)
        if match:
            values[match.group(1)] = match.group(2).split(" #", 1)[0].strip().strip("'\"")
        else:
            unreadable.append(number)
    return values, unreadable


for name, home in sorted(homes.items()):
    env_path = home / ".env"
    values = {}
    if env_path.is_file():
        values, unreadable = read_env(env_path)
        for number in unreadable:
            problems.append(f"{name}: .env line {number} is not a plain KEY=value assignment")
    for key in sorted(values):
        if key.startswith("GATEWAY_ALLOW"):
            problems.append(f"{name}: .env sets {key}, which overrides the reviewed allowlist")
        elif key.startswith("SLACK_") and key not in token_keys | delivery_keys:
            problems.append(f"{name}: .env sets {key}, which overrides the reviewed Slack policy")
        elif key == "SLACK_APP_TOKEN" and name not in slack_gateways:
            problems.append(
                f"{name}: .env holds SLACK_APP_TOKEN, which opens Slack ingress, without gateway: slack"
            )
        elif key == "SLACK_BOT_TOKEN" and name not in slack_gateways | slack_outbound:
            problems.append(f"{name}: .env holds SLACK_BOT_TOKEN without a declared Slack gateway")
        # Project plugins win over the reviewed user plugins on a name collision
        # (hermes_cli/plugins_discovery.py:187-190, :196-219), and these relocate the Kanban board,
        # its database, or the dispatcher the hand-off plugin relies on (hermes_cli/kanban_db.py:399-407,
        # :490-510; gateway/kanban_watchers.py:203-251).
        elif key == "HERMES_ENABLE_PROJECT_PLUGINS" or key.startswith("HERMES_KANBAN_"):
            problems.append(f"{name}: .env sets {key}, which bypasses the reviewed plugins or Kanban board")
    # The script copy must be the very token Hermes delivers with, so a script never holds a
    # different app's or a user's token.
    for copy, original in script_copies.items():
        if values.get(copy) and values.get(copy) != values.get(original):
            problems.append(f"{name}: .env {copy} differs from its {original}")

    config_path = home / "config.yaml"
    if config_path.is_file():
        config = mapping(yaml.safe_load(config_path.read_text(encoding="utf-8")))
        gateway = mapping(config.get("gateway"))
        if "allow_all_users" in config or "allow_all_users" in gateway:
            problems.append(f"{name}: config.yaml sets allow_all_users")
        if "slack" in mapping(config.get("platforms")) or "slack" in mapping(gateway.get("platforms")):
            problems.append(f"{name}: config.yaml has a nested Slack block outside Dodo's slack key")
        if config.get("profile_routes") or gateway.get("profile_routes"):
            problems.append(f"{name}: config.yaml declares profile_routes that Dodo does not own")

    for pairing_dir in (home / "platforms" / "pairing", home / "pairing"):
        if not pairing_dir.is_dir():
            continue
        for grant in sorted(pairing_dir.glob("*-approved.json")):
            try:
                granted = json.loads(grant.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                granted = True
            if granted:
                problems.append(f"{name}: {grant.relative_to(home)} grants access outside Dodo")

for problem in problems:
    print(f"[dodo-profile-reconciler] {problem}", file=sys.stderr)
if problems:
    raise SystemExit(1)
PYTHON
}

# Credential names the installed Hermes owns. Model-provider keys may not be declared in
# runtime_env, and those Hermes scrubs from every child process stay runtime-owned and exempt.
# Messaging keys would open another gateway platform, and terminal.env_passthrough drops every
# blocklisted name without failing. Run as hermes in an empty home, because
# importing Hermes populates HERMES_HOME and a user provider plugin there could declare arbitrary
# names as provider keys (hermes_cli/auth_plugin_providers.py:91-104).
write_hermes_credential_names() {
  local output="$1"
  local home="$2"

  run_as_hermes env HERMES_HOME="${home}" "${HERMES_PYTHON}" -I - "${HERMES_SOURCE}" \
    <<'PYTHON' >"${output}"
import json
import sys

sys.path.insert(0, sys.argv[1])
from hermes_cli.auth import PROVIDER_REGISTRY
from hermes_cli.config import OPTIONAL_ENV_VARS
from tools.environments.local_env_policy import (
    _HERMES_PROVIDER_ENV_BLOCKLIST,
    _is_provider_env_blocklisted,
)

provider = {name for config in PROVIDER_REGISTRY.values() for name in config.api_key_env_vars}
provider |= {name for name, meta in OPTIONAL_ENV_VARS.items() if meta.get("category") == "provider"}
# Exempt only what Hermes scrubs from every child process
# (tools/environments/local_env_policy.py:46-96). That drops CLAUDE_CODE_OAUTH_TOKEN, which Hermes
# hands to children on purpose (:78). Copilot claims GH_TOKEN and GITHUB_TOKEN as model keys, but
# they are general GitHub credentials: never exempt them.
exempt = {name for name in provider if _is_provider_env_blocklisted(name)}
exempt -= {"GH_TOKEN", "GITHUB_TOKEN"}
messaging = {name for name, meta in OPTIONAL_ENV_VARS.items() if meta.get("category") == "messaging"}
if not exempt or not messaging:
    raise SystemExit("Hermes reported no model-provider or messaging keys")
print(json.dumps({
    "provider": sorted(provider),
    "exempt": sorted(exempt),
    "messaging": sorted(messaging),
    # Names terminal.env_passthrough silently drops (tools/env_passthrough.py:37-55, :74-115).
    "passthrough_refused": sorted(_HERMES_PROVIDER_ENV_BLOCKLIST),
}))
PYTHON
}

# Every capability credential in a profile's .env must be declared in the reviewed fleet, and every
# declared one must be set. External secret sources and MCP OAuth grants would bypass that
# declaration, and a script credential Hermes would silently drop must fail here instead. Inspect
# key names, file modes, and grant files; never print a value.
verify_runtime_credentials() {
  local fleet_json="$1"
  local hermes_names="$2"
  local release="$3"

  "${SYSTEM_PYTHON}" -I - "${fleet_json}" "${hermes_names}" "${DEFAULT_PROFILE_HOME}" \
    "${PROFILE_ROOT}" "${release}" <<'PYTHON'
import codecs
import json
from pathlib import Path
import pwd
import re
import stat
import sys

import yaml

fleet = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
hermes_names = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
default_home = Path(sys.argv[3])
profile_root = Path(sys.argv[4])
release = Path(sys.argv[5])
hermes_uid = pwd.getpwnam("hermes").pw_uid
provider_keys = set(hermes_names["provider"])
exempt_provider_keys = set(hermes_names["exempt"])
passthrough_refused = set(hermes_names["passthrough_refused"])
messaging_keys = set(hermes_names["messaging"])
declared_by_profile = {
    profile["name"]: set(profile["runtime_env"])
    for profile in [fleet["default_profile"], *fleet["profiles"]]
}
homes = {"default": default_home}
if profile_root.is_dir():
    homes.update({path.name: path for path in profile_root.iterdir() if path.is_dir()})
# Governed by verify_slack_runtime_boundary and the profile's gateway declaration.
slack_token_keys = {"SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"}
# Minted by the root-owned broker, never set by hand: it writes them only into the profiles whose
# brokered_env declares them and removes them from every other .env after a deployment succeeds.
# They are never required here, because the broker writes only to profiles the live release
# declares, and a stale copy in a profile that no longer declares one is removed after this run.
brokered_keys = set((fleet.get("policy") or {}).get("brokered_credentials") or [])
# TODO: the shape of a value your broker mints, so a hand-set value cannot ride along (Dodo's GitHub
# read broker writes installation tokens, `ghs_...`). Anything non-empty is accepted until then.
installation_token = re.compile(r".+")
credential_suffix = re.compile(r".*_(?:TOKEN|KEY|SECRET|PASSWORD)")
# Per-task side-model keys, runtime-owned like the main model key; Hermes scrubs them from every
# child (tools/environments/local_env_policy.py:187-197).
auxiliary_model_key = re.compile(r"AUXILIARY_[A-Z0-9_]+_API_KEY")
problems = []


def mapping(value):
    return value if isinstance(value, dict) else {}


# Hermes reads .env with python-dotenv for the launch profile and with agent/secret_scope.py
# load_env_file for routed profiles; both strip a BOM, and they accept quoted or non-identifier
# keys. Read only plain KEY=value lines, and report every other non-blank, non-comment line, so no
# key Hermes loads goes unseen. Keep in step with the copy in verify_slack_runtime_boundary.
assignment = re.compile(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)")


def read_env(path):
    raw = path.read_bytes()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.removeprefix(codecs.BOM_UTF8).decode("latin-1")
    values = {}
    unreadable = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.strip().startswith("#"):
            continue
        match = assignment.match(line)
        if match:
            values[match.group(1)] = match.group(2).split(" #", 1)[0].strip().strip("'\"")
        else:
            unreadable.append(number)
    return values, unreadable


for name, declared in sorted(declared_by_profile.items()):
    for credential in sorted(declared & provider_keys):
        problems.append(f"{name}: runtime_env {credential} is a Hermes model-provider key")
    for credential in sorted(declared & messaging_keys):
        problems.append(f"{name}: runtime_env {credential} would open a Hermes messaging platform")
    # The release is validated, so env_passthrough is a list of declared names. Hermes drops a
    # blocklisted one with only a warning (tools/env_passthrough.py:74-115), matching case-folded.
    release_config = yaml.safe_load(
        (release / "profiles" / name / "config.yaml").read_text(encoding="utf-8")
    )
    passthrough = mapping(mapping(release_config).get("terminal")).get("env_passthrough") or []
    for credential in sorted(passthrough):
        if credential in passthrough_refused or credential.upper() in passthrough_refused:
            problems.append(
                f"{name}: terminal.env_passthrough {credential} is a key Hermes never passes to scripts"
            )
    if declared and name not in homes:
        print(
            f"[dodo-profile-reconciler] {name}: is installed by this run; set its runtime_env "
            "values, then dispatch the deployment again",
            file=sys.stderr,
        )

for name, home in sorted(homes.items()):
    declared = declared_by_profile.get(name, set())
    env_path = home / ".env"
    values = {}
    if env_path.is_file():
        details = env_path.stat()
        if details.st_uid != hermes_uid or stat.S_IMODE(details.st_mode) & 0o077:
            problems.append(f"{name}: .env must be 0600 and owned by hermes")
        values, unreadable = read_env(env_path)
        for number in unreadable:
            problems.append(f"{name}: .env line {number} is not a plain KEY=value assignment")
    for key in sorted(values):
        if key in brokered_keys:
            # A value the broker did not write, such as a personal access token, must not ride along.
            if not installation_token.fullmatch(values[key]):
                problems.append(
                    f"{name}: .env {key} is not a value the broker writes; only the broker sets it"
                )
            continue
        if (
            credential_suffix.fullmatch(key.upper())
            and key not in declared
            and key not in exempt_provider_keys
            and key not in slack_token_keys
            and not auxiliary_model_key.fullmatch(key)
        ):
            problems.append(
                f"{name}: .env holds {key}, which profiles/fleet.yaml does not declare in runtime_env"
            )
    for credential in sorted(declared):
        if not values.get(credential):
            problems.append(f"{name}: declares {credential} in runtime_env but its .env does not set it")

    config_path = home / "config.yaml"
    if config_path.is_file():
        config = mapping(yaml.safe_load(config_path.read_text(encoding="utf-8")))
        if any(mapping(source).get("enabled") for source in mapping(config.get("secrets")).values()):
            problems.append(f"{name}: config.yaml enables an external secret source that Dodo does not own")
    if (home / ".op.env").exists():
        problems.append(f"{name}: .op.env injects credentials outside .env")
    tokens = home / "mcp-tokens"
    if tokens.is_dir() and any(path.is_file() for path in tokens.rglob("*")):
        problems.append(f"{name}: mcp-tokens/ holds an interactive MCP OAuth grant")

for problem in problems:
    print(f"[dodo-profile-reconciler] {problem}", file=sys.stderr)
if problems:
    raise SystemExit(1)
PYTHON
}

# A profile update merges shipped jobs by id and never removes one (cron/job_definition.py:48-70),
# so a job created on the host, or one a revert or rollback left behind, survives every deployment.
# Refuse runnable jobs the fleet does not declare; a paused one is reported, because a rollback or
# revert leaves exactly that. Also refuse .env keys that override the reviewed timezone or turn cap.
# Read ids, state flags, and key names only; never print a prompt or a value.
verify_cron_runtime_state() {
  local fleet_json="$1"

  "${SYSTEM_PYTHON}" -I - "${fleet_json}" "${DEFAULT_PROFILE_HOME}" "${PROFILE_ROOT}" <<'PYTHON'
import codecs
import json
from pathlib import Path
import re
import sys

import yaml

fleet = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
default_home = Path(sys.argv[2])
profile_root = Path(sys.argv[3])
declared_by_profile = {
    profile["name"]: set(profile["cron"])
    for profile in [fleet["default_profile"], *fleet["profiles"]]
}
homes = {"default": default_home}
if profile_root.is_dir():
    homes.update({path.name: path for path in profile_root.iterdir() if path.is_dir()})
# .env keys that override a reviewed schema 5 setting. Outside multiplex, HERMES_TIMEZONE wins over
# every profile's timezone (hermes_time.py:67-75). HERMES_TUI_MAX_TURNS wins over agent.max_turns on
# the dashboard (tui_gateway/agent_callbacks.py:292-300), and a HERMES_MAX_ITERATIONS left in .env
# shadows it whenever the gateway's config bridge bails (hermes_cli/doctor_config.py:366-386).
override_keys = {
    "HERMES_TIMEZONE": "the reviewed timezone",
    "HERMES_MAX_ITERATIONS": "the reviewed agent.max_turns",
    "HERMES_TUI_MAX_TURNS": "the reviewed agent.max_turns",
}
override_key = re.compile(r"\s*(?:export\s+)?(" + "|".join(override_keys) + r")\s*=")
problems = []
warnings = []


def mapping(value):
    return value if isinstance(value, dict) else {}


# Read the store the way Hermes does: {"jobs": [...]}, an id-keyed map under "jobs", or a bare
# list (cron/jobs.py:1335-1381).
def load_jobs(path):
    data = json.loads(path.read_text(encoding="utf-8"), strict=False)
    if isinstance(data, list):
        jobs = data
    elif isinstance(data, dict) and isinstance(data.get("jobs", []), list):
        jobs = data.get("jobs", [])
    elif isinstance(data, dict) and isinstance(data["jobs"], dict):
        jobs = [{**job, "id": job.get("id") or key} for key, job in data["jobs"].items() if isinstance(job, dict)]
    else:
        raise ValueError("unexpected shape")
    return [job for job in jobs if isinstance(job, dict)]


# cron/jobs.py:516-524: enabled, and neither a paused state nor a pause timestamp.
def runnable(job):
    return bool(job.get("enabled", True)) and not (job.get("state") == "paused" or job.get("paused_at"))


for name, home in sorted(homes.items()):
    declared = declared_by_profile.get(name, set())
    store = home / "cron" / "jobs.json"
    if store.is_file():
        try:
            jobs = load_jobs(store)
        except (OSError, ValueError):
            problems.append(f"{name}: cron/jobs.json is not a readable job store")
            jobs = []
        for job in jobs:
            job_id = str(job.get("id"))
            if job_id in declared:
                continue
            if runnable(job):
                problems.append(
                    f"{name}: cron job {job_id} is active on the host but not declared in Dodo; "
                    f"pause or remove it with `hermes -p {name} cron pause|remove {job_id}`"
                )
            else:
                warnings.append(
                    f"{name}: paused cron job {job_id} is not declared in Dodo; remove it with "
                    f"`hermes -p {name} cron remove {job_id}`"
                )

    # Lets a cron run create further jobs (cron/scheduler.py:445-466).
    config_path = home / "config.yaml"
    if config_path.is_file():
        config = mapping(yaml.safe_load(config_path.read_text(encoding="utf-8")))
        if mapping(config.get("cron")).get("allow_agent_scheduling"):
            problems.append(f"{name}: config.yaml sets cron.allow_agent_scheduling")

    env_path = home / ".env"
    if env_path.is_file():
        raw = env_path.read_bytes()
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            text = raw.removeprefix(codecs.BOM_UTF8).decode("latin-1")
        found = {match.group(1) for match in map(override_key.match, text.splitlines()) if match}
        for key in sorted(found):
            problems.append(f"{name}: .env sets {key}, which overrides {override_keys[key]}")

for warning in warnings:
    print(f"[dodo-profile-reconciler] {warning}")
for problem in problems:
    print(f"[dodo-profile-reconciler] {problem}", file=sys.stderr)
if problems:
    raise SystemExit(1)
PYTHON
}

# Report every declared job's state after the profile updates. New jobs arrive paused and stay
# paused until an operator resumes them; this never resumes, runs, or edits a job.
report_cron_jobs() {
  local fleet_json="$1"

  "${SYSTEM_PYTHON}" -I - "${fleet_json}" "${DEFAULT_PROFILE_HOME}" "${PROFILE_ROOT}" <<'PYTHON'
import json
from pathlib import Path
import sys

import yaml

fleet = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
default_home = Path(sys.argv[2])
profile_root = Path(sys.argv[3])
problems = []


def mapping(value):
    return value if isinstance(value, dict) else {}


def report(line):
    print(f"[dodo-profile-reconciler] {line}")


for profile in fleet["profiles"]:
    name = profile["name"]
    if not profile["cron"]:
        continue
    home = profile_root / name
    store = home / "cron" / "jobs.json"
    try:
        data = json.loads(store.read_text(encoding="utf-8"), strict=False)
        jobs = {job.get("id"): job for job in mapping(data).get("jobs", []) if isinstance(job, dict)}
    except (OSError, ValueError, AttributeError, TypeError):
        jobs = {}
    for job_id in profile["cron"]:
        job = jobs.get(job_id)
        if job is None:
            problems.append(f"{name}/{job_id}: declared but missing from the installed job store")
        elif job.get("state") == "paused" or job.get("paused_at") or not job.get("enabled", True):
            report(f"{name}/{job_id}: paused (awaiting operator resume)")
        elif job.get("state") in ("completed", "error"):
            report(f"{name}/{job_id}: {job['state']}")
        else:
            report(f"{name}/{job_id}: enabled, next run {job.get('next_run_at') or 'not scheduled'}")
    # The gateway's ticker skips parked and standalone profiles (hermes_cli/profiles.py:1050-1075).
    if (home / "gateway.parked").exists():
        report(f"{name}: WARNING gateway.parked is set, so none of its jobs run")
    config = mapping(yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")))
    if mapping(config.get("gateway")).get("standalone"):
        report(f"{name}: WARNING gateway.standalone is set, so the host gateway does not run its jobs")

for problem in problems:
    print(f"[dodo-profile-reconciler] {problem}", file=sys.stderr)
if problems:
    raise SystemExit(1)
PYTHON
}

write_fleet_json() {
  local release="$1"
  local output="$2"
  local fleet

  fleet="$(fleet_manifest_path "${release}")"
  "${SYSTEM_PYTHON}" -I - "${fleet}" "${output}" <<'PYTHON'
import json
from pathlib import Path
import sys

import yaml

source = Path(sys.argv[1])
output = Path(sys.argv[2])
fleet = yaml.safe_load(source.read_text(encoding="utf-8"))
output.write_text(json.dumps(fleet, separators=(",", ":")), encoding="utf-8")
PYTHON
  chown root:root "${output}"
  chmod 0600 "${output}"
}

rollback_profiles() {
  local old_release="$1"
  local previous_raven_skills="$2"
  shift 2
  local newly_installed=("$@")

  rollback_armed=false
  trap - ERR
  set +e
  log "Profile reconciliation failed; restoring the previous Git-owned behavior."
  if test -n "${old_release}" && test -d "${old_release}"; then
    ln -s "${old_release}" "${CURRENT_LINK}.rollback"
    mv -Tf "${CURRENT_LINK}.rollback" "${CURRENT_LINK}"
  else
    rm -f "${CURRENT_LINK}"
  fi

  if test -n "${previous_raven_skills}" && test -d "${previous_raven_skills}"; then
    rm -rf -- "${RAVEN_SKILLS_ROOT}"
    mv "${previous_raven_skills}" "${RAVEN_SKILLS_ROOT}"
  else
    rm -rf -- "${RAVEN_SKILLS_ROOT}"
  fi
  if test -n "${previous_dodo_skills}" && test -d "${previous_dodo_skills}"; then
    rm -rf -- "${DODO_SKILLS_ROOT}"
    mv "${previous_dodo_skills}" "${DODO_SKILLS_ROOT}"
  else
    rm -rf -- "${DODO_SKILLS_ROOT}"
  fi
  if test -n "${previous_hermes_skills}" && test -d "${previous_hermes_skills}"; then
    rm -rf -- "${HERMES_SKILLS_ROOT}"
    mv "${previous_hermes_skills}" "${HERMES_SKILLS_ROOT}"
  else
    rm -rf -- "${HERMES_SKILLS_ROOT}"
  fi

  if test -n "${default_backup}" && test -d "${default_backup}"; then
    run_as_hermes cp -p -- "${default_backup}/SOUL.md" "${DEFAULT_PROFILE_HOME}/SOUL.md" ||
      log "Failed to restore the default profile SOUL.md; inspect it manually."
    run_as_hermes cp -p -- "${default_backup}/config.yaml" "${DEFAULT_PROFILE_HOME}/config.yaml" ||
      log "Failed to restore the default profile config.yaml; inspect it manually."
  fi

  local profile
  for profile in "${declared_profiles[@]}"; do
    if printf '%s\n' "${newly_installed[@]}" | grep -qxF "${profile}"; then
      run_as_hermes "${HERMES_BIN}" profile delete "${profile}" --yes ||
        log "Failed to remove newly installed profile ${profile}; inspect it manually."
    elif test -n "${old_release}" && test -d "${old_release}/profiles/${profile}" &&
      test -d "${PROFILE_ROOT}/${profile}"; then
      (set_distribution_source "${profile}" "${old_release}/profiles/${profile}") ||
        log "Failed to restore the distribution source for ${profile}; inspect it manually."
      run_as_hermes "${HERMES_BIN}" profile update "${profile}" --yes ||
        log "Failed to restore profile ${profile}; inspect it manually."
      (reconcile_profile_config "${profile}" "${old_release}") ||
        log "Failed to restore the Dodo-owned config for ${profile}; inspect it manually."
    fi
  done

  if test -n "${profile_skills_backup}" && test -d "${profile_skills_backup}"; then
    for profile in "${all_profiles[@]}"; do
      local home
      local backup_home="${profile_skills_backup}/${profile}"
      home="$(profile_home "${profile}")"
      test -d "${backup_home}" || continue
      if test -d "${home}"; then
        rm -rf -- "${home}/skills"
        if test -d "${backup_home}/skills"; then
          mv "${backup_home}/skills" "${home}/skills"
        fi
        if test ! -e "${backup_home}/marker-existed"; then
          rm -f "${home}/.no-bundled-skills"
        fi
      fi
    done
  fi
  exit 1
}

# A running gateway discovers each profile's plugins once (hermes_cli/plugins.py:1260-1283), so a new
# or changed plugin loads only after a forced rediscovery: the control socket's reload-plugins verb
# (gateway/control_socket.py:391-399, gateway/run_plugin_rewire.py:80-115) or a gateway restart. Its
# tools apply from the next session. Ask the gateway for every profile that ships plugins; a gateway
# that does not answer never fails the deployment, it only needs a restart. A Kanban worker is a new
# `hermes -p <worker> chat -q` process per task, which discovers its plugins when it starts.
reload_profile_plugins() {
  local fleet_json="$1"
  local profile

  while IFS= read -r profile; do
    test -n "${profile}" || continue
    if run_as_hermes env HERMES_HOME="${DEFAULT_PROFILE_HOME}" "${HERMES_PYTHON}" -I - \
      "${HERMES_SOURCE}" "${DEFAULT_PROFILE_HOME}" "${PROFILE_ROOT}/${profile}" <<'PYTHON'; then
from pathlib import Path
import sys

sys.path.insert(0, sys.argv[1])
from gateway.control_socket import reload_gateway_plugins

answer = reload_gateway_plugins(Path(sys.argv[2]), profile_home=Path(sys.argv[3]))
raise SystemExit(0 if answer and answer.get("reloaded") else 1)
PYTHON
      log "The gateway reloaded ${profile}'s plugins; their tools apply from its next session."
    else
      log "WARNING: the gateway did not reload ${profile}'s plugins; restart hermes-gateway.service."
    fi
  done < <(jq -r '.profiles[] | select(((.plugins // {}) | length > 0) and
    ((.kanban_worker // false) == false)) | .name' "${fleet_json}")
}

test "$(id -u)" -eq 0 || fail "The reconciler must run as root."
[[ "${AGENT_REPOSITORY}" != __* ]] || fail "Template the agent repository URL into the reconciler."
[[ "${ALLOWED_REFS}" != __* ]] || fail "Template the allowed deployment refs into the reconciler."
getent passwd hermes >/dev/null || fail "The hermes operating-system account is missing."
test -x "${HERMES_BIN}" || fail "Hermes is not installed at ${HERMES_BIN}."
test -x "${HERMES_PYTHON}" || fail "Hermes Python is not installed at ${HERMES_PYTHON}."
test -f "${FLEET_VALIDATOR}" ||
  fail "The fleet validator bundle is missing; your deployment passes it as the second argument."
test -x "${FLEET_VALIDATOR_BUN}" &&
  test "$(stat -L -c %U "${FLEET_VALIDATOR_BUN}")" = root ||
  fail "The root-owned bun is missing at ${FLEET_VALIDATOR_BUN}; run your host bootstrap."

for command in awk chgrp chown chmod cp cut date find git grep install jq ln mkdir mktemp mv readlink runuser sed sort stat sudo tar tr; do
  require_command "${command}"
done
"${SYSTEM_PYTHON}" -I -c 'import yaml' 2>/dev/null ||
  fail "System PyYAML (python3-yaml) is missing; install it in your host bootstrap."

read -r -a allowed_refs <<<"${ALLOWED_REFS}"

install -d -o root -g hermes -m 0750 \
  "${DEPLOY_ROOT}" "${RELEASES_ROOT}" "${RETIRED_PROFILE_SKILLS_ROOT}"

raven_skills_temp=""
dodo_skills_temp=""
hermes_skills_temp=""
fleet_json_temp=""
hermes_names_temp=""
hermes_names_home=""
release_temp=""
previous_raven_skills=""
previous_dodo_skills=""
previous_hermes_skills=""
cleanup() {
  rm -f "${CURRENT_LINK}.next" "${CURRENT_LINK}.rollback"
  if test -n "${release_temp}" && test -d "${release_temp}"; then
    case "${release_temp}" in
      "${RELEASES_ROOT}"/.*) rm -rf -- "${release_temp}" ;;
      *) log "Refusing to remove unexpected temporary release path: ${release_temp}" ;;
    esac
  fi
  if test -n "${raven_skills_temp}" && test -d "${raven_skills_temp}"; then
    case "${raven_skills_temp}" in
      "${DEPLOY_ROOT}"/.raven-skills.*) rm -rf -- "${raven_skills_temp}" ;;
      *) log "Refusing to remove unexpected temporary Raven skill path: ${raven_skills_temp}" ;;
    esac
  fi
  if test -n "${dodo_skills_temp}" && test -d "${dodo_skills_temp}"; then
    case "${dodo_skills_temp}" in
      "${DEPLOY_ROOT}"/.dodo-skills.*) rm -rf -- "${dodo_skills_temp}" ;;
      *) log "Refusing to remove unexpected temporary Dodo skill path: ${dodo_skills_temp}" ;;
    esac
  fi
  if test -n "${hermes_skills_temp}" && test -d "${hermes_skills_temp}"; then
    case "${hermes_skills_temp}" in
      "${DEPLOY_ROOT}"/.hermes-skills.*) rm -rf -- "${hermes_skills_temp}" ;;
      *) log "Refusing to remove unexpected temporary Hermes skill path: ${hermes_skills_temp}" ;;
    esac
  fi
  if test -n "${fleet_json_temp}"; then
    rm -f "${fleet_json_temp}"
  fi
  if test -n "${hermes_names_temp}"; then
    rm -f "${hermes_names_temp}"
  fi
  if test -n "${hermes_names_home}" && test -d "${hermes_names_home}"; then
    case "${hermes_names_home}" in
      "${DEPLOY_ROOT}"/.hermes-names-home.*) rm -rf -- "${hermes_names_home}" ;;
      *) log "Refusing to remove unexpected temporary Hermes home: ${hermes_names_home}" ;;
    esac
  fi
  if test -n "${profile_skills_backup}" && test -d "${profile_skills_backup}"; then
    case "${profile_skills_backup}" in
      "${DEPLOY_ROOT}"/.profile-skills-backup.*) rm -rf -- "${profile_skills_backup}" ;;
      *) log "Refusing to remove unexpected profile skill backup: ${profile_skills_backup}" ;;
    esac
  fi
  if test -n "${default_backup}" && test -d "${default_backup}"; then
    case "${default_backup}" in
      "${DEPLOY_ROOT}"/.default-backup.*) rm -rf -- "${default_backup}" ;;
      *) log "Refusing to remove unexpected default-profile backup path: ${default_backup}" ;;
    esac
  fi
}
trap cleanup EXIT

# TODO: give git read access to the agent's repository (and the shared skills repository) without
# storing a credential in the hermes-owned tree: for example a read-only deploy key in a root-owned
# file and GIT_SSH_COMMAND, or a short-lived token narrowed to these repositories in GIT_ASKPASS, as
# Dodo mints one from a GitHub App and revokes it on exit. Never prompt.
export GIT_TERMINAL_PROMPT=0

revision="${REQUESTED_REVISION}"
[[ "${revision}" =~ ^[0-9a-f]{40}$ ]] || fail "Revision must be a full lowercase Git SHA."

release="${RELEASES_ROOT}/${revision}"
if test ! -d "${AGENT_MIRROR}"; then
  log "Creating the read-only repository mirror."
  git -c credential.helper= clone --mirror "${AGENT_REPOSITORY}" "${AGENT_MIRROR}"
else
  test -f "${AGENT_MIRROR}/HEAD" || fail "Managed repository mirror is malformed."
  git -C "${AGENT_MIRROR}" remote set-url origin "${AGENT_REPOSITORY}"
fi

matched_ref=""
for allowed_ref in "${allowed_refs[@]}"; do
  remote_name="${allowed_ref#refs/heads/}"
  git -c credential.helper= -C "${AGENT_MIRROR}" fetch --no-tags origin \
    "+${allowed_ref}:refs/agent-allowed/${remote_name}"
  if git -C "${AGENT_MIRROR}" cat-file -e "${revision}^{commit}" 2>/dev/null &&
    git -C "${AGENT_MIRROR}" merge-base --is-ancestor \
      "${revision}" "refs/agent-allowed/${remote_name}"; then
    matched_ref="${allowed_ref}"
  fi
done
test -n "${matched_ref}" || fail "Revision is not reachable from an allowed deployment ref."
log "Verified revision ${revision} against ${matched_ref}."

if test ! -d "${release}"; then
  release_temp="$(mktemp -d "${RELEASES_ROOT}/.${revision}.XXXXXX")"
  git -C "${AGENT_MIRROR}" archive "${revision}" | tar -x -C "${release_temp}"
  validate_release "${release_temp}"
  chown -R root:hermes "${release_temp}"
  chmod -R u=rwX,go=rX "${release_temp}"
  mv "${release_temp}" "${release}"
  release_temp=""
else
  validate_release "${release}"
fi
fleet_json_temp="$(mktemp "${DEPLOY_ROOT}/fleet.XXXXXX")"
write_fleet_json "${release}" "${fleet_json_temp}"
mapfile -t declared_profiles < <(jq -r '.profiles[].name' "${fleet_json_temp}")
mapfile -t all_profiles < <(
  jq -r '(.default_profile?.name // .defaultProfile?.name // empty), .profiles[].name' \
    "${fleet_json_temp}"
)
verify_slack_runtime_boundary "${fleet_json_temp}" ||
  fail "Host runtime state would bypass the reviewed Slack access policy; nothing was changed."
# Schema 5 declares runtime credentials; a schema 4 release predates the contract and skips it.
if jq -e '(.schema_version // .schemaVersion) >= 5' "${fleet_json_temp}" >/dev/null; then
  hermes_names_temp="$(mktemp "${DEPLOY_ROOT}/hermes-credential-names.XXXXXX")"
  hermes_names_home="$(mktemp -d "${DEPLOY_ROOT}/.hermes-names-home.XXXXXX")"
  chown hermes:hermes "${hermes_names_home}"
  write_hermes_credential_names "${hermes_names_temp}" "${hermes_names_home}" ||
    fail "Could not read credential names from the installed Hermes; nothing was changed."
  verify_runtime_credentials "${fleet_json_temp}" "${hermes_names_temp}" "${release}" ||
    fail "Host runtime credentials do not match the reviewed fleet; nothing was changed."
  verify_cron_runtime_state "${fleet_json_temp}" ||
    fail "Host cron or run-limit state does not match the reviewed fleet; nothing was changed."
fi

raven_revision="none"
if test -n "${RAVEN_REPOSITORY}" && [[ "${RAVEN_REPOSITORY}" != __* ]]; then
  if test ! -d "${RAVEN_CHECKOUT}"; then
    log "Creating the ordinary read-only shared skills checkout."
    git -c credential.helper= clone --single-branch "${RAVEN_REPOSITORY}" "${RAVEN_CHECKOUT}"
  else
    test -d "${RAVEN_CHECKOUT}/.git" || fail "Managed shared skills checkout is malformed."
    git -C "${RAVEN_CHECKOUT}" remote set-url origin "${RAVEN_REPOSITORY}"
  fi
  git -c credential.helper= -C "${RAVEN_CHECKOUT}" fetch --no-tags --prune origin HEAD
  git -C "${RAVEN_CHECKOUT}" checkout --detach --force FETCH_HEAD
  git -C "${RAVEN_CHECKOUT}" clean -xdff
  find "${RAVEN_CHECKOUT}" -path "${RAVEN_CHECKOUT}/.git" -prune -o -type l -prune -o \
    -exec chown root:hermes {} +
  find "${RAVEN_CHECKOUT}" -path "${RAVEN_CHECKOUT}/.git" -prune -o -type l -prune -o \
    -exec chmod u=rwX,go=rX {} +
  raven_revision="$(git -C "${RAVEN_CHECKOUT}" rev-parse HEAD)"
  log "Updated the shared skills repository to its default branch (${raven_revision})."
elif jq -e 'any((.default_profile, .profiles[]); (.raven_skills // []) | length > 0)' \
  "${fleet_json_temp}" >/dev/null; then
  fail "The fleet selects raven_skills, but no shared skills repository is configured."
fi

dodo_skills_temp="$(mktemp -d "${DEPLOY_ROOT}/.dodo-skills.XXXXXX")"
raven_skills_temp="$(mktemp -d "${DEPLOY_ROOT}/.raven-skills.XXXXXX")"
hermes_skills_temp="$(mktemp -d "${DEPLOY_ROOT}/.hermes-skills.XXXXXX")"
chown root:hermes "${dodo_skills_temp}" "${raven_skills_temp}" "${hermes_skills_temp}"
chmod 0755 "${dodo_skills_temp}" "${raven_skills_temp}" "${hermes_skills_temp}"
for profile in "${all_profiles[@]}"; do
  dodo_profile_skills_dir="${dodo_skills_temp}/${profile}"
  raven_profile_skills_dir="${raven_skills_temp}/${profile}"
  hermes_profile_skills_dir="${hermes_skills_temp}/${profile}"
  install -d -o root -g hermes -m 0755 \
    "${dodo_profile_skills_dir}" "${raven_profile_skills_dir}" "${hermes_profile_skills_dir}"

  dodo_skills="$(
    jq -r --arg profile "${profile}" \
      '[.default_profile?, .profiles[]] | .[] | select(.name == $profile) | (.dodo_skills // [])[]' \
      "${fleet_json_temp}"
  )"
  while IFS= read -r dodo_skill; do
    test -n "${dodo_skill}" || continue
    skill_source="${release}/shared/skills/${dodo_skill}"
    test -d "${skill_source}" || fail "Selected Dodo skill does not exist: ${dodo_skill}."
    test -f "${skill_source}/SKILL.md" || fail "Selected Dodo skill lacks SKILL.md: ${dodo_skill}."
    test -z "$(find "${skill_source}" -type l -print -quit)" ||
      fail "Selected Dodo skill contains a symlink: ${dodo_skill}."
    grep -q "^name: ${dodo_skill}$" "${skill_source}/SKILL.md" ||
      fail "Selected Dodo skill name does not match its directory: ${dodo_skill}."
    cp -al -- "${skill_source}" "${dodo_profile_skills_dir}/${dodo_skill}"
  done <<<"${dodo_skills}"

  raven_skills="$(
    jq -r --arg profile "${profile}" \
      '[.default_profile?, .defaultProfile?, .profiles[]] | .[] | select(.name == $profile) | (.raven_skills // .ravenSkills // [])[]' \
      "${fleet_json_temp}"
  )"
  while IFS= read -r raven_skill; do
    test -n "${raven_skill}" || continue
    skill_name="${raven_skill##*/}"
    skill_source="${RAVEN_CHECKOUT}/${raven_skill}"
    test -d "${skill_source}" || fail "Selected Raven skill does not exist: ${raven_skill}."
    test -f "${skill_source}/SKILL.md" || fail "Selected Raven skill lacks SKILL.md: ${raven_skill}."
    test -z "$(find "${skill_source}" -type l -print -quit)" ||
      fail "Selected Raven skill contains a symlink: ${raven_skill}."
    grep -q "^name: ${skill_name}$" "${skill_source}/SKILL.md" ||
      fail "Selected Raven skill name does not match its directory: ${raven_skill}."
    test ! -e "${raven_profile_skills_dir}/${skill_name}" ||
      fail "Profile ${profile} selects duplicate Raven skill name ${skill_name}."
    cp -al -- "${skill_source}" "${raven_profile_skills_dir}/${skill_name}"
  done <<<"${raven_skills}"

  hermes_skills="$(
    jq -r --arg profile "${profile}" \
      '[.default_profile?, .profiles[]] | .[] | select(.name == $profile) | (.hermes_skills // [])[]' \
      "${fleet_json_temp}"
  )"
  while IFS= read -r hermes_skill; do
    test -n "${hermes_skill}" || continue
    skill_name="${hermes_skill##*/}"
    skill_source="${HERMES_BUNDLED_SKILLS_ROOT}/${hermes_skill}"
    test -d "${skill_source}" || fail "Selected Hermes skill does not exist: ${hermes_skill}."
    test -f "${skill_source}/SKILL.md" || fail "Selected Hermes skill lacks SKILL.md: ${hermes_skill}."
    test -z "$(find "${skill_source}" -type l -print -quit)" ||
      fail "Selected Hermes skill contains a symlink: ${hermes_skill}."
    grep -q "^name: ${skill_name}$" "${skill_source}/SKILL.md" ||
      fail "Selected Hermes skill name does not match its directory: ${hermes_skill}."
    test ! -e "${hermes_profile_skills_dir}/${skill_name}" ||
      fail "Profile ${profile} selects duplicate Hermes skill name ${skill_name}."
    cp -a -- "${skill_source}" "${hermes_profile_skills_dir}/${skill_name}"
    # hermes owns the source and can swap in a symlink after the check above. Check the root-owned
    # copy again, because chmod -R follows a symlink named on its command line.
    test -z "$(find "${hermes_profile_skills_dir}/${skill_name}" -type l -print -quit)" ||
      fail "Selected Hermes skill contains a symlink: ${hermes_skill}."
    chown -R root:hermes "${hermes_profile_skills_dir}/${skill_name}"
    chmod -R u=rwX,go=rX "${hermes_profile_skills_dir}/${skill_name}"
  done <<<"${hermes_skills}"
done

old_release=""
if test -L "${CURRENT_LINK}"; then
  old_release="$(readlink -f "${CURRENT_LINK}")"
fi
if test -d "${RAVEN_SKILLS_ROOT}"; then
  previous_raven_skills="${DEPLOY_ROOT}/.raven-skills.previous"
  retire_interrupted_view "${previous_raven_skills}"
fi
if test -d "${DODO_SKILLS_ROOT}"; then
  previous_dodo_skills="${DEPLOY_ROOT}/.dodo-skills.previous"
  retire_interrupted_view "${previous_dodo_skills}"
fi
if test -d "${HERMES_SKILLS_ROOT}"; then
  previous_hermes_skills="${DEPLOY_ROOT}/.hermes-skills.previous"
  retire_interrupted_view "${previous_hermes_skills}"
fi
if jq -e '(.schema_version // .schemaVersion) >= 2' "${fleet_json_temp}" >/dev/null; then
  test -f "${DEFAULT_PROFILE_HOME}/SOUL.md" || fail "The default profile has no SOUL.md to preserve."
  test -f "${DEFAULT_PROFILE_HOME}/config.yaml" || fail "The default profile has no config.yaml to preserve."
  default_backup="$(mktemp -d "${DEPLOY_ROOT}/.default-backup.XXXXXX")"
  # Copy as hermes: as root, cp follows a symlink hermes planted, which would read any root file
  # here and overwrite any file on rollback.
  chown hermes:hermes "${default_backup}"
  run_as_hermes cp -p -- "${DEFAULT_PROFILE_HOME}/SOUL.md" "${default_backup}/SOUL.md"
  run_as_hermes cp -p -- "${DEFAULT_PROFILE_HOME}/config.yaml" "${default_backup}/config.yaml"
fi
profile_skills_backup="$(mktemp -d "${DEPLOY_ROOT}/.profile-skills-backup.XXXXXX")"
newly_installed=()
rollback_armed=true
trap 'rollback_profiles "${old_release}" "${previous_raven_skills}" "${newly_installed[@]}"' ERR
ln -s "${release}" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "${CURRENT_LINK}"

if test -n "${previous_raven_skills}"; then
  mv "${RAVEN_SKILLS_ROOT}" "${previous_raven_skills}"
fi
mv "${raven_skills_temp}" "${RAVEN_SKILLS_ROOT}"
raven_skills_temp=""
if test -n "${previous_dodo_skills}"; then
  mv "${DODO_SKILLS_ROOT}" "${previous_dodo_skills}"
fi
mv "${dodo_skills_temp}" "${DODO_SKILLS_ROOT}"
dodo_skills_temp=""
if test -n "${previous_hermes_skills}"; then
  mv "${HERMES_SKILLS_ROOT}" "${previous_hermes_skills}"
fi
mv "${hermes_skills_temp}" "${HERMES_SKILLS_ROOT}"
hermes_skills_temp=""

for profile in "${declared_profiles[@]}"; do
  source_path="${release}/profiles/${profile}"
  if test -d "${PROFILE_ROOT}/${profile}"; then
    prepare_profile_skill_boundary "${profile}"
    set_distribution_source "${profile}" "${source_path}"
    run_as_hermes "${HERMES_BIN}" profile update "${profile}" --yes
  else
    newly_installed+=("${profile}")
    run_as_hermes "${HERMES_BIN}" profile install "${source_path}" \
      --name "${profile}" --alias --yes
    prepare_profile_skill_boundary "${profile}"
  fi
  reconcile_profile_config "${profile}" "${release}"
  run_as_hermes "${HERMES_BIN}" profile info "${profile}"
done
if jq -e '(.schema_version // .schemaVersion) >= 2' "${fleet_json_temp}" >/dev/null; then
  prepare_profile_skill_boundary default
  reconcile_default_profile "${release}"
fi
if jq -e '(.schema_version // .schemaVersion) >= 5' "${fleet_json_temp}" >/dev/null; then
  report_cron_jobs "${fleet_json_temp}" ||
    fail "A declared cron job is missing from its profile's job store after the update."
fi
rollback_armed=false
trap - ERR

if test -n "${previous_raven_skills}" && test -d "${previous_raven_skills}"; then
  rm -rf -- "${previous_raven_skills}"
  previous_raven_skills=""
fi
if test -n "${previous_dodo_skills}" && test -d "${previous_dodo_skills}"; then
  rm -rf -- "${previous_dodo_skills}"
  previous_dodo_skills=""
fi
if test -n "${previous_hermes_skills}" && test -d "${previous_hermes_skills}"; then
  rm -rf -- "${previous_hermes_skills}"
  previous_hermes_skills=""
fi
if test -n "${default_backup}" && test -d "${default_backup}"; then
  case "${default_backup}" in
    "${DEPLOY_ROOT}"/.default-backup.*) rm -rf -- "${default_backup}" ;;
    *) fail "Refusing to remove unexpected default-profile backup path: ${default_backup}" ;;
  esac
  default_backup=""
fi
retired_profile_skills="$(mktemp -d "${RETIRED_PROFILE_SKILLS_ROOT}/${revision}.XXXXXX")"
rmdir "${retired_profile_skills}"
mv "${profile_skills_backup}" "${retired_profile_skills}"
profile_skills_backup=""

printf '%s\n' "${revision}" >"${DEPLOYED_REVISION_FILE}.next"
chown root:hermes "${DEPLOYED_REVISION_FILE}.next"
chmod 0640 "${DEPLOYED_REVISION_FILE}.next"
mv "${DEPLOYED_REVISION_FILE}.next" "${DEPLOYED_REVISION_FILE}"

reload_profile_plugins "${fleet_json_temp}"
profile_list="$(printf '%s ' "${all_profiles[@]}")"
log "Reconciled ${profile_list% } at ${revision} with shared skills ${raven_revision}."
