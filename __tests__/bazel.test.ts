import { describe, it, expect } from "vitest";
import { extractCrateSpecs, extractMavenInstalls, extractOverrides } from "../src/bazel.js";

describe("extractCrateSpecs", () => {
  it("extracts package and version from crate.spec()", async () => {
    const content = `
crate = use_extension("@rules_rust//crate_universe:extension.bzl", "crate")
crate.spec(
    package = "serde",
    version = "1.0.200",
)
crate.spec(
    package = "tokio",
    version = "1.37.0",
    features = ["full"],
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toEqual({ package: "serde", version: "1.0.200", isGit: false });
    expect(specs[1]).toEqual({ package: "tokio", version: "1.37.0", isGit: false });
  });

  it("marks git-sourced crates", async () => {
    const content = `
crate.spec(
    package = "my-crate",
    version = "0.1.0",
    git = "https://github.com/example/my-crate.git",
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].isGit).toBe(true);
  });

  it("returns empty for no crate.spec calls", async () => {
    const content = `module(name = "my_project")`;
    expect(await extractCrateSpecs(content)).toEqual([]);
  });
});

describe("extractMavenInstalls", () => {
  it("extracts lock_file, repositories, and artifacts", async () => {
    const content = `
maven = use_extension("@rules_jvm_external//:extensions.bzl", "maven")
maven.install(
    lock_file = "//:maven_install.json",
    repositories = [
        "https://repo1.maven.org/maven2",
        "https://maven.google.com",
    ],
    artifacts = [
        "com.google.guava:guava:31.1-jre",
        "junit:junit:4.13.2",
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    expect(installs[0].lockFile).toBe("maven_install.json");
    expect(installs[0].repositories).toEqual([
      "https://repo1.maven.org/maven2",
      "https://maven.google.com",
    ]);
    expect(installs[0].artifacts).toEqual([
      "com.google.guava:guava:31.1-jre",
      "junit:junit:4.13.2",
    ]);
  });

  it("handles named installs", async () => {
    const content = `
maven.install(
    name = "server",
    lock_file = "//server:maven_install.json",
    repositories = ["https://repo1.maven.org/maven2"],
    artifacts = ["com.google.guava:guava:31.1-jre"],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    expect(installs[0].name).toBe("server");
    expect(installs[0].lockFile).toBe("server:maven_install.json");
  });

  it("handles multiple maven.install blocks", async () => {
    const content = `
maven.install(
    name = "app1",
    lock_file = "//:app1_lock.json",
    repositories = ["https://repo1.maven.org/maven2"],
    artifacts = ["junit:junit:4.13.2"],
)
maven.install(
    name = "app2",
    lock_file = "//:app2_lock.json",
    repositories = ["https://maven.google.com"],
    artifacts = ["com.google.guava:guava:31.1-jre"],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(2);
    expect(installs[0].name).toBe("app1");
    expect(installs[1].name).toBe("app2");
  });

  it("skips maven.install without lock_file", async () => {
    const content = `
maven.install(
    artifacts = ["junit:junit:4.13.2"],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toEqual([]);
  });
});

describe("extractOverrides", () => {
  it("extracts git_override with commit", async () => {
    const content = `
git_override(
    module_name = "rules_python",
    remote = "https://github.com/bazelbuild/rules_python.git",
    commit = "abc123def456",
)
`;
    const overrides = await extractOverrides(content);
    expect(overrides.size).toBe(1);
    const o = overrides.get("rules_python")!;
    expect(o.type).toBe("git");
    expect(o.remote).toBe("https://github.com/bazelbuild/rules_python.git");
    expect(o.commit).toBe("abc123def456");
  });

  it("extracts git_override with tag and branch", async () => {
    const content = `
git_override(
    module_name = "my_dep",
    remote = "https://github.com/org/repo.git",
    tag = "v1.0.0",
    branch = "main",
)
`;
    const overrides = await extractOverrides(content);
    const o = overrides.get("my_dep")!;
    expect(o.tag).toBe("v1.0.0");
    expect(o.branch).toBe("main");
  });

  it("extracts archive_override with urls", async () => {
    const content = `
archive_override(
    module_name = "my_lib",
    urls = [
        "https://example.com/my_lib-1.0.tar.gz",
        "https://mirror.com/my_lib-1.0.tar.gz",
    ],
)
`;
    const overrides = await extractOverrides(content);
    const o = overrides.get("my_lib")!;
    expect(o.type).toBe("archive");
    expect(o.urls).toEqual([
      "https://example.com/my_lib-1.0.tar.gz",
      "https://mirror.com/my_lib-1.0.tar.gz",
    ]);
  });

  it("extracts local_path_override", async () => {
    const content = `
local_path_override(
    module_name = "my_local",
    path = "/home/user/my_local",
)
`;
    const overrides = await extractOverrides(content);
    const o = overrides.get("my_local")!;
    expect(o.type).toBe("local_path");
  });

  it("extracts single_version_override", async () => {
    const content = `
single_version_override(
    module_name = "protobuf",
    version = "29.3",
    registry = "https://my-registry.com",
)
`;
    const overrides = await extractOverrides(content);
    const o = overrides.get("protobuf")!;
    expect(o.type).toBe("single_version");
    expect(o.version).toBe("29.3");
    expect(o.registry).toBe("https://my-registry.com");
  });

  it("extracts multiple_version_override", async () => {
    const content = `
multiple_version_override(
    module_name = "rules_java",
    versions = ["8.12.0", "8.11.0"],
    registry = "https://bcr.bazel.build",
)
`;
    const overrides = await extractOverrides(content);
    const o = overrides.get("rules_java")!;
    expect(o.type).toBe("multiple_version");
    expect(o.versions).toEqual(["8.12.0", "8.11.0"]);
    expect(o.registry).toBe("https://bcr.bazel.build");
  });

  it("handles multiple overrides in same file", async () => {
    const content = `
git_override(
    module_name = "dep_a",
    remote = "https://github.com/org/a.git",
    commit = "abc",
)
local_path_override(
    module_name = "dep_b",
    path = "/local/b",
)
single_version_override(
    module_name = "dep_c",
    version = "2.0",
)
`;
    const overrides = await extractOverrides(content);
    expect(overrides.size).toBe(3);
    expect(overrides.get("dep_a")!.type).toBe("git");
    expect(overrides.get("dep_b")!.type).toBe("local_path");
    expect(overrides.get("dep_c")!.type).toBe("single_version");
  });

  it("returns empty for no overrides", async () => {
    const content = `module(name = "my_project")`;
    const overrides = await extractOverrides(content);
    expect(overrides.size).toBe(0);
  });
});
