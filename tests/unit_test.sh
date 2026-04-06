#!/usr/bin/env bash
# Unit tests for check-dep-age.sh
# Creates temp git repos with synthetic lockfile content and mocks curl
# to verify extraction logic per ecosystem without hitting real registries.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACTION_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
TESTS_RUN=0

# ---------------------------------------------------------------------------
# Test harness
# ---------------------------------------------------------------------------
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected to contain: $needle"
    echo "    got: $haystack"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  TESTS_RUN=$((TESTS_RUN + 1))
  if ! echo "$haystack" | grep -qF "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    echo "    expected NOT to contain: $needle"
    FAIL=$((FAIL + 1))
  fi
}

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

# ---------------------------------------------------------------------------
# Setup: create a temp dir with a mock curl that returns canned responses
# ---------------------------------------------------------------------------
setup_test_env() {
  local test_dir
  test_dir=$(mktemp -d)

  # Create a mock curl script
  mkdir -p "$test_dir/bin"
  cat > "$test_dir/bin/curl" << 'MOCK_CURL'
#!/usr/bin/env bash
# Mock curl: return canned responses based on URL patterns
for arg in "$@"; do
  url="$arg"
done

# npm: express
if [[ "$url" == *"registry.npmjs.org/express"* ]]; then
  # Publish date far in the past — should pass age gate
  cat <<'JSON'
{"time":{"4.18.2":"2022-10-08T17:33:17.025Z","99.0.0-fake-new":"2099-01-01T00:00:00.000Z"}}
JSON
  exit 0
fi

# PyPI: requests
if [[ "$url" == *"pypi.org/pypi/requests/2.31.0"* ]]; then
  cat <<'JSON'
{"urls":[{"upload_time_iso_8601":"2023-05-22T15:12:44.236Z"}]}
JSON
  exit 0
fi
if [[ "$url" == *"pypi.org/pypi/fake-new-pkg/0.0.1"* ]]; then
  cat <<'JSON'
{"urls":[{"upload_time_iso_8601":"2099-01-01T00:00:00.000Z"}]}
JSON
  exit 0
fi

# crates.io: serde
if [[ "$url" == *"crates.io/api/v1/crates/serde"* ]]; then
  cat <<'JSON'
{"versions":[{"num":"1.0.210","created_at":"2024-08-13T00:00:00.000Z"},{"num":"99.0.0","created_at":"2099-01-01T00:00:00.000Z"}]}
JSON
  exit 0
fi

# Maven Central: jackson-databind
if [[ "$url" == *"search.maven.org"*"jackson-databind"* ]]; then
  # timestamp in ms — 2024-01-15 (well in the past)
  cat <<'JSON'
{"response":{"docs":[{"timestamp":1705276800000}]}}
JSON
  exit 0
fi
if [[ "$url" == *"search.maven.org"*"fake-artifact"* ]]; then
  # Future timestamp
  cat <<'JSON'
{"response":{"docs":[{"timestamp":4102444800000}]}}
JSON
  exit 0
fi

# Default: return empty (package not found)
echo "{}"
exit 0
MOCK_CURL
  chmod +x "$test_dir/bin/curl"

  echo "$test_dir"
}

# Create a temp git repo with initial content, then modify it
# $1 = test_dir, $2 = ecosystem name
setup_git_repo() {
  local test_dir="$1"
  local repo_dir="$test_dir/repo"
  mkdir -p "$repo_dir"
  git init -q "$repo_dir"
  git -C "$repo_dir" config user.email "test@test.com"
  git -C "$repo_dir" config user.name "Test"
  cd "$repo_dir"
}

# ---------------------------------------------------------------------------
# npm tests
# ---------------------------------------------------------------------------
test_npm_detects_new_packages() {
  echo "--- test: npm detects new packages ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  # Base commit: empty lockfile
  cat > pnpm-lock.yaml << 'YAML'
lockfileVersion: '9.0'
packages: {}
YAML
  git add -A && git commit -q -m "base"

  # Add packages
  cat > pnpm-lock.yaml << 'YAML'
lockfileVersion: '9.0'
packages:
  'express@4.18.2':
    resolution: {integrity: sha512-abc}
  '99.0.0-fake-new@99.0.0':
    resolution: {integrity: sha512-xyz}
YAML
  git add -A && git commit -q -m "add deps"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=npm INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_NPM_LOCKFILE=pnpm-lock.yaml \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_contains "reports checked packages" "$output" "Checked"
  assert_not_contains "old package does not fail" "$output" "FAIL: express@4.18.2"

  rm -rf "$test_dir"
}

test_npm_passes_when_no_changes() {
  echo "--- test: npm passes with no lockfile changes ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  cat > pnpm-lock.yaml << 'YAML'
lockfileVersion: '9.0'
packages:
  'express@4.18.2':
    resolution: {integrity: sha512-abc}
YAML
  git add -A && git commit -q -m "base"
  # No changes — diff is empty

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=npm INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD \
    INPUT_NPM_LOCKFILE=pnpm-lock.yaml \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_exit_code "exits 0 with no changes" 0 "$exit_code"
  assert_contains "reports no changes" "$output" "No new/changed packages"

  rm -rf "$test_dir"
}

# ---------------------------------------------------------------------------
# Python tests
# ---------------------------------------------------------------------------
test_python_detects_new_packages() {
  echo "--- test: python detects new packages ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  # Base: empty lock
  cat > uv.lock << 'TOML'
version = 1
requires-python = ">=3.12"
TOML
  git add -A && git commit -q -m "base"

  # Add packages
  cat > uv.lock << 'TOML'
version = 1
requires-python = ">=3.12"

[[package]]
name = "requests"
version = "2.31.0"
source = { registry = "https://pypi.org/simple" }

[[package]]
name = "fake-new-pkg"
version = "0.0.1"
source = { registry = "https://pypi.org/simple" }
TOML
  git add -A && git commit -q -m "add deps"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=python INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_PYTHON_LOCKFILE_GLOB=uv.lock \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_contains "reports checked packages" "$output" "Checked"
  assert_not_contains "old package does not fail" "$output" "FAIL: requests@2.31.0"
  assert_contains "new package fails" "$output" "FAIL: fake-new-pkg@0.0.1"

  rm -rf "$test_dir"
}

test_python_handles_multiple_lockfiles() {
  echo "--- test: python handles multiple uv.lock files ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  mkdir -p pkg_a pkg_b
  echo 'version = 1' > pkg_a/uv.lock
  echo 'version = 1' > pkg_b/uv.lock
  git add -A && git commit -q -m "base"

  cat > pkg_a/uv.lock << 'TOML'
version = 1

[[package]]
name = "requests"
version = "2.31.0"
TOML
  cat > pkg_b/uv.lock << 'TOML'
version = 1

[[package]]
name = "fake-new-pkg"
version = "0.0.1"
TOML
  git add -A && git commit -q -m "add deps"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=python INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_PYTHON_LOCKFILE_GLOB="**/uv.lock" \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_contains "finds packages across lockfiles" "$output" "Checked"
  assert_contains "finds new package from pkg_b" "$output" "fake-new-pkg"

  rm -rf "$test_dir"
}

# ---------------------------------------------------------------------------
# Rust tests
# ---------------------------------------------------------------------------
test_rust_detects_new_crates() {
  echo "--- test: rust detects new crates ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  cat > rust.MODULE.bazel << 'BAZEL'
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")
BAZEL
  git add -A && git commit -q -m "base"

  cat > rust.MODULE.bazel << 'BAZEL'
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")

crate.spec(
    package = "serde",
    version = "1.0.210",
    features = ["derive"],
)
BAZEL
  git add -A && git commit -q -m "add serde"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=rust INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_RUST_MODULE_FILE=rust.MODULE.bazel \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_contains "reports checked crates" "$output" "Checked"
  assert_not_contains "old crate does not fail" "$output" "FAIL: serde"

  rm -rf "$test_dir"
}

test_rust_skips_git_sourced_crates() {
  echo "--- test: rust skips git-sourced crates ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  cat > rust.MODULE.bazel << 'BAZEL'
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")
BAZEL
  git add -A && git commit -q -m "base"

  cat > rust.MODULE.bazel << 'BAZEL'
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")

crate.spec(
    git = "https://github.com/example/custom-crate.git",
    package = "custom-crate",
    version = "0.1.0",
    rev = "abc123",
)
BAZEL
  git add -A && git commit -q -m "add git crate"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=rust INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_RUST_MODULE_FILE=rust.MODULE.bazel \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_exit_code "exits 0 for git crates" 0 "$exit_code"
  assert_not_contains "does not check git crate" "$output" "FAIL: custom-crate"

  rm -rf "$test_dir"
}

# ---------------------------------------------------------------------------
# Java tests
# ---------------------------------------------------------------------------
test_java_detects_new_artifacts() {
  echo "--- test: java detects new artifacts ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  cat > maven_install.json << 'JSON'
{
  "artifacts": {},
  "conflict_resolution": {}
}
JSON
  git add -A && git commit -q -m "base"

  cat > maven_install.json << 'JSON'
{
  "artifacts": {
    "com.fasterxml.jackson.core:jackson-databind": {
      "shasums": {"jar": "abc123"},
      "version": "2.19.1"
    }
  },
  "conflict_resolution": {}
}
JSON
  git add -A && git commit -q -m "add jackson"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=java INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_JAVA_LOCK_FILE=maven_install.json \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_contains "reports checked artifacts" "$output" "Checked"
  assert_not_contains "old artifact does not fail" "$output" "FAIL: com.fasterxml.jackson.core:jackson-databind"

  rm -rf "$test_dir"
}

test_java_detects_version_bumps() {
  echo "--- test: java detects version bumps ---"
  local test_dir
  test_dir=$(setup_test_env)
  setup_git_repo "$test_dir"

  cat > maven_install.json << 'JSON'
{
  "artifacts": {
    "com.example:fake-artifact": {
      "shasums": {"jar": "old"},
      "version": "1.0.0"
    }
  },
  "conflict_resolution": {}
}
JSON
  git add -A && git commit -q -m "base"

  cat > maven_install.json << 'JSON'
{
  "artifacts": {
    "com.example:fake-artifact": {
      "shasums": {"jar": "new"},
      "version": "2.0.0"
    }
  },
  "conflict_resolution": {}
}
JSON
  git add -A && git commit -q -m "bump version"

  local output exit_code=0
  output=$(PATH="$test_dir/bin:$PATH" \
    INPUT_ECOSYSTEMS=java INPUT_MIN_AGE_DAYS=14 INPUT_BASE_REF=HEAD~1 \
    INPUT_JAVA_LOCK_FILE=maven_install.json \
    bash "$ACTION_DIR/check-dep-age.sh" 2>&1) || exit_code=$?

  assert_contains "detects version bump as new" "$output" "fake-artifact"
  assert_contains "future-dated package fails" "$output" "FAIL"

  rm -rf "$test_dir"
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
echo "======================================="
echo "  Unit Tests"
echo "======================================="
echo ""

test_npm_detects_new_packages
test_npm_passes_when_no_changes
echo ""
test_python_detects_new_packages
test_python_handles_multiple_lockfiles
echo ""
test_rust_detects_new_crates
test_rust_skips_git_sourced_crates
echo ""
test_java_detects_new_artifacts
test_java_detects_version_bumps

echo ""
echo "======================================="
echo "  Results: ${PASS} passed, ${FAIL} failed (${TESTS_RUN} total)"
echo "======================================="

[[ "$FAIL" -eq 0 ]]
