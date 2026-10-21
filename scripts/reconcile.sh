#!/usr/bin/env bash
# Reconcile the host's Hermes profiles with one reviewed revision of this repository.
#
# A skeleton modelled on the reference implementation's reconciler. It runs as root on the host,
# triggered by your deployment path with the exact commit SHA that was merged. It:
#
#   1. verifies the revision is reachable from an allowed branch;
#   2. extracts the release and re-validates it with host_rules.py (installed next to this script,
#      never taken from the release it checks);
#   3. snapshots what it will change, and arms a rollback;
#   4. projects each profile's selected skills as a read-only view;
#   5. installs or updates every declared profile through the Hermes CLI and reapplies the config
#      fields this repository owns, keeping runtime state (model, keys, sessions, memory);
#   6. records the deployed revision, or restores the snapshot on any failure.
#
# Install this script and host_rules.py on the host through your infrastructure tooling, not from
# the release, so a profile change can never rewrite the code that checks it.
#
# TODO markers are host-specific decisions the template cannot make for you.

# -E (errtrace) makes the ERR trap fire for failures inside functions; without it a failed step
# exits without restoring the previous state.
set -Eeuo pipefail
umask 077

readonly REQUESTED_REVISION="${1:-}"
readonly AGENT="myagent"
# TODO: your repository's clone URL and how the host authenticates to it (a read-only deploy key or
# a GitHub App token narrowed to this one repository).
readonly REPOSITORY="__REPOSITORY_URL__"
readonly ALLOWED_REFS=("refs/heads/main")
readonly DEPLOY_ROOT="/var/lib/hermes/.${AGENT}-deployment"
readonly MIRROR="${DEPLOY_ROOT}/repository.git"
readonly RELEASES_ROOT="${DEPLOY_ROOT}/releases"
readonly CURRENT_LINK="${DEPLOY_ROOT}/current"
readonly SKILLS_ROOT="${DEPLOY_ROOT}/skills"
readonly DEPLOYED_REVISION_FILE="${DEPLOY_ROOT}/deployed-revision"
readonly HERMES_HOME="/var/lib/hermes"
readonly DEFAULT_PROFILE_HOME="${HERMES_HOME}/.hermes"
readonly PROFILE_ROOT="${DEFAULT_PROFILE_HOME}/profiles"
readonly HERMES_BIN="${HERMES_HOME}/.local/bin/hermes"
# hermes owns the Hermes venv, so Python that runs as root uses the system interpreter in isolated
# mode, never the venv.
readonly SYSTEM_PYTHON="/usr/bin/python3"
HOST_RULES="$(dirname "$(readlink -f "$0")")/host_rules.py"
readonly HOST_RULES

old_release=""
previous_skills=""
default_backup=""
newly_installed=()
declared_profiles=()

log() { printf '[%s-reconciler] %s\n' "${AGENT}" "$*" >&2; }
fail() {
  log "$*"
  exit 1
}
run_as_hermes() { runuser -u hermes -- "$@"; }

profile_home() {
  if test "$1" = default; then
    printf '%s\n' "${DEFAULT_PROFILE_HOME}"
  else
    printf '%s\n' "${PROFILE_ROOT}/$1"
  fi
}

# Rewrite the fields of the installed config.yaml that this repository owns. Hermes keeps an
# existing profile's config on update, so without this a reviewed change would never land.
reapply_owned_config() {
  local profile="$1"
  local release="$2"
  # TODO: also union the toolsets the installed Hermes knows into agent.disabled_toolsets, so a
  # toolset a new release adds is never switched on silently. The reference implementation reads
  # them from hermes_cli.tools_config and toolsets.TOOLSETS through the Hermes venv, as hermes.
  run_as_hermes "${SYSTEM_PYTHON}" -I - "${release}/profiles/${profile}/config.yaml" \
    "$(profile_home "${profile}")/config.yaml" <<'PYTHON'
import os
from pathlib import Path
import sys
import tempfile

import yaml

source = yaml.safe_load(Path(sys.argv[1]).read_text(encoding="utf-8"))
installed_path = Path(sys.argv[2])
installed = yaml.safe_load(installed_path.read_text(encoding="utf-8")) or {}
for key, value in source.items():
    installed[key] = value
# A profile that no longer declares these must not keep a stale copy.
for key in ("slack", "memory", "gateway", "kanban"):
    if key not in source:
        installed.pop(key, None)
descriptor, temporary = tempfile.mkstemp(prefix=".config.", dir=installed_path.parent)
with os.fdopen(descriptor, "w", encoding="utf-8") as output:
    yaml.safe_dump(installed, output, sort_keys=False, allow_unicode=True)
os.replace(temporary, installed_path)
PYTHON
}

rollback() {
  trap - ERR
  set +e
  log "Reconciliation failed; restoring the previous release."
  if test -n "${old_release}"; then
    ln -sfn "${old_release}" "${CURRENT_LINK}"
  fi
  if test -n "${previous_skills}" && test -d "${previous_skills}"; then
    rm -rf -- "${SKILLS_ROOT}"
    mv "${previous_skills}" "${SKILLS_ROOT}"
  fi
  if test -n "${default_backup}"; then
    run_as_hermes cp -p -- "${default_backup}/SOUL.md" "${DEFAULT_PROFILE_HOME}/SOUL.md"
    run_as_hermes cp -p -- "${default_backup}/config.yaml" "${DEFAULT_PROFILE_HOME}/config.yaml"
  fi
  local profile
  for profile in "${newly_installed[@]}"; do
    run_as_hermes "${HERMES_BIN}" profile delete "${profile}" --yes ||
      log "Could not remove newly installed ${profile}; inspect it."
  done
  if test -n "${old_release}"; then
    for profile in "${declared_profiles[@]}"; do
      if test -d "${old_release}/profiles/${profile}" && test -d "${PROFILE_ROOT}/${profile}"; then
        # TODO: point the profile's distribution source back at the old release first, as the
        # reference implementation's set_distribution_source does.
        run_as_hermes "${HERMES_BIN}" profile update "${profile}" --yes ||
          log "Could not restore ${profile}; inspect it."
        reapply_owned_config "${profile}" "${old_release}" ||
          log "Could not restore ${profile}'s config; inspect it."
      fi
    done
  fi
  exit 1
}

[[ "${REQUESTED_REVISION}" =~ ^[0-9a-f]{40}$ ]] || fail "Revision must be a full lowercase Git SHA."
install -d -o root -g hermes -m 0755 "${DEPLOY_ROOT}" "${RELEASES_ROOT}"

# 1. The revision must be on an allowed branch.
if test ! -d "${MIRROR}"; then
  git clone --mirror "${REPOSITORY}" "${MIRROR}"
fi
git -C "${MIRROR}" fetch --prune origin
reachable=false
for ref in "${ALLOWED_REFS[@]}"; do
  if git -C "${MIRROR}" merge-base --is-ancestor "${REQUESTED_REVISION}" "${ref}" 2>/dev/null; then
    reachable=true
  fi
done
"${reachable}" || fail "Revision is not reachable from an allowed branch."

# 2. Extract and re-validate before touching anything.
release="${RELEASES_ROOT}/${REQUESTED_REVISION}"
if test ! -d "${release}"; then
  staging="$(mktemp -d "${RELEASES_ROOT}/.${REQUESTED_REVISION}.XXXXXX")"
  git -C "${MIRROR}" archive "${REQUESTED_REVISION}" | tar -x -C "${staging}"
  "${SYSTEM_PYTHON}" -I "${HOST_RULES}" "${staging}" || fail "The release breaks a boundary rule; nothing was changed."
  chown -R root:hermes "${staging}"
  chmod -R u=rwX,go=rX "${staging}"
  mv "${staging}" "${release}"
else
  "${SYSTEM_PYTHON}" -I "${HOST_RULES}" "${release}" || fail "The release breaks a boundary rule; nothing was changed."
fi
mapfile -t declared_profiles < <(
  "${SYSTEM_PYTHON}" -I -c '
import sys, yaml
fleet = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
print("\n".join(profile["name"] for profile in fleet["profiles"]))
' "${release}/profiles/fleet.yaml"
)
# TODO: check runtime state the release depends on before changing anything: every runtime_env
# name is set in its profile's .env, no .env sets a SLACK_* policy key that would override the
# reviewed allowlists, and each declared cron job exists in its profile's job store.

# 3. Snapshot and arm the rollback.
if test -L "${CURRENT_LINK}"; then
  old_release="$(readlink -f "${CURRENT_LINK}")"
fi
default_backup="$(mktemp -d "${DEPLOY_ROOT}/.default-backup.XXXXXX")"
chown hermes:hermes "${default_backup}"
run_as_hermes cp -p -- "${DEFAULT_PROFILE_HOME}/SOUL.md" "${DEFAULT_PROFILE_HOME}/config.yaml" "${default_backup}/"
trap rollback ERR

# 4. Read-only skill views: each profile sees only the skills it selects.
skills_next="$(mktemp -d "${DEPLOY_ROOT}/.skills.XXXXXX")"
for profile in default "${declared_profiles[@]}"; do
  install -d -o root -g hermes -m 0755 "${skills_next}/${profile}"
  while IFS= read -r skill; do
    test -n "${skill}" || continue
    test -f "${release}/shared/skills/${skill}/SKILL.md" || fail "Selected skill ${skill} does not exist."
    cp -al -- "${release}/shared/skills/${skill}" "${skills_next}/${profile}/${skill}"
  done < <(
    "${SYSTEM_PYTHON}" -I -c '
import sys, yaml
fleet = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
for profile in [fleet["default_profile"], *fleet["profiles"]]:
    if profile["name"] == sys.argv[2]:
        print("\n".join(profile.get("skills") or []))
' "${release}/profiles/fleet.yaml" "${profile}"
  )
done
chmod 0755 "${skills_next}"
ln -sfn "${release}" "${CURRENT_LINK}"
if test -d "${SKILLS_ROOT}"; then
  previous_skills="${DEPLOY_ROOT}/.skills.previous"
  mv "${SKILLS_ROOT}" "${previous_skills}"
fi
mv "${skills_next}" "${SKILLS_ROOT}"
# TODO: make each profile's own skills directory root-owned and unwritable by hermes, with a
# .no-bundled-skills marker, so skill_manage cannot change what a profile knows.

# 5. Install or update every profile, then reapply the owned config.
for profile in "${declared_profiles[@]}"; do
  if test -d "${PROFILE_ROOT}/${profile}"; then
    # TODO: point the installed distribution.yaml's source at "${release}/profiles/${profile}".
    run_as_hermes "${HERMES_BIN}" profile update "${profile}" --yes
  else
    newly_installed+=("${profile}")
    run_as_hermes "${HERMES_BIN}" profile install "${release}/profiles/${profile}" \
      --name "${profile}" --alias --yes
  fi
  reapply_owned_config "${profile}" "${release}"
done
run_as_hermes cp -- "${release}/profiles/default/SOUL.md" "${DEFAULT_PROFILE_HOME}/SOUL.md"
reapply_owned_config default "${release}"
# TODO: reload plugins or restart the gateway when a plugin changed, and report each declared cron
# job's state (new jobs arrive paused until an operator resumes them).

# 6. Done: drop the snapshot and record the revision.
trap - ERR
rm -rf -- "${previous_skills}" "${default_backup}"
printf '%s\n' "${REQUESTED_REVISION}" >"${DEPLOYED_REVISION_FILE}"
log "Reconciled default ${declared_profiles[*]} at ${REQUESTED_REVISION}."
