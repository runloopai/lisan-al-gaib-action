# Dependency Age Check

A GitHub Action that acts as a supply-chain security gate by failing if newly added or updated packages were published less than a configurable number of days ago.

## Supported ecosystems

| Ecosystem | Lockfiles | Registry |
|-----------|-----------|----------|
| **npm** | `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock` | npm registry |
| **python** | `uv.lock`, `pylock.toml` (PEP 751) | PyPI |
| **rust** | `MODULE.bazel` with `crate.spec()` | crates.io |
| **java** | `MODULE.bazel` with `maven.install()` + JSON lock files | Maven Central / custom repos |
| **bazel** | `MODULE.bazel.lock` | Bazel Central Registry (BCR) |
| **actions** | `.github/workflows/*.yml`, `action.yml` | GitHub API |

## Quick start

```yaml
- uses: your-org/dependency-age-check-action@main
  with:
    ecosystems: npm
```

## Supported event types

The action auto-detects the base ref to diff against based on the GitHub event:

| Event | Base ref |
|-------|----------|
| `pull_request` / `pull_request_target` | PR base SHA |
| `push` | `payload.before` SHA |
| `merge_group` | Merge group base SHA |
| `release` | `target_commitish` |
| `schedule`, `workflow_dispatch`, `workflow_call`, `workflow_run` | `HEAD~1` |

Falls back to `HEAD~1`, then `origin/main`, then the empty tree (initial commit) if the resolved ref doesn't exist.

You can always override with the `base-ref` input.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `ecosystems` | Yes | | Comma-separated list: `npm`, `python`, `rust`, `java`, `bazel`, `actions` |
| `min-age-days` | No | `14` | Minimum days since publication to pass |
| `warn-age-days` | No | `21` | Age threshold for warnings (between min and warn = warning, above = pass) |
| `base-ref` | No | auto-detect | Git ref to diff against |
| `node-lockfiles` | No | auto-detect | Newline-separated glob patterns for Node.js lockfiles |
| `python-lockfiles` | No | auto-detect | Newline-separated glob patterns for Python lockfiles |
| `module-bazel` | No | `MODULE.bazel` | Path to root MODULE.bazel (for rust/java/bazel ecosystems) |
| `module-bazel-lock` | No | `MODULE.bazel.lock` | Path to MODULE.bazel.lock (for bazel ecosystem) |
| `workflow-files` | No | auto-detect | Newline-separated glob patterns for workflow files (for actions ecosystem) |
| `strict-third-party` | No | `false` | Fail (instead of warn) on archive overrides without `Last-Modified` and third-party branch-pinned actions |
| `bypass-keyword` | No | `""` | If the PR body contains this string on a line by itself, failures are downgraded to warnings |
| `check-all-on-new-workflow` | No | `true` | Check all packages (not just changed) when the workflow file is newly added |
| `github-token` | No | `${{ github.token }}` | GitHub token for API queries (actions and bazel ecosystems) |
| `npm-registry-url` | No | `https://registry.npmjs.org` | npm registry URL |
| `pypi-registry-url` | No | `https://pypi.org` | PyPI registry URL |
| `crates-registry-url` | No | `https://crates.io` | crates.io registry URL |
| `maven-registry-url` | No | `https://repo1.maven.org/maven2` | Maven Central registry URL |
| `allowed-licenses` | No | `auto` | Comma-separated SPDX license IDs. `auto` uses a default permissive set (MIT, ISC, BSD, Apache-2.0, etc.). Empty string disables license checking. |

## Outputs

| Output | Description |
|--------|-------------|
| `total-checked` | Number of packages checked |
| `total-failures` | Number of packages that failed the age gate |
| `total-warnings` | Number of packages in the warning zone |
| `license-violations` | Number of packages with incompatible licenses |

## Examples

### Check npm dependencies on PRs

```yaml
name: Dependency Check
on: pull_request

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: runloopai/dependency-age-check-action@main
        with:
          ecosystems: npm
```

### Multiple ecosystems with custom thresholds

```yaml
- uses: your-org/dependency-age-check-action@main
  with:
    ecosystems: npm,python,rust,java
    min-age-days: "7"
    warn-age-days: "14"
```

### Scheduled scan

```yaml
name: Weekly Dependency Scan
on:
  schedule:
    - cron: "0 9 * * 1"

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - uses: your-org/dependency-age-check-action@main
        with:
          ecosystems: npm,python
```

### Monorepo with multiple lockfiles

```yaml
- uses: your-org/dependency-age-check-action@main
  with:
    ecosystems: npm
    node-lockfiles: |
      apps/*/pnpm-lock.yaml
      packages/*/package-lock.json
```

### Check GitHub Actions versions

```yaml
- uses: your-org/dependency-age-check-action@main
  with:
    ecosystems: actions
```

Actions pinned to a branch (e.g. `@main`) are skipped. Actions pinned to a tag (e.g. `@v4`) or commit SHA are checked against the GitHub API for their publish/commit date.

### Check Bazel module dependencies

```yaml
- uses: your-org/dependency-age-check-action@main
  with:
    ecosystems: bazel
```

Parses `MODULE.bazel.lock` for resolved module versions and queries the Bazel Central Registry. Handles overrides from `MODULE.bazel`:
- **`git_override`**: checks the commit/tag/branch date via GitHub API
- **`archive_override`**: checks the archive URL's `Last-Modified` header
- **`local_path_override`**: skipped
- **`single_version_override`** / **`multiple_version_override`**: checked against BCR with the overridden version

### License compliance

```yaml
- uses: runloopai/dependency-age-check-action@main
  with:
    ecosystems: npm
    # Use default permissive license set
    allowed-licenses: auto

    # Or specify exactly which licenses are allowed
    # allowed-licenses: "MIT,Apache-2.0,ISC,BSD-2-Clause,BSD-3-Clause"

    # Disable license checking
    # allowed-licenses: ""
```

For every analyzed dependency, the action fetches the license from the package registry (npm, PyPI, crates.io, Maven POM, GitHub API, BCR metadata) and checks it against the allowed list using SPDX expression matching. Incompatible licenses produce error annotations and fail the check.

### Custom registry URL

```yaml
- uses: your-org/dependency-age-check-action@main
  with:
    ecosystems: npm
    npm-registry-url: "https://npm.pkg.github.com"
```

## Remediation

When violations are detected, the action suggests package manager-level settings to prevent installing young packages:

| Package manager | Config file | Setting |
|----------------|-------------|---------|
| pnpm | `pnpm-workspace.yaml` | `minimumReleaseAge: 20160` (minutes) |
| yarn | `.yarnrc.yml` | `npmMinimalAgeGate: "14d"` |
| bun | `bunfig.toml` | `[install] minimumReleaseAge = 1209600` (seconds) |
| uv | `pyproject.toml` | `[tool.uv] exclude-newer = "14 days"` |

## How it works

1. **Resolve base ref** from the GitHub event context (PR base, push before, etc.)
2. **Detect changed lockfiles** by diffing HEAD against the base ref
3. **Parse lockfiles** using structured parsers (`lockparse` for npm/pnpm/yarn/bun, `smol-toml` for Python, `web-tree-sitter` for Bazel/Starlark)
4. **Compare** HEAD vs base lockfile contents to find new or version-changed packages
5. **Query registries** for each changed package's publish date
6. **Report** results as GitHub annotations (errors/warnings) and a job summary table

For Rust and Java ecosystems, the action parses `MODULE.bazel` using a tree-sitter Starlark grammar, resolving recursive `include()` statements to find all `crate.spec()` and `maven.install()` blocks.

For the Bazel ecosystem, it parses `MODULE.bazel.lock` (JSON) to find resolved module versions and extracts override directives (`git_override`, `archive_override`, etc.) from `MODULE.bazel` files.

For the Actions ecosystem, it parses workflow YAML files for `uses:` directives, determines whether each ref is a tag or commit SHA (branches are skipped), and queries the GitHub API for the associated date.

## Bypass for emergency fixes

If you need to merge a PR with a dependency that fails the age gate (e.g., a critical 0-day vulnerability fix), set the `bypass-keyword` input:

```yaml
- uses: runloopai/dependency-age-check-action@main
  with:
    ecosystems: npm
    bypass-keyword: "DEPENDENCY-AGE-BYPASS"
```

The bypass is detected from any of the following (whichever matches first):

1. **PR body** — include the keyword on its own line:
   ```
   This PR updates lodash to fix CVE-2025-XXXX.

   DEPENDENCY-AGE-BYPASS
   ```
2. **PR label** — add a label named exactly `DEPENDENCY-AGE-BYPASS` to the PR
3. **Commit message** — include the keyword on its own line in the HEAD commit message (useful for `push`, `workflow_dispatch`, and other non-PR events)

The action will still report the failures as warnings but will not fail the check.

> **Note:** If using label-based bypass, add `labeled` and `unlabeled` to the `pull_request` event types so the workflow re-runs when labels change:
> ```yaml
> on:
>   pull_request:
>     types: [opened, reopened, synchronize, edited, labeled, unlabeled]
> ```
> The `edited` type ensures the workflow re-runs when the PR body is changed to add the keyword.

## Running locally

You can run the check on a local repository without GitHub Actions:

```bash
# Install dependencies
pnpm install

# Compare against remote default branch (e.g., origin/main)
pnpm local -- --ecosystems npm

# Compare dirty (uncommitted) changes against HEAD
pnpm local -- --diff --ecosystems npm

# Compare against a specific ref
pnpm local -- --base-ref origin/release-2.0 --ecosystems npm,python

# Check ALL dependencies (not just changed)
pnpm local -- --all --ecosystems npm

# With custom thresholds
pnpm local -- --ecosystems npm --min-age-days 7 --warn-age-days 14
```

### CLI options

| Option | Description |
|--------|-------------|
| `--ecosystems <list>` | Comma-separated ecosystems (default: `npm`) |
| `--base-ref <ref>` | Git ref to diff against (default: remote default branch) |
| `--diff` | Compare working tree against `HEAD` |
| `--all` | Check all dependencies (uses empty tree as base) |
| `--min-age-days <n>` | Minimum age in days (default: `14`) |
| `--warn-age-days <n>` | Warning threshold in days (default: `21`) |
| `--github-token <t>` | GitHub token (default: `$GITHUB_TOKEN` env var) |

You can also run directly with Node after building:

```bash
pnpm build
node out/cli.js --ecosystems npm --diff
```
