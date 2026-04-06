#!/usr/bin/env bash
# Supply-chain security gate: fail if newly added/updated packages were published
# less than a configurable number of days ago.
#
# Supports: npm (pnpm-lock.yaml), Python (uv.lock), Rust (Bazel crate.spec),
#           Java (Bazel maven_install.json)
#
# Requires: curl, jq, date (GNU coreutils)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (from action inputs or environment)
# ---------------------------------------------------------------------------
ECOSYSTEMS="${INPUT_ECOSYSTEMS:-npm}"
MIN_AGE_DAYS="${INPUT_MIN_AGE_DAYS:-14}"
BASE_REF="${INPUT_BASE_REF:-origin/main}"
NPM_LOCKFILE="${INPUT_NPM_LOCKFILE:-pnpm-lock.yaml}"
PYTHON_LOCKFILE_GLOB="${INPUT_PYTHON_LOCKFILE_GLOB:-**/uv.lock}"
RUST_MODULE_FILE="${INPUT_RUST_MODULE_FILE:-java/rust/rust.MODULE.bazel}"
JAVA_LOCK_FILE="${INPUT_JAVA_LOCK_FILE:-java/maven_install.json}"

NOW_EPOCH=$(date +%s)
MIN_AGE_SECS=$((MIN_AGE_DAYS * 86400))
CUTOFF_EPOCH=$((NOW_EPOCH - MIN_AGE_SECS))

TOTAL_CHECKED=0
TOTAL_FAILURES=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Convert an ISO-8601 timestamp to epoch seconds.
# Works with GNU date (Linux CI runners).
iso_to_epoch() {
  date -d "$1" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "${1%%.*}" +%s 2>/dev/null || echo 0
}

check_age() {
  local ecosystem="$1" name="$2" version="$3" publish_epoch="$4"

  if [[ "$publish_epoch" -eq 0 ]]; then
    return
  fi

  TOTAL_CHECKED=$((TOTAL_CHECKED + 1))

  if [[ "$publish_epoch" -gt "$CUTOFF_EPOCH" ]]; then
    local age_days=$(( (NOW_EPOCH - publish_epoch) / 86400 ))
    echo "  FAIL: ${name}@${version} published ${age_days}d ago, minimum is ${MIN_AGE_DAYS}d"
    TOTAL_FAILURES=$((TOTAL_FAILURES + 1))
  fi
}

# ---------------------------------------------------------------------------
# npm (pnpm-lock.yaml)
# ---------------------------------------------------------------------------
check_npm() {
  echo "=== npm (${NPM_LOCKFILE}) ==="

  if [[ ! -f "$NPM_LOCKFILE" ]]; then
    echo "  Lockfile not found, skipping."
    return
  fi

  local changed
  changed=$(git diff "${BASE_REF}" -- "$NPM_LOCKFILE" \
    | grep '^+' \
    | grep -v '^+++' \
    | grep -oE "'[^']+@[0-9][^']*'" \
    | sed "s/'//g" \
    | sort -u) || true

  if [[ -z "$changed" ]]; then
    echo "  No new/changed packages."
    return
  fi

  while IFS= read -r entry; do
    local version="${entry##*@}"
    local name="${entry%@"$version"}"
    [[ -z "$name" || -z "$version" ]] && continue

    local publish_time
    publish_time=$(curl -sf "https://registry.npmjs.org/${name}" \
      | jq -r --arg v "$version" '.time[$v] // empty' 2>/dev/null) || true

    if [[ -z "$publish_time" ]]; then
      continue
    fi

    local publish_epoch
    publish_epoch=$(iso_to_epoch "$publish_time")
    check_age npm "$name" "$version" "$publish_epoch"
  done <<< "$changed"
}

# ---------------------------------------------------------------------------
# Python (uv.lock)
# ---------------------------------------------------------------------------
check_python() {
  echo "=== python (${PYTHON_LOCKFILE_GLOB}) ==="

  # Find all uv.lock files that have changes vs the base ref.
  local lockfiles
  lockfiles=$(git diff --name-only "${BASE_REF}" -- ${PYTHON_LOCKFILE_GLOB} 2>/dev/null) || true

  if [[ -z "$lockfiles" ]]; then
    echo "  No changed uv.lock files."
    return
  fi

  local packages=""

  while IFS= read -r lockfile; do
    # uv.lock format: [[package]] blocks with name and version fields.
    # Extract added name/version pairs from the diff.
    local diff_text
    diff_text=$(git diff "${BASE_REF}" -- "$lockfile" | grep '^+' | grep -v '^+++') || true

    local current_name=""
    while IFS= read -r line; do
      # Strip the leading +
      line="${line#+}"

      if [[ "$line" =~ ^name\ =\ \"([^\"]+)\" ]]; then
        current_name="${BASH_REMATCH[1]}"
      elif [[ "$line" =~ ^version\ =\ \"([^\"]+)\" && -n "$current_name" ]]; then
        packages+="${current_name}@${BASH_REMATCH[1]}"$'\n'
        current_name=""
      fi
    done <<< "$diff_text"
  done <<< "$lockfiles"

  packages=$(echo "$packages" | sort -u | grep -v '^$') || true

  if [[ -z "$packages" ]]; then
    echo "  No new/changed packages."
    return
  fi

  while IFS= read -r entry; do
    local version="${entry##*@}"
    local name="${entry%@"$version"}"

    local publish_time
    publish_time=$(curl -sf "https://pypi.org/pypi/${name}/${version}/json" \
      | jq -r '.urls[0].upload_time_iso_8601 // empty' 2>/dev/null) || true

    if [[ -z "$publish_time" ]]; then
      continue
    fi

    local publish_epoch
    publish_epoch=$(iso_to_epoch "$publish_time")
    check_age python "$name" "$version" "$publish_epoch"
  done <<< "$packages"
}

# ---------------------------------------------------------------------------
# Rust (Bazel crate.spec in rust.MODULE.bazel)
# ---------------------------------------------------------------------------
check_rust() {
  echo "=== rust (${RUST_MODULE_FILE}) ==="

  if [[ ! -f "$RUST_MODULE_FILE" ]]; then
    echo "  Module file not found, skipping."
    return
  fi

  # Extract added crate specs. crate.spec() spans multiple lines, so we parse
  # the diff line-by-line, tracking package/version/git fields per block.
  local diff_added
  diff_added=$(git diff "${BASE_REF}" -- "$RUST_MODULE_FILE" \
    | grep '^+' | grep -v '^+++') || true

  local packages="" current_pkg="" current_ver="" is_git=false
  while IFS= read -r line; do
    line="${line#+}"
    # New crate.spec block
    if [[ "$line" =~ crate\.spec\( ]]; then
      # Flush previous block
      if [[ -n "$current_pkg" && -n "$current_ver" && "$is_git" == false ]]; then
        packages+="${current_pkg}@${current_ver}"$'\n'
      fi
      current_pkg="" current_ver="" is_git=false
    fi
    if [[ "$line" =~ package\ =\ \"([^\"]+)\" ]]; then
      current_pkg="${BASH_REMATCH[1]}"
    fi
    if [[ "$line" =~ version\ =\ \"([^\"]+)\" ]]; then
      current_ver="${BASH_REMATCH[1]}"
    fi
    if [[ "$line" =~ git\ =\ \" ]]; then
      is_git=true
    fi
  done <<< "$diff_added"
  # Flush last block
  if [[ -n "$current_pkg" && -n "$current_ver" && "$is_git" == false ]]; then
    packages+="${current_pkg}@${current_ver}"$'\n'
  fi

  local changed
  changed=$(echo "$packages" | sort -u | grep -v '^$') || true

  if [[ -z "$changed" ]]; then
    echo "  No new/changed crates."
    return
  fi

  while IFS= read -r entry; do
    local version="${entry##*@}"
    local name="${entry%@"$version"}"
    [[ -z "$name" || -z "$version" ]] && continue

    local publish_time
    publish_time=$(curl -sf -H "User-Agent: dependency-age-check-action" \
      "https://crates.io/api/v1/crates/${name}" \
      | jq -r --arg v "$version" '.versions[] | select(.num == $v) | .created_at // empty' 2>/dev/null) || true

    if [[ -z "$publish_time" ]]; then
      continue
    fi

    local publish_epoch
    publish_epoch=$(iso_to_epoch "$publish_time")
    check_age rust "$name" "$version" "$publish_epoch"
  done <<< "$changed"
}

# ---------------------------------------------------------------------------
# Java (Bazel maven_install.json)
# ---------------------------------------------------------------------------
check_java() {
  echo "=== java (${JAVA_LOCK_FILE}) ==="

  if [[ ! -f "$JAVA_LOCK_FILE" ]]; then
    echo "  Lock file not found, skipping."
    return
  fi

  # Extract artifact:version pairs that changed.
  # maven_install.json has structure: "artifacts": { "group:artifact": { "version": "X" } }
  # We compare the artifact versions between base and HEAD.
  local head_versions base_versions

  head_versions=$(jq -r '.artifacts | to_entries[] | "\(.key):\(.value.version)"' "$JAVA_LOCK_FILE" | sort)
  base_versions=$(git show "${BASE_REF}:${JAVA_LOCK_FILE}" 2>/dev/null \
    | jq -r '.artifacts | to_entries[] | "\(.key):\(.value.version)"' 2>/dev/null | sort) || true

  local changed
  if [[ -z "$base_versions" ]]; then
    # No base version — all artifacts are new
    changed="$head_versions"
  else
    changed=$(comm -23 <(echo "$head_versions") <(echo "$base_versions")) || true
  fi

  if [[ -z "$changed" ]]; then
    echo "  No new/changed artifacts."
    return
  fi

  while IFS= read -r entry; do
    # entry format: group:artifact:version
    local version="${entry##*:}"
    local group_artifact="${entry%:*}"
    local group="${group_artifact%%:*}"
    local artifact="${group_artifact#*:}"

    [[ -z "$group" || -z "$artifact" || -z "$version" ]] && continue

    local timestamp_ms
    timestamp_ms=$(curl -sf "https://search.maven.org/solrsearch/select?q=g:${group}+AND+a:${artifact}+AND+v:${version}&rows=1&wt=json" \
      | jq -r '.response.docs[0].timestamp // empty' 2>/dev/null) || true

    if [[ -z "$timestamp_ms" ]]; then
      continue
    fi

    local publish_epoch=$((timestamp_ms / 1000))
    check_age java "${group}:${artifact}" "$version" "$publish_epoch"
  done <<< "$changed"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "Dependency age check — minimum age: ${MIN_AGE_DAYS} days, base ref: ${BASE_REF}"
echo ""

IFS=',' read -ra eco_list <<< "$ECOSYSTEMS"
for eco in "${eco_list[@]}"; do
  eco=$(echo "$eco" | xargs)  # trim whitespace
  case "$eco" in
    npm)    check_npm ;;
    python) check_python ;;
    rust)   check_rust ;;
    java)   check_java ;;
    *)      echo "Unknown ecosystem: $eco" >&2; exit 1 ;;
  esac
  echo ""
done

echo "Checked ${TOTAL_CHECKED} packages across [${ECOSYSTEMS}], ${TOTAL_FAILURES} failed the ${MIN_AGE_DAYS}-day age gate."

if [[ "$TOTAL_FAILURES" -gt 0 ]]; then
  echo ""
  echo "To override, set min-age-days to 0 or wait for packages to age past the threshold."
  exit 1
fi
