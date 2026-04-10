# Project overview

This is a GitHub Action (TypeScript, node24 runtime) that checks whether newly added or updated dependencies were published recently enough to be a supply-chain risk. It supports npm/pnpm/yarn/bun, Python (uv/pylock), Rust (Bazel crate.spec), Java (Bazel maven.install), Bazel module dependencies (MODULE.bazel.lock + BCR), and GitHub Actions (workflow/composite action `uses:` directives).

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
  registry.ts          # Fetch publish dates from npm/pypi/crates.io/maven/BCR/GitHub
  report.ts            # GitHub annotations, job summary, remediation hints
  bazel.ts             # tree-sitter Starlark parser for MODULE.bazel
  ecosystems/
    types.ts           # Shared interfaces (ChangedDep, CheckResult, etc.)
    npm.ts             # Parse pnpm/npm/yarn/bun lockfiles via lockparse
    python.ts          # Parse uv.lock and pylock.toml via smol-toml
    rust.ts            # Extract crate.spec() from MODULE.bazel, diff HEAD vs base
    java.ts            # Extract maven.install() from MODULE.bazel, diff lock JSON
    bazel-module.ts    # Parse MODULE.bazel.lock for bazel_dep modules, handle overrides
    actions.ts         # Parse workflow YAML for uses: directives, query GitHub API
```

## Flow

1. `main.ts` reads inputs, resolves the base ref (PR base SHA, push before, HEAD~1, etc.), validates it exists
2. For each ecosystem, the corresponding `ecosystems/*.ts` module diffs HEAD vs base lockfiles to find changed packages
3. Each changed package's publish date is fetched from the appropriate registry (`registry.ts`)
4. `report.ts` emits GitHub error/warning annotations, a job summary table, and package manager remediation hints

## Key design decisions

- **Structured parsers only**: `lockparse` for JS lockfiles, `smol-toml` for Python TOML, `web-tree-sitter` (WASM) for Starlark. No regex-based parsing.
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

## Testing

Tests are in `__tests__/` using vitest:
- `bazel.test.ts` — tree-sitter Starlark parsing (crate.spec, maven.install)
- `parsers.test.ts` — Lockfile parsing for all formats (pnpm, npm, yarn, bun, uv, pylock)
- `report.test.ts` — Status determination boundary conditions

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

## Dev
- `typescript`, `@vercel/ncc` — Build toolchain
- `vitest` — Test framework
- `eslint`, `typescript-eslint`, `@eslint/js` — Linting
