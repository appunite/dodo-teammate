#!/usr/bin/env bash
# Rename the template's placeholder agent, `myagent` / `MyAgent`, to your agent's name.
# Usage: scripts/rename-agent.sh <name>   (lowercase letters and digits, for example: kiwi)
# Run it once, on a clean checkout, and review the diff before committing.

set -euo pipefail

name="${1:-}"
[[ "${name}" =~ ^[a-z][a-z0-9]{1,20}$ ]] || {
  echo "usage: $0 <name> (lowercase letters and digits, 2 to 21 characters)" >&2
  exit 2
}
title="$(printf '%s' "${name:0:1}" | tr '[:lower:]' '[:upper:]')${name:1}"
upper="$(printf '%s' "${name}" | tr '[:lower:]' '[:upper:]')"
root="$(git rev-parse --show-toplevel)"
cd "${root}"

git ls-files -z | xargs -0 grep -lZ -e myagent -e MyAgent -e MYAGENT |
  xargs -0 --no-run-if-empty sed -i -e "s/myagent/${name}/g" -e "s/MyAgent/${title}/g" -e "s/MYAGENT/${upper}/g"

# Deepest paths first, renaming only the last component, so each parent still exists when moved.
while IFS= read -r path; do
  base="${path##*/}"
  parent="${path%/*}"
  test "${parent}" = "${path}" && parent="."
  git mv "${path}" "${parent}/${base//myagent/${name}}"
done < <(git ls-files | grep -o '^.*myagent[^/]*' | sort -u -r)

# Names of a different length can reflow lines; let the formatter settle them.
if command -v bun >/dev/null && test -d infra/node_modules; then
  (cd infra && bun run format >/dev/null)
fi

echo "Renamed the agent to ${title}. Review with git status and git diff, then run mise run check."
