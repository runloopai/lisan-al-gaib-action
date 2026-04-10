import { describe, it, expect } from "vitest";
import { findChangedPackages as findNpmChanges } from "../src/ecosystems/npm.js";
import { findChangedPackages as findPythonChanges } from "../src/ecosystems/python.js";

// ─── npm / pnpm / yarn / bun (via lockparse) ───────────────────────────────

function pnpmLock(pkgs: Record<string, string>): string {
  const importerDeps = Object.entries(pkgs)
    .map(([name, ver]) => `      ${name}:\n        specifier: ^${ver}\n        version: ${ver}`)
    .join("\n");
  const packages = Object.entries(pkgs)
    .map(([name, ver]) => `  '${name}@${ver}':\n    resolution: {integrity: sha512-test}`)
    .join("\n\n");
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:
  .:
    dependencies:
${importerDeps}

packages:

${packages}
`;
}

describe("npm: pnpm-lock.yaml", () => {
  it("detects new packages", async () => {
    const head = pnpmLock({ express: "4.18.2", lodash: "4.17.21" });
    const base = pnpmLock({ lodash: "4.17.21" });
    const deps = await findNpmChanges(head, base, "pnpm-lock.yaml");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("express");
    expect(deps[0].version).toBe("4.18.2");
  });

  it("detects version changes", async () => {
    const head = pnpmLock({ express: "4.19.0" });
    const base = pnpmLock({ express: "4.18.2" });
    const deps = await findNpmChanges(head, base, "pnpm-lock.yaml");
    expect(deps).toHaveLength(1);
    expect(deps[0].version).toBe("4.19.0");
  });

  it("returns empty when nothing changed", async () => {
    const content = pnpmLock({ express: "4.18.2" });
    expect(await findNpmChanges(content, content, "pnpm-lock.yaml")).toEqual([]);
  });

  it("treats null base as all-new", async () => {
    const head = pnpmLock({ express: "4.18.2" });
    const deps = await findNpmChanges(head, null, "pnpm-lock.yaml");
    expect(deps).toHaveLength(1);
  });
});

describe("npm: package-lock.json", () => {
  it("detects new packages", async () => {
    const head = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/express": {
          version: "4.18.2",
          resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz",
        },
      },
    });
    const base = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "root", version: "1.0.0" } },
    });
    const deps = await findNpmChanges(head, base, "package-lock.json");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("express");
    expect(deps[0].version).toBe("4.18.2");
  });

  it("handles scoped packages", async () => {
    const head = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "1.0.0" },
        "node_modules/@types/node": { version: "20.0.0" },
      },
    });
    const deps = await findNpmChanges(head, null, "package-lock.json");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("@types/node");
    expect(deps[0].version).toBe("20.0.0");
  });
});

describe("npm: yarn.lock", () => {
  it("detects new packages (v1 format)", async () => {
    const head = `# yarn lockfile v1

express@^4.18.0:
  version "4.18.2"
  resolved "https://registry.yarnpkg.com/express/-/express-4.18.2.tgz"
`;
    const base = `# yarn lockfile v1
`;
    const deps = await findNpmChanges(head, base, "yarn.lock");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("express");
    expect(deps[0].version).toBe("4.18.2");
  });
});

describe("npm: bun.lock", () => {
  it("detects new packages", async () => {
    const head = JSON.stringify({
      lockfileVersion: 0,
      workspaces: { "": { name: "root", dependencies: { express: "^4.18.0" } } },
      packages: {
        express: ["express@4.18.2", "", {}, "sha512-abc"],
      },
    });
    const base = JSON.stringify({
      lockfileVersion: 0,
      workspaces: { "": { name: "root" } },
      packages: {},
    });
    const deps = await findNpmChanges(head, base, "bun.lock");
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("express");
    expect(deps[0].version).toBe("4.18.2");
  });
});

// ─── Python: uv.lock ────────────────────────────────────────────────────────

describe("python: uv.lock", () => {
  it("detects new packages", () => {
    const head = `version = 1

[[package]]
name = "requests"
version = "2.31.0"

[[package]]
name = "flask"
version = "3.0.0"
`;
    const base = `version = 1

[[package]]
name = "requests"
version = "2.31.0"
`;
    const deps = findPythonChanges(head, base, "uv.lock");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      ecosystem: "python",
      name: "flask",
      version: "3.0.0",
      file: "uv.lock",
    });
  });

  it("detects version changes", () => {
    const head = `version = 1

[[package]]
name = "requests"
version = "2.32.0"
`;
    const base = `version = 1

[[package]]
name = "requests"
version = "2.31.0"
`;
    const deps = findPythonChanges(head, base, "uv.lock");
    expect(deps).toHaveLength(1);
    expect(deps[0].version).toBe("2.32.0");
  });

  it("returns empty when nothing changed", () => {
    const content = `version = 1

[[package]]
name = "requests"
version = "2.31.0"
`;
    expect(findPythonChanges(content, content, "uv.lock")).toEqual([]);
  });

  it("treats null base as all-new", () => {
    const head = `version = 1

[[package]]
name = "requests"
version = "2.31.0"
`;
    const deps = findPythonChanges(head, null, "uv.lock");
    expect(deps).toHaveLength(1);
  });
});

// ─── Python: pylock.toml (PEP 751) ─────────────────────────────────────────

describe("python: pylock.toml", () => {
  it("detects new packages", () => {
    const head = `lock-version = "1.0"

[[packages]]
name = "attrs"
version = "25.1.0"

[[packages]]
name = "cattrs"
version = "24.1.2"
`;
    const base = `lock-version = "1.0"

[[packages]]
name = "attrs"
version = "25.1.0"
`;
    const deps = findPythonChanges(head, base, "pylock.toml");
    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({
      ecosystem: "python",
      name: "cattrs",
      version: "24.1.2",
      file: "pylock.toml",
    });
  });

  it("handles packages without version (VCS)", () => {
    const head = `lock-version = "1.0"

[[packages]]
name = "my-lib"

[[packages]]
name = "attrs"
version = "25.1.0"
`;
    const deps = findPythonChanges(head, null, "pylock.toml");
    // VCS package without version should be skipped
    expect(deps).toHaveLength(1);
    expect(deps[0].name).toBe("attrs");
  });
});
