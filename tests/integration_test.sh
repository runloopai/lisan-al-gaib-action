#!/usr/bin/env bash
# Integration tests for check-dep-age.sh
# Hits real package registries with known packages to verify end-to-end behavior.
# Uses synthetic git repos with real package names/versions.
#
# Requires: curl, jq, git (network access to npm, PyPI, crates.io, Maven Central)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
TESTS_RUN=0

assert_exit_code() {
  local label="$1" expected="$2" actual="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    FAIL=$((FAIL + 1))
  fi
}

setup_git_repo() {
  local test_dir
  test_dir=$(mktemp -d)
  git init -q "$test_dir"
  git -C "$test_dir" config user.email "test@test.com"
  git -C "$test_dir" config user.name "Test"
  echo "$test_dir"
}

# ---------------------------------------------------------------------------
# Integration: all ecosystems with old, well-known packages (should all pass)
# ---------------------------------------------------------------------------
test_all_ecosystems_old_packages() {
  echo "--- test: all ecosystems pass with old packages ---"
  local test_dir orig_dir
  test_dir=$(setup_git_repo)
  orig_dir=$(pwd)
  cd "$test_dir"

  # Base: empty files
  mkdir -p python java/rust
  echo 'lockfileVersion: "9.0"' > pnpm-lock.yaml
  echo 'version = 1' > python/uv.lock
  cat > java/rust/rust.MODULE.bazel << 'BAZEL'
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")
BAZEL
  cat > java/maven_install.json << 'JSON'
{"artifacts": {}, "conflict_resolution": {}}
JSON
  git add -A && git commit -q -m "base"

  # Add well-known old packages from each ecosystem
  cat > pnpm-lock.yaml << 'YAML'
lockfileVersion: '9.0'
packages:
  'express@4.18.2':
    resolution: {integrity: sha512-abc}
YAML

  cat > python/uv.lock << 'TOML'
version = 1

[[package]]
name = "requests"
version = "2.31.0"
source = { registry = "https://pypi.org/simple" }
TOML

  cat > java/rust/rust.MODULE.bazel << 'BAZEL'
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")

crate.spec(
    package = "serde",
    version = "1.0.210",
)
BAZEL

  cat > java/maven_install.json << 'JSON'
{
  "artifacts": {
    "com.fasterxml.jackson.core:jackson-databind": {
      "shasums": {"jar": "abc"},
      "version": "2.17.2"
    }
  },
  "conflict_resolution": {}
}
JSON
  git add -A && git commit -q -m "add old deps"

  local output exit_code=0
  output=$(INPUT_ECOSYSTEMS=npm,python,rust,java \
    INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_NPM_LOCKFILE=pnpm-lock.yaml \
    INPUT_PYTHON_LOCKFILE_GLOB="**/uv.lock" \
    INPUT_RUST_MODULE_FILE=java/rust/rust.MODULE.bazel \
    INPUT_JAVA_LOCK_FILE=java/maven_install.json \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  echo "$output"
  echo ""

  assert_exit_code "all old packages pass" 0 "$exit_code"
  assert_contains "checked multiple packages" "$output" "Checked"

  cd "$orig_dir"
  rm -rf "$test_dir"
}

# ---------------------------------------------------------------------------
# Integration: verify registry connectivity per ecosystem
# ---------------------------------------------------------------------------
test_npm_registry_reachable() {
  echo "--- test: npm registry returns publish dates ---"
  local output
  output=$(curl -sf "https://registry.npmjs.org/express" \
    | jq -r '.time["4.18.2"] // "MISSING"') || output="CURL_FAILED"

  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$output" != "MISSING" && "$output" != "CURL_FAILED" ]]; then
    echo "  PASS: npm registry returned date: $output"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: npm registry unreachable or missing data ($output)"
    FAIL=$((FAIL + 1))
  fi
}

test_pypi_registry_reachable() {
  echo "--- test: PyPI registry returns publish dates ---"
  local output
  output=$(curl -sf "https://pypi.org/pypi/requests/2.31.0/json" \
    | jq -r '.urls[0].upload_time_iso_8601 // "MISSING"') || output="CURL_FAILED"

  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$output" != "MISSING" && "$output" != "CURL_FAILED" ]]; then
    echo "  PASS: PyPI registry returned date: $output"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: PyPI registry unreachable or missing data ($output)"
    FAIL=$((FAIL + 1))
  fi
}

test_crates_registry_reachable() {
  echo "--- test: crates.io registry returns publish dates ---"
  local output
  output=$(curl -sf -H "User-Agent: dependency-age-check-test" \
    "https://crates.io/api/v1/crates/serde" \
    | jq -r '.versions[] | select(.num == "1.0.210") | .created_at // "MISSING"') || output="CURL_FAILED"

  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$output" != "MISSING" && "$output" != "CURL_FAILED" ]]; then
    echo "  PASS: crates.io registry returned date: $output"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: crates.io registry unreachable or missing data ($output)"
    FAIL=$((FAIL + 1))
  fi
}

test_maven_registry_reachable() {
  echo "--- test: Maven Central returns publish dates ---"
  local output
  output=$(curl -sf "https://search.maven.org/solrsearch/select?q=g:com.fasterxml.jackson.core+AND+a:jackson-databind+AND+v:2.17.2&rows=1&wt=json" \
    | jq -r '.response.docs[0].timestamp // "MISSING"') || output="CURL_FAILED"

  TESTS_RUN=$((TESTS_RUN + 1))
  if [[ "$output" != "MISSING" && "$output" != "CURL_FAILED" ]]; then
    echo "  PASS: Maven Central returned timestamp: $output"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: Maven Central unreachable or missing data ($output)"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
echo "======================================="
echo "  Integration Tests"
echo "======================================="
echo ""

echo "-- Registry connectivity --"
test_npm_registry_reachable
test_pypi_registry_reachable
test_crates_registry_reachable
test_maven_registry_reachable
echo ""

echo "-- End-to-end --"
test_all_ecosystems_old_packages

echo ""
echo "======================================="
echo "  Results: ${PASS} passed, ${FAIL} failed (${TESTS_RUN} total)"
echo "======================================="

[[ "$FAIL" -eq 0 ]]
