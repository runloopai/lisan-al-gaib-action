# Project overview

This is a GitHub Action (TypeScript, node24 runtime) that checks whether newly added or updated dependencies were published recently enough to be a supply-chain risk. It supports npm/pnpm/yarn/bun, Python (uv/pylock), Rust (Bazel crate.spec), Java (Bazel maven.install), Bazel module dependencies (MODULE.bazel.lock + BCR), GitHub Actions (workflow/composite action `uses:` directives), Bazel multitool binaries, container images in rendered Kubernetes manifests, and container images in Dockerfiles/Containerfiles.

# Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript + bundle with ncc → dist/index.js
pnpm test             # Run vitest unit tests
pnpm typecheck        # Run tsc --noEmit
pnpm lint             # Run eslint on src/ and __tests__/
pnpm local            # Run locally against remote default branch
pnpm local -- --diff  # Run locally against dirty changes
pnpm local -- --all   # Check ALL dependencies
```

After any code change, run `pnpm build` and commit the `dist/` folder — the action runs `dist/index.js` directly.

# Architecture

```
src/
  main.ts              # Entry point / orchestrator (GitHub Actions)
  cli.ts               # CLI entry point for local runs
  inputs.ts            # Parse action.yml inputs
  base-ref.ts          # Auto-detect base git ref from event context
  diff.ts              # Git operations (diff, show, glob resolution)
  registry.ts          # Fetch publish dates from npm/pypi/crates.io/maven/BCR/GitHub/OCI; OCI image config labels
  report.ts            # GitHub annotations, job summary, remediation hints
  bazel.ts             # tree-sitter Starlark parser for MODULE.bazel
  license.ts           # SPDX license compatibility checking, registry license fetching (npm/PyPI/crates/Maven/GitHub/BCR/OCI image labels)
  ecosystems/
    types.ts           # Shared interfaces (ChangedDep, CheckResult, etc.)
    npm.ts             # Parse pnpm/npm/yarn/bun lockfiles via lockparse
    python.ts          # Parse uv.lock and pylock.toml via smol-toml
    rust.ts            # Extract crate.spec() from MODULE.bazel, diff HEAD vs base; resolve ranges to concrete versions via MODULE.bazel.lock; skip if resolved version already on base
    java.ts            # Extract maven.install() from MODULE.bazel, diff lock JSON
    bazel-module.ts    # Parse MODULE.bazel.lock for bazel_dep modules, handle overrides
    actions.ts         # Parse workflow YAML for uses: directives; resolve tag refs to commit SHAs to skip no-op ref changes; query GitHub API for publish dates
    multitool.ts       # Parse multitool.hub() lockfiles, diff HEAD vs base
    kubernetes.ts      # Parse rendered k8s manifests for container images; compare base-vs-HEAD by resolved identity (name@digest) to skip no-op relabels; query OCI registry
    image.ts           # Shared OCI image helpers: parseImageRef, makeName, makeVersion, getImagePublishDate
    docker.ts          # Parse Dockerfiles/Containerfiles for FROM/COPY/RUN base images, query OCI registry
```

## Flow

1. `main.ts` reads inputs, resolves the base ref (PR base SHA, push before, HEAD~1, etc.), validates it exists
2. For each ecosystem, the corresponding `ecosystems/*.ts` module diffs HEAD vs base lockfiles to find changed packages
3. Each changed package's publish date is fetched from the appropriate registry (`registry.ts`)
4. License compliance is checked via `license.ts` — directional SPDX compatibility (dep license → project target license)
5. `report.ts` emits GitHub error/warning annotations, a job summary table, and package manager remediation hints

## Key design decisions

- **Structured parsers only**: `lockparse` for JS lockfiles, `smol-toml` for Python TOML, `web-tree-sitter` (WASM) for Starlark, `js-yaml` for k8s manifests. No regex-based parsing.
- **Kubernetes ecosystem — rendered manifests only**: The action parses already-rendered YAML (output of `helm template` or similar), not raw Helm chart sources. Only `@sha256:`-digest-pinned images are age-gated; tag-only images are mutable and reported as `unknown`. Registry lookup uses the OCI Distribution v2 API anonymously; private registries → `unknown`. License checking reads the `org.opencontainers.image.licenses` OCI config-blob label, falling back to `org.opencontainers.image.source` (GitHub) if the licenses label is absent.
- **Docker ecosystem — Dockerfile/Containerfile parsing**: Uses `dockerfile-ast` (structured parser, no regex) to extract `FROM`, `COPY --from=`, and `RUN --mount=...,from=` image references. Build-stage aliases, numeric stage indices, unresolved `$VAR` references, and image references whose repository path is not a legal OCI name (e.g. placeholder tokens like `__DIND_IMAGE__`, uppercase names) are filtered out. `COPY --from` and `RUN --mount=from` values are only included when the registry positively confirms the image exists (HTTP 200); values that are unconfirmed — HTTP 404 (named build contexts, typos) or ambiguous HTTP 401/429 (→ `unknown`) — are info-logged and omitted. If Docker Hub rate-limits an existence check, a configured `dockerhub-mirror` (e.g. `mirror.gcr.io`) is tried as fallback; if it confirms `found`, the image is included. `FROM` base images are accepted without an existence check (they are unambiguous real image references). Only `bind` and `cache` mount types are considered for `RUN --mount`. Auto-detect matches exact `Dockerfile`/`Containerfile` basenames only (case-insensitive); non-standard names require the `dockerfiles` input. Shares the same OCI age-gate and license-check logic as the kubernetes ecosystem via `ecosystems/image.ts`.
- **Diff-aware**: Only packages that changed between base and HEAD are checked. Unchanged packages are skipped.
- **`web-tree-sitter` over native `tree-sitter`**: WASM-based to avoid native addon issues with `@vercel/ncc` bundling.
- **`minimumReleaseAge`**: The project itself uses pnpm's `minimumReleaseAge` (in `pnpm-workspace.yaml`) to prevent installing packages younger than 14 days.
- **Auto-detection**: When lockfile inputs are empty, the action auto-detects changed lockfiles from the git diff.

## Base ref resolution (base-ref.ts)

Supports all major GitHub event types:
- `pull_request` / `pull_request_target`: PR base SHA
- `push`: `payload.before`
- `merge_group`: `payload.merge_group.base_sha`
- `release`: `payload.release.target_commitish`
- `schedule`, `workflow_dispatch`, `workflow_call`, `workflow_run`: `HEAD~1`

Falls back to `HEAD~1` → `origin/main` → empty tree if the resolved ref doesn't exist.

### Bazel parsing (bazel.ts)

Uses `web-tree-sitter` with `tree-sitter-starlark` WASM to parse MODULE.bazel files:
- `resolveModuleFiles(path)`: Recursively follows `include()` statements
- `extractCrateSpecs(content)`: Finds `crate.spec(package=..., version=...)` calls
- `extractMavenInstalls(content)`: Finds `maven.install(lock_file=..., repositories=..., artifacts=...)` calls
- `extractOverrides(content)`: Finds `git_override`, `archive_override`, `local_path_override`, `single_version_override`, `multiple_version_override` calls
- `extractMultitoolHubs(content)`: Finds `multitool.hub(name=..., lockfile=...)` calls

## Testing

Tests are in `__tests__/` using vitest:
- `bazel.test.ts` — tree-sitter Starlark parsing (crate.spec, maven.install, multitool.hub)
- `parsers.test.ts` — Lockfile parsing for all formats (pnpm, npm, yarn, bun, uv, pylock)
- `report.test.ts` — Status determination boundary conditions
- `license.test.ts` — SPDX license compatibility and detection
- `multitool.test.ts` — Multitool lockfile parsing and diffing
- `actions.test.ts` — GitHub Actions workflow parsing
- `kubernetes.test.ts` — Kubernetes manifest image parsing, diff logic, and OCI registry lookups
- `docker.test.ts` — Dockerfile/Containerfile image parsing (FROM, COPY --from, RUN --mount)

Run tests: `pnpm test`

# CI

`.github/workflows/ci.yml` runs on PRs and pushes to main:
- **lint job**: typecheck, lint, test, build, verify dist/ is up to date
- **self-test job**: runs the action on its own codebase (`ecosystems: npm,actions`)

# Dependencies

## Runtime
- `@actions/core`, `@actions/exec`, `@actions/github`, `@actions/glob` — GitHub Actions toolkit
- `lockparse` — Parse pnpm/npm/yarn/bun lockfiles
- `smol-toml` — Parse TOML (uv.lock, pylock.toml)
- `web-tree-sitter`, `tree-sitter-starlark` — Parse Starlark/Bazel files
- `spdx-correct`, `spdx-satisfies`, `spdx-expression-parse`, `spdx-osi` — SPDX license parsing and compatibility
- `fast-xml-parser` — Parse Maven POM XML for license extraction
- `tar-stream` — Extract LICENSE files from tarballs
- `dockerfile-ast` — Parse Dockerfiles/Containerfiles (from the VS Code Docker extension maintainer)
- `js-yaml` — Parse YAML inputs (target-licenses, overrides)
- `semver` — Semver version comparison

## Dev
- `typescript`, `@vercel/ncc` — Build toolchain
- `vitest` — Test framework
- `eslint`, `typescript-eslint`, `@eslint/js` — Linting
