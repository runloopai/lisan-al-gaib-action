# Lisan al-Gaib

A GitHub Action that acts as a supply-chain security gate by failing if newly added or updated packages were published less than a configurable number of days ago.

## Supported ecosystems

| Ecosystem | Lockfiles | Registry |
|-----------|-----------|----------|
| **npm** | `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock` | npm registry |
| **python** | `uv.lock`, `*.py.lock` (script lockfiles), `pylock.toml` (PEP 751) | PyPI |
| **rust** | `MODULE.bazel` with `crate.spec()` + `MODULE.bazel.lock` | crates.io |
| **java** | `MODULE.bazel` with `maven.install()` + JSON lock files | Maven Central / custom repos |
| **bazel** | `MODULE.bazel.lock` | Bazel Central Registry (BCR) |
| **actions** | `.github/workflows/*.yml`, `action.yml` | GitHub API |
| **multitool** | `multitool.hub()` lockfiles via `MODULE.bazel` | Archive `Last-Modified` headers |
| **kubernetes** | Rendered Kubernetes manifests (`*.yaml`/`*.yml`) | OCI registry v2 API (anonymous; digest-pinned only) |
| **docker** | `Dockerfile`, `Containerfile` (exact basename; use `dockerfiles:` input for other names) | OCI registry v2 API (anonymous; digest-pinned only) |

## Quick start

```yaml
- uses: runloopai/lisan-al-gaib-action@main
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
| `ecosystems` | Yes | | Comma-separated list: `npm`, `python`, `rust`, `java`, `bazel`, `actions`, `multitool`, `kubernetes`, `docker` |
| `min-age-days` | No | `14` | Minimum days since publication to pass |
| `warn-age-days` | No | `21` | Age threshold for warnings (between min and warn = warning, above = pass) |
| `base-ref` | No | auto-detect | Git ref to diff against |
| `node-lockfiles` | No | auto-detect | Newline-separated glob patterns for Node.js lockfiles |
| `python-lockfiles` | No | auto-detect | Newline-separated glob patterns for Python lockfiles |
| `module-bazel` | No | `MODULE.bazel` | Path to root MODULE.bazel (for rust/java/bazel/multitool ecosystems) |
| `workflow-files` | No | auto-detect | Newline-separated glob patterns for workflow files (for actions ecosystem) |
| `kubernetes-files` | No | auto-detect | Newline-separated glob patterns for rendered Kubernetes manifest files (for kubernetes ecosystem). See usage note below. |
| `dockerfiles` | No | auto-detect | Newline-separated glob patterns for Dockerfile/Containerfile paths (for docker ecosystem). Auto-detect matches any changed file whose basename is exactly `Dockerfile` or `Containerfile` (case-insensitive). Use this input for non-standard names (`myapp.Dockerfile`, `Dockerfile.prod`, etc.). |
| `dockerhub-mirror` | No | `""` | Docker Hub mirror hostname (e.g. `mirror.gcr.io`) to use as a fallback when the primary Docker Hub check is rate-limited (HTTP 429) while resolving `COPY --from` / `RUN --mount=from` references. |
| `strict-third-party` | No | `false` | Fail (instead of warn) on archive overrides without `Last-Modified` and third-party branch-pinned actions |
| `bypass-keyword` | No | `""` | If the PR body contains this string on a line by itself, failures are downgraded to warnings |
| `check-all-on-new-workflow` | No | `true` | Check all packages (not just changed) when the workflow file is newly added |
| `github-token` | No | `${{ github.token }}` | GitHub token for API queries (actions and bazel ecosystems) |
| `npm-registry-url` | No | `https://registry.npmjs.org` | npm registry URL |
| `pypi-registry-url` | No | `https://pypi.org` | PyPI registry URL |
| `crates-registry-url` | No | `https://crates.io` | crates.io registry URL |
| `maven-registry-url` | No | `https://repo1.maven.org/maven2` | Maven Central registry URL |
| `target-licenses` | No | `auto` | SPDX license(s) your project is distributed under. Deps must be compatible with the target. Supports per-ecosystem YAML map, special aliases (`open-source`, `open-source-no-strong-copyleft`, `open-source-no-relinkable-copyleft`, `open-source-no-network-copyleft`), or `auto` to detect from `package.json`/`LICENSE` (falls back to `open-source-no-relinkable-copyleft` if detection fails). Empty string disables license checking. |
| `allowed-licenses` | No | `""` | **Deprecated** — use `target-licenses`. Ignored when `target-licenses` is set. |
| `age-overrides` | No | `""` | YAML map of `ecosystem → list of package names` to skip age checking for specific packages |
| `license-overrides` | No | `""` | YAML map of `ecosystem → package → SPDX license or "ignore"` to override or skip license checking |
| `license-heuristics` | No | `false` | When true, infer licenses from LICENSE/README file text using heuristic matching. When false, only use registry metadata and GitHub API. |
| `bcr-url` | No | `https://bcr.bazel.build` | Bazel Central Registry URL |

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
      - uses: runloopai/lisan-al-gaib-action@main
        with:
          ecosystems: npm
```

### Multiple ecosystems with custom thresholds

```yaml
- uses: runloopai/lisan-al-gaib-action@main
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
      - uses: runloopai/lisan-al-gaib-action@main
        with:
          ecosystems: npm,python
```

### Monorepo with multiple lockfiles

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: npm
    node-lockfiles: |
      apps/*/pnpm-lock.yaml
      packages/*/package-lock.json
```

### Check GitHub Actions versions

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: actions
```

Actions pinned to a branch (e.g. `@main`) are skipped. Actions pinned to a tag (e.g. `@v4`) or commit SHA are checked against the GitHub API for their publish/commit date.

When a `uses:` ref changes between base and HEAD (e.g. `@v4` → `@v4.1.0`), both refs are resolved to their underlying commit SHA via the GitHub API. If they resolve to the same commit, the action is **skipped** — the PR didn't actually introduce a new version and checking it would be a false positive. If resolution fails or the SHAs differ, the action is checked (conservative fallback).

### Check Bazel module dependencies

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: bazel
```

Parses `MODULE.bazel.lock` for resolved module versions and queries the Bazel Central Registry. Handles overrides from `MODULE.bazel`:
- **`git_override`**: checks the commit/tag/branch date via GitHub API
- **`archive_override`**: checks the archive URL's `Last-Modified` header
- **`local_path_override`**: skipped
- **`single_version_override`** / **`multiple_version_override`**: checked against BCR with the overridden version

### Check container images in Kubernetes manifests

The `kubernetes` ecosystem parses **rendered** Kubernetes manifests for container
image references and age-gates images pinned with a `@sha256:` digest against the
OCI registry API. Tag-only images (no digest) are reported as `unknown` — they are
mutable and cannot be reliably age-gated.

When image references change between base and HEAD (e.g. `nginx:1.25@sha256:X` →
`nginx:1.25.1@sha256:X`), the action compares by **resolved identity** —
`registry/repository@digest` for digest-pinned images — rather than the raw
manifest string. A relabeled tag pointing at a digest that was already on the base
branch is **skipped** (that image content was already vetted). Genuinely new
digests are checked regardless of tag label.

**The consuming repo must render charts to plain YAML before invoking the action.**
For example, run `helm template` in an earlier CI step and either commit the output
or pass it via `kubernetes-files`.

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0

  # Render charts to a committed manifests directory, or generate them in CI
  - name: Render Helm charts
    run: helm template my-chart ./charts/my-chart > rendered/manifests.yaml

  - uses: runloopai/lisan-al-gaib-action@main
    with:
      ecosystems: kubernetes
      kubernetes-files: rendered/manifests.yaml
```

Push timestamps are sourced from registry-specific APIs where available:
- **Docker Hub** (`docker.io`): Hub API `tag_last_pushed` (accurate, per-tag push time)
- **Other public registries** (`public.ecr.aws`, `ghcr.io`, `quay.io`, `registry.k8s.io`):
  `Last-Modified` HTTP header on the manifest response — a best-effort signal not
  guaranteed by the OCI Distribution spec; registries that don't emit this header
  will report `unknown` even for publicly accessible images

Images on private registries (AWS ECR private, GCP Artifact Registry, self-hosted)
that reject anonymous pulls are always reported as `unknown`.

**License checking** for container images reads the `org.opencontainers.image.licenses`
OCI label from the image config blob, falling back to the `org.opencontainers.image.source`
label (if it points to a GitHub repo) for images that omit the licenses label. Images
with neither label report `unknown`. This is the primary application's declared license —
not a full inventory of every OS package baked into the image.

### Check Dockerfile base images

The `docker` ecosystem parses `Dockerfile` and `Containerfile` files for base image
references in `FROM`, `COPY --from=`, and `RUN --mount=...,from=` directives. The same
OCI age-gate and license-check logic as the kubernetes ecosystem applies: only
`@sha256:`-digest-pinned images are age-gated; tag-only references are reported as
`unknown`.

Build-stage aliases (from `FROM ... AS <name>`), numeric stage indices (e.g. `--from=0`),
and unresolved ARG/ENV variables (`$VAR`) are filtered out automatically. `COPY --from`
and `RUN --mount=from` values that don't resolve to a real registry image (named build
contexts, typos) are info-logged and omitted from the report. Only `bind` and `cache`
mount types are considered; `secret`, `ssh`, `tmpfs`, and other special mounts are
ignored.

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: docker
```

By default the action auto-detects any changed file whose basename (case-insensitive)
is exactly `Dockerfile` or `Containerfile`. For non-standard names (`Dockerfile.prod`,
`myapp.Dockerfile`, etc.), use the `dockerfiles` input explicitly:

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: docker
    dockerfiles: |
      services/*/Dockerfile
      infra/Containerfile
```

### License compliance

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: npm
    # Auto-detect your project's license from package.json or LICENSE file.
    # Falls back to open-source-no-relinkable-copyleft if detection fails.
    target-licenses: auto

    # Or specify your project's license explicitly
    # target-licenses: "MIT"

    # Per-ecosystem targets (YAML map)
    # target-licenses: |
    #   "*": Apache-2.0
    #   rust: Apache-2.0, MIT
    #   npm: MIT

    # Special aliases:
    # target-licenses: "open-source"                           # any OSI-approved license
    # target-licenses: "open-source-no-relinkable-copyleft"    # OSI minus LGPL/GPL/AGPL (allows MPL, CDDL, EPL)
    # target-licenses: "open-source-no-strong-copyleft"        # OSI minus GPL/AGPL (allows LGPL, MPL, CDDL, EPL)
    # target-licenses: "open-source-no-network-copyleft"       # OSI minus AGPL

    # Disable license checking
    # target-licenses: ""
```

For every analyzed dependency, the action fetches the license from the package registry (npm, PyPI, crates.io, Maven POM, GitHub API, BCR metadata, OCI image labels) and checks **directional compatibility** — whether the dependency's license allows incorporation into a project under your target license. This uses a full SPDX compatibility matrix (permissive → copyleft flow, GPL version compatibility, weak copyleft rules, etc.). Incompatible licenses produce error annotations and fail the check.

### License and age overrides

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: npm,python
    age-overrides: |
      npm:
        - some-legacy-package
      python:
        - internal-tool
    license-overrides: |
      npm:
        custom-pkg: MIT
      actions:
        owner/repo: ignore
```

When license violations or unknown licenses are detected, the action suggests a `license-overrides` block as a colored git diff of your workflow file.

### Check Bazel multitool binaries

```yaml
- uses: runloopai/lisan-al-gaib-action@main
  with:
    ecosystems: multitool
```

Parses `multitool.hub()` calls from `MODULE.bazel` (following `include()` statements), finds the referenced lockfiles, and diffs HEAD vs base to detect changed tool binaries. Each binary's publish date is checked via the `Last-Modified` header of its download URL.

### Custom registry URL

```yaml
- uses: runloopai/lisan-al-gaib-action@main
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
| uv | `pyproject.toml` or `uv.toml` | `[tool.uv] exclude-newer = "14 days"` |

## How it works

1. **Resolve base ref** from the GitHub event context (PR base, push before, etc.)
2. **Detect changed lockfiles** by diffing HEAD against the base ref
3. **Parse lockfiles** using structured parsers (`lockparse` for npm/pnpm/yarn/bun, `smol-toml` for Python, `web-tree-sitter` for Bazel/Starlark)
4. **Compare** HEAD vs base lockfile contents to find new or version-changed packages
5. **Query registries** for each changed package's publish date
6. **Report** results as GitHub annotations (errors/warnings) and a job summary table

For Rust and Java ecosystems, the action parses `MODULE.bazel` using a tree-sitter Starlark grammar, resolving recursive `include()` statements to find all `crate.spec()` and `maven.install()` blocks. For Rust, `crate.spec()` version requirements are semver ranges (e.g. `~0.13.5`) — the action resolves each to its concrete pinned version via `MODULE.bazel.lock`'s crate_universe extension data, so the exact published version is checked rather than the range string. Only crates whose resolved concrete version is **newly introduced** vs the base `MODULE.bazel.lock` are checked — a no-op range edit (e.g. `^0.13.5` → `~0.13.5`) that resolves to the same version already on the base branch is **skipped**.

For the Bazel ecosystem, it parses `MODULE.bazel.lock` (JSON) to find resolved module versions and extracts override directives (`git_override`, `archive_override`, etc.) from `MODULE.bazel` files.

For the Actions ecosystem, it parses workflow YAML files for `uses:` directives, determines whether each ref is a tag or commit SHA (branches are skipped), and queries the GitHub API for the associated date.

For the Multitool ecosystem, it finds `multitool.hub()` calls in `MODULE.bazel`, reads the referenced lockfiles (JSON), and checks each binary's download URL for a `Last-Modified` header.

## Bypass for emergency fixes

If you need to merge a PR with a dependency that fails the age gate (e.g., a critical 0-day vulnerability fix), set the `bypass-keyword` input:

```yaml
- uses: runloopai/lisan-al-gaib-action@main
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

## Etymology

**Lisan al-Gaib** (لسان الغيب, "Voice from the Outer World") is a messianic figure in Frank Herbert's *Dune* universe — the prophesied leader who would deliver the Fremen from oppression. In the story, the Lisan al-Gaib defeats **Shai-Hulud**, the colossal sandworms that dominate the deserts of Arrakis.

The name is fitting for this action because **Shai-Hulud** is also the name given to a series of devastating npm supply chain attacks that began in September 2025. The Shai-Hulud worm compromised over 500 npm packages — collectively downloaded 132 million times per month — by hijacking maintainer credentials and automatically republishing all of a victim's packages with malicious payloads. Like its namesake sandworm, the malware burrowed through the ecosystem, using TruffleHog to scan for secrets (GitHub tokens, AWS/GCP/Azure keys) and self-replicating across every package owned by a compromised maintainer. A second wave in November 2025 impacted tens of thousands of GitHub repositories.

Just as the Lisan al-Gaib tamed the sandworms, this action guards your repository against the supply chain threats that Shai-Hulud exploited — by ensuring that newly published packages have had time to be vetted by the community before they enter your dependency tree.
