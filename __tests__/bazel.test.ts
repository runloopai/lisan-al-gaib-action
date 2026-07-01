import { describe, it, expect } from "vitest";
import { extractCrateSpecs, extractMavenInstalls, extractMavenArtifacts, extractBazelDeps, extractOverrides, extractMultitoolHubs, resolveBazelLabel } from "../src/bazel.js";

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
    expect(specs[0]).toMatchObject({ package: "serde", version: "1.0.200", isGit: false });
    expect(specs[1]).toMatchObject({ package: "tokio", version: "1.37.0", isGit: false });
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
    expect(installs[0].artifacts.map((a) => a.coord)).toEqual([
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
    expect(installs[0].lockFile).toBe("server/maven_install.json");
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

describe("extractMultitoolHubs", () => {
  it("extracts lockfile paths from multitool.hub() calls", async () => {
    const content = `
bazel_dep(name = "rules_multitool", version = "1.11.1", dev_dependency = True)
multitool = use_extension("@rules_multitool//multitool:extension.bzl", "multitool")
multitool.hub(lockfile = "//:prebuilt_buildtools.json")
use_repo(multitool, "multitool")
`;
    const hubs = await extractMultitoolHubs(content);
    expect(hubs).toEqual(["prebuilt_buildtools.json"]);
  });

  it("handles multiple hub calls", async () => {
    const content = `
multitool.hub(lockfile = "//:tools1.json")
multitool.hub(lockfile = "//sub:tools2.json")
`;
    const hubs = await extractMultitoolHubs(content);
    expect(hubs).toEqual(["tools1.json", "sub/tools2.json"]);
  });

  it("returns empty array when no multitool.hub calls", async () => {
    const content = `bazel_dep(name = "rules_go", version = "0.50.1")`;
    const hubs = await extractMultitoolHubs(content);
    expect(hubs).toEqual([]);
  });

  it("skips hub calls without lockfile kwarg", async () => {
    const content = `
multitool.hub(lockfile = "//:valid.json")
multitool.hub(name = "something_else")
`;
    const hubs = await extractMultitoolHubs(content);
    expect(hubs).toEqual(["valid.json"]);
  });
});

describe("resolveBazelLabel", () => {
  it("resolves //pkg:file relative to workspace root", () => {
    expect(resolveBazelLabel("//rust:rust.MODULE.bazel", "/ws", "/ws/sub")).toBe(
      "/ws/rust/rust.MODULE.bazel",
    );
  });

  it("resolves //:file relative to workspace root", () => {
    expect(resolveBazelLabel("//:maven_install.json", "/ws", "/ws/sub")).toBe(
      "/ws/maven_install.json",
    );
  });

  it("resolves :file relative to current dir", () => {
    expect(resolveBazelLabel(":foo.json", "/ws", "/ws/sub")).toBe(
      "/ws/sub/foo.json",
    );
  });

  it("resolves plain paths relative to current dir", () => {
    expect(resolveBazelLabel("foo.json", "/ws", "/ws/sub")).toBe(
      "/ws/sub/foo.json",
    );
  });

  it("handles //pkg without colon", () => {
    expect(resolveBazelLabel("//tools/lockfile.json", "/ws", "/ws")).toBe(
      "/ws/tools/lockfile.json",
    );
  });
});

// ─── Constant variable + interpolation resolution ────────────────────────────

describe("extractCrateSpecs — constant variable resolution", () => {
  it("bare constant version: version = FOO_VERSION resolves to the constant's value", async () => {
    const content = `
SERDE_VERSION = "1.0.200"
crate.spec(
    package = "serde",
    version = SERDE_VERSION,
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ package: "serde", version: "1.0.200" });
    expect(specs[0].versionRef?.constantName).toBe("SERDE_VERSION");
    expect(specs[0].versionRef?.templatePrefix).toBe("");
    expect(specs[0].versionRef?.templateSuffix).toBe("");
  });

  it("unknown constant is skipped", async () => {
    const content = `
crate.spec(
    package = "serde",
    version = UNKNOWN_CONST,
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(0);
  });

  it("direct literal still works and sets versionRef with no constantName", async () => {
    const content = `
crate.spec(package = "serde", version = "1.0.150")
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].version).toBe("1.0.150");
    expect(specs[0].versionRef?.constantName).toBeUndefined();
    expect(specs[0].versionRef?.templatePrefix).toBe("");
  });

  it("r-prefixed string constant is skipped — would corrupt offsets", async () => {
    // r"..." is valid Starlark but the r-byte shifts startIndex+1 by one, producing
    // a wrong rewrite offset. The parser must skip such constants entirely.
    const content = `
SERDE_VERSION = r"1.0.200"
crate.spec(
    package = "serde",
    version = SERDE_VERSION,
)
`;
    const specs = await extractCrateSpecs(content);
    // Constant is unparseable → dep using it cannot be resolved → should be absent.
    expect(specs).toHaveLength(0);
  });

  it("b-prefixed string constant is skipped", async () => {
    const content = `
SERDE_VERSION = b"1.0.200"
crate.spec(
    package = "serde",
    version = SERDE_VERSION,
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(0);
  });

  it("r-prefixed version literal is skipped", async () => {
    const content = `
crate.spec(package = "serde", version = r"1.0.150")
`;
    const specs = await extractCrateSpecs(content);
    // Literal is prefixed — extractString returns null — should produce no version ref.
    expect(specs).toHaveLength(0);
  });

  it("prefixed constant coexists with valid dep — valid dep resolves with correct offsets", async () => {
    // Ensures that a r"…" constant being skipped doesn't corrupt the offset of an
    // adjacent plain-string dep in the same file. The offset of the plain dep's
    // version literal must exactly bracket the "1.0.200" text in the source.
    const content = `SKIPPED_VERSION = r"9.9.9"
SERDE_VERSION = "1.0.200"
crate.spec(
    package = "skipped",
    version = SKIPPED_VERSION,
)
crate.spec(
    package = "serde",
    version = SERDE_VERSION,
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].package).toBe("serde");
    expect(specs[0].version).toBe("1.0.200");
    // versionNodeStart/End should bracket exactly "1.0.200" (without quotes)
    const { versionNodeStart, versionNodeEnd } = specs[0];
    expect(content.slice(versionNodeStart, versionNodeEnd)).toBe("1.0.200");
  });
});

describe("extractBazelDeps — constant variable resolution", () => {
  it("bare constant version: version = PROTOBUF_VERSION resolves to the constant's value", async () => {
    const content = `
PROTOBUF_VERSION = "32.1"
bazel_dep(name = "protobuf", version = PROTOBUF_VERSION)
`;
    const deps = await extractBazelDeps(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ name: "protobuf", version: "32.1" });
    expect(deps[0].versionRef?.constantName).toBe("PROTOBUF_VERSION");
  });

  it("direct literal string still works", async () => {
    const content = `bazel_dep(name = "rules_rust", version = "0.50.0")`;
    const deps = await extractBazelDeps(content);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ name: "rules_rust", version: "0.50.0" });
  });

  it("reassigned constant is dropped — dep using it is skipped", async () => {
    // MY_VERSION is assigned twice; the second assignment makes it ambiguous.
    // The dep referencing it must be skipped entirely (not resolved to either value).
    const content = `
MY_VERSION = "1.0.0"
MY_VERSION = "2.0.0"
bazel_dep(name = "mymod", version = MY_VERSION)
`;
    const deps = await extractBazelDeps(content);
    expect(deps).toHaveLength(0);
  });

  it("forward-reference is not resolved — dep before constant definition is skipped", async () => {
    // The dep appears before MY_VERSION is defined. The parser must not resolve it.
    const content = `
bazel_dep(name = "mymod", version = MY_VERSION)
MY_VERSION = "1.0.0"
`;
    const deps = await extractBazelDeps(content);
    // Either skipped (length 0) or returned with no versionRef (version unknown)
    if (deps.length > 0) {
      expect(deps[0].versionRef).toBeUndefined();
    }
  });
});

describe("extractCrateSpecs — %%s template guard", () => {
  it("rejects interpolation template containing %% (escaped percent)", async () => {
    // "%%s" in Starlark means literal "%s", not a format slot — must be rejected
    const content = `
VER = "1.0.0"
crate.spec(package = "foo", version = "prefix-%%s" % VER)
`;
    const specs = await extractCrateSpecs(content);
    // Must not resolve the interpolation — whether the spec is dropped or versionRef cleared.
    expect(specs.flatMap((s) => (s.versionRef !== undefined ? [s.versionRef.value] : []))).toHaveLength(0);
  });
});

describe("extractCrateSpecs — trailing/bare % in template guard", () => {
  // Regression: after splitting on %s, any remaining % in prefix or suffix indicates
  // an unhandled Python format conversion (e.g. trailing %, %(name)s, %*s). These must
  // be rejected fail-closed so a fuzzed MODULE.bazel can never produce a corrupted constant.
  it("rejects '%s-100%' (trailing bare % in suffix)", async () => {
    const content = `
VER = "1.0"
crate.spec(package = "foo", version = "%s-100%" % VER)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs.flatMap((s) => (s.versionRef !== undefined ? [s.versionRef.value] : []))).toHaveLength(0);
  });

  it("rejects '%(name)s' style mapping key in prefix", async () => {
    const content = `
VER = "1.0"
crate.spec(package = "foo", version = "%(name)s-suffix" % VER)
`;
    const specs = await extractCrateSpecs(content);
    // Must not produce a valid versionRef (template with mapping key is not supported)
    expect(specs.flatMap((s) => (s.versionRef !== undefined ? [s.versionRef.value] : []))).toHaveLength(0);
  });

  it("accepts '4.%s' (no stray % remains after split)", async () => {
    // Control: a clean template still resolves correctly.
    // versionRef.value is the effective resolved value (prefix + constant value),
    // e.g. "4.33.0" for template "4.%s" with VER="33.0".
    const content = `
VER = "33.0"
crate.spec(package = "foo", version = "4.%s" % VER)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].versionRef?.value).toBe("4.33.0");
    expect(specs[0].versionRef?.templatePrefix).toBe("4.");
  });
});

describe("extractCrateSpecs — H2: mid-token %s separator boundary guard", () => {
  // H2 regression: templates like "1%s" where the %s is NOT at a separator boundary
  // (`.`, `:`, `-`, `/`, `+`) must be rejected. Without this guard, VER="0.0" would
  // resolve "1%s" % VER → "10.0" — a semantically corrupt but syntactically valid
  // value that age-gates and rewrites against the wrong version.
  it("rejects '1%s' (no separator before %s) — mid-token template", async () => {
    const content = `
VER = "0.0"
crate.spec(package = "foo", version = "1%s" % VER)
`;
    const specs = await extractCrateSpecs(content);
    // Must not resolve the interpolation into "10.0".
    expect(specs.flatMap((s) => (s.versionRef !== undefined ? [s.versionRef.value] : []))).toHaveLength(0);
  });

  it("rejects '%sabc' (no separator after %s) — mid-token suffix template", async () => {
    const content = `
VER = "1.0"
crate.spec(package = "foo", version = "%sabc" % VER)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs.flatMap((s) => (s.versionRef !== undefined ? [s.versionRef.value] : []))).toHaveLength(0);
  });

  it("accepts '4.%s' (separator before %s is '.')", async () => {
    const content = `
VER = "13"
crate.spec(package = "foo", version = "4.%s" % VER)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].versionRef?.value).toBe("4.13");
    expect(specs[0].versionRef?.templatePrefix).toBe("4.");
  });

  it("accepts '%s.0' (separator after %s is '.')", async () => {
    const content = `
VER = "1"
crate.spec(package = "foo", version = "%s.0" % VER)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    // value is the full interpolated string VER + suffix → "1" + ".0" = "1.0"
    expect(specs[0].versionRef?.value).toBe("1.0");
  });

  it("accepts '%s' (empty prefix and suffix)", async () => {
    const content = `
VER = "1.2.3"
crate.spec(package = "foo", version = "%s" % VER)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].versionRef?.value).toBe("1.2.3");
  });
});

describe("extractMavenInstalls — constant interpolation in artifacts list", () => {
  it("resolves %s interpolation in artifact coordinates", async () => {
    const content = `
JACKSON_VERSION = "2.19.1"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.fasterxml.jackson.core:jackson-core:%s" % JACKSON_VERSION,
        "com.google.guava:guava:31.1-jre",
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    expect(installs[0].artifacts).toHaveLength(2);

    const interpolated = installs[0].artifacts[0];
    expect(interpolated.coord).toBe("com.fasterxml.jackson.core:jackson-core:2.19.1");
    expect(interpolated.versionRef?.value).toBe("2.19.1");
    expect(interpolated.versionRef?.constantName).toBe("JACKSON_VERSION");
    expect(interpolated.versionRef?.templatePrefix).toBe("");

    const literal = installs[0].artifacts[1];
    expect(literal.coord).toBe("com.google.guava:guava:31.1-jre");
    expect(literal.versionRef).toBeUndefined();
  });

  it("resolves literal-prefix template: '...:4.%s' % CONST", async () => {
    const content = `
PROTOBUF_VERSION = "32.1"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.google.protobuf:protobuf-java:4.%s" % PROTOBUF_VERSION,
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    const artifact = installs[0].artifacts[0];
    expect(artifact.coord).toBe("com.google.protobuf:protobuf-java:4.32.1");
    expect(artifact.versionRef?.value).toBe("4.32.1");
    expect(artifact.versionRef?.templatePrefix).toBe("4.");
    expect(artifact.versionRef?.templateSuffix).toBe("");
    expect(artifact.versionRef?.constantName).toBe("PROTOBUF_VERSION");
  });

  it("resolves tuple-style interpolation: '...' % (CONST,)", async () => {
    const content = `
VERSION = "1.2.3"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.example:lib:%s" % (VERSION,),
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    const artifact = installs[0].artifacts[0];
    expect(artifact.coord).toBe("com.example:lib:1.2.3");
    expect(artifact.versionRef?.value).toBe("1.2.3");
  });

  it("rejects a two-element tuple with one identifier and one non-identifier: '...' % (CONST, \"x\")", async () => {
    // Regression: filtering only identifier children (identChildren.length !== 1) accepted this
    // as a single-element tuple since it has exactly one identifier, ignoring the extra "x"
    // element. This is invalid Python ("not all arguments converted during string formatting")
    // and must not be resolved — the whole artifact entry is dropped, not misinterpolated.
    const content = `
VERSION = "1.2.3"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.example:lib:%s" % (VERSION, "x"),
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs[0].artifacts).toHaveLength(0);
  });

  it("preserves single-quote style from the constant literal in versionRef.quote", async () => {
    // Regression: resolveArtifactCoord previously omitted quote from the returned versionRef,
    // causing buildConstantRewrite to default to double-quotes, producing a mismatched
    // `expected` string that trips the stale-offset guard and silently drops every edit in
    // the file when the constant is single-quoted.
    const content = `
JACKSON_VERSION = '2.19.1'
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.fasterxml.jackson.core:jackson-core:%s" % JACKSON_VERSION,
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    const artifact = installs[0].artifacts[0];
    expect(artifact.coord).toBe("com.fasterxml.jackson.core:jackson-core:2.19.1");
    expect(artifact.versionRef?.value).toBe("2.19.1");
    expect(artifact.versionRef?.constantName).toBe("JACKSON_VERSION");
    // quote must be preserved from the constant so buildConstantRewrite writes
    // `'<newVersion>'` not `"<newVersion>"` — otherwise the stale-offset expected check fails.
    expect(artifact.versionRef?.quote).toBe("'");
  });
});

describe("extractMavenArtifacts", () => {
  it("extracts standalone maven.artifact() with bare-constant version", async () => {
    const content = `
ERROR_PRONE_VERSION = "2.49.0"
maven.artifact(
    group = "com.google.errorprone",
    artifact = "error_prone_core",
    version = ERROR_PRONE_VERSION,
    neverlink = True,
)
`;
    const refs = await extractMavenArtifacts(content);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      group: "com.google.errorprone",
      artifact: "error_prone_core",
      version: "2.49.0",
    });
    expect(refs[0].versionRef?.constantName).toBe("ERROR_PRONE_VERSION");
    expect(refs[0].versionRef?.templatePrefix).toBe("");
  });

  it("extracts maven.artifact() with direct literal version", async () => {
    const content = `
maven.artifact(
    group = "junit",
    artifact = "junit",
    version = "4.13.2",
)
`;
    const refs = await extractMavenArtifacts(content);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ group: "junit", artifact: "junit", version: "4.13.2" });
    expect(refs[0].versionRef?.constantName).toBeUndefined();
  });

  it("skips maven.artifact() without a version kwarg", async () => {
    const content = `
maven.artifact(
    group = "com.example",
    artifact = "lib",
)
`;
    const refs = await extractMavenArtifacts(content);
    expect(refs).toHaveLength(0);
  });

  it("extracts multiple maven.artifact() calls", async () => {
    const content = `
VER = "1.0.0"
maven.artifact(group = "a", artifact = "b", version = VER)
maven.artifact(group = "c", artifact = "d", version = "2.0.0")
`;
    const refs = await extractMavenArtifacts(content);
    expect(refs).toHaveLength(2);
    expect(refs[0].version).toBe("1.0.0");
    expect(refs[0].versionRef?.constantName).toBe("VER");
    expect(refs[1].version).toBe("2.0.0");
    expect(refs[1].versionRef?.constantName).toBeUndefined();
  });
});

// ─── rpartition("[0] head expression ─────────────────────────────────────────

describe("extractCrateSpecs — CONST.rpartition(SEP)[0] version resolution", () => {
  it("resolves VERSION.rpartition('.')[0] to the major.minor head", async () => {
    const content = `
VERSION = "1.2.3"
crate.spec(
    package = "my-crate",
    version = VERSION.rpartition(".")[0],
)
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].version).toBe("1.2");
    expect(specs[0].versionRef?.constantName).toBe("VERSION");
    expect(specs[0].versionRef?.readOnly).toBe(true);
    expect(specs[0].versionRef?.templatePrefix).toBe("");
    expect(specs[0].versionRef?.templateSuffix).toBe("");
  });

  it("preserves the quote style from the constant literal", async () => {
    const content = `
VERSION = '2.4.6'
crate.spec(package = "foo", version = VERSION.rpartition(".")[0])
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    expect(specs[0].version).toBe("2.4");
    expect(specs[0].versionRef?.quote).toBe("'");
    expect(specs[0].versionRef?.readOnly).toBe(true);
  });

  it("versionRef.nodeStart/End bracket the constant's value literal (not the rpartition call site)", async () => {
    const content = `VERSION = "1.2.3"
crate.spec(package = "my-crate", version = VERSION.rpartition(".")[0])
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    const { nodeStart, nodeEnd } = specs[0].versionRef!;
    // nodeStart/End are offsets inside the constant's string literal (after the opening quote)
    expect(content.slice(nodeStart, nodeEnd)).toBe("1.2.3");
  });

  it("rejects index [1] — only [0] (head) is supported", async () => {
    const content = `
VERSION = "1.2.3"
crate.spec(package = "my-crate", version = VERSION.rpartition(".")[1])
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(0);
  });

  it("rejects rpartition when SEP is absent in the constant value — empty head would be misleading", async () => {
    const content = `
VERSION = "123"
crate.spec(package = "my-crate", version = VERSION.rpartition(".")[0])
`;
    const specs = await extractCrateSpecs(content);
    // SEP "." is not in "123" → lastIndexOf returns -1 → parseRpartitionHead returns null
    expect(specs).toHaveLength(0);
  });

  it("rejects forward reference — rpartition on a constant not yet defined", async () => {
    const content = `
crate.spec(package = "my-crate", version = VERSION.rpartition(".")[0])
VERSION = "1.2.3"
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(0);
  });

  it("rejects unknown constant in rpartition expression", async () => {
    const content = `
crate.spec(package = "my-crate", version = UNKNOWN.rpartition(".")[0])
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(0);
  });

  it("rejects other string methods — only rpartition is supported", async () => {
    const content = `
VERSION = "1.2.3"
crate.spec(package = "my-crate", version = VERSION.split(".")[0])
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(0);
  });

  it("sibling with bare const ref coexists — sibling is writable, rpartition dep resolves read-only", async () => {
    const content = `
VERSION = "1.2.3"
crate.spec(package = "my-crate", version = VERSION)
crate.spec(package = "my-crate-minor", version = VERSION.rpartition(".")[0])
`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(2);
    const full = specs.find((s) => s.package === "my-crate")!;
    const truncated = specs.find((s) => s.package === "my-crate-minor")!;
    expect(full.version).toBe("1.2.3");
    expect(full.versionRef?.readOnly).toBeUndefined();
    expect(truncated.version).toBe("1.2");
    expect(truncated.versionRef?.readOnly).toBe(true);
    // Both point at the same constant literal in the source
    expect(full.versionRef?.constantName).toBe("VERSION");
    expect(truncated.versionRef?.constantName).toBe("VERSION");
  });
});

describe("extractMavenInstalls — rpartition colon guard uses effectiveValue not entry.value", () => {
  it("emits a readOnly versionRef when constant value contains ':' but rpartition head does not", async () => {
    // Regression: the colon guard previously checked entry.value ("1.2:rc" contains ":")
    // and incorrectly dropped the versionRef, causing Java discover to fall into the
    // artifactRaw string-replace branch with a coord that doesn't exist in the file.
    // The fix: check effectiveValue (the head "1.2") — which has no colon — so the
    // versionRef is emitted correctly with readOnly:true.
    const content = `
VERSION = "1.2:rc"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.example:lib:%s" % VERSION.rpartition(":")[0],
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    const artifact = installs[0].artifacts[0];
    // head = "1.2" (no colon) → effectiveValue = "1.2" → should produce a readOnly versionRef
    expect(artifact.coord).toBe("com.example:lib:1.2");
    expect(artifact.versionRef).toBeDefined();
    expect(artifact.versionRef?.value).toBe("1.2");
    expect(artifact.versionRef?.readOnly).toBe(true);
  });

  it("still drops versionRef when the rpartition head itself contains ':'", async () => {
    // When effectiveValue (the head) contains ":", the coord has ambiguous segments —
    // the guard should fire and return no versionRef.
    const content = `
VERSION = "group:artifact.1.2"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "prefix:%s" % VERSION.rpartition(".")[0],
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    const artifact = installs[0].artifacts[0];
    // head = "group:artifact.1" (contains ":") → guard fires → no versionRef
    expect(artifact.coord).toBe("prefix:group:artifact.1");
    expect(artifact.versionRef).toBeUndefined();
  });
});

describe("extractMavenInstalls — CONST.rpartition('.')[0] as % RHS in artifact coord", () => {
  it("resolves '...:v.%s' % VERSION.rpartition('.')[0] to the truncated version coord", async () => {
    const content = `
VERSION = "3.6.1"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.example:full-lib:%s" % VERSION,
        "com.example:minor-only-lib:%s" % VERSION.rpartition(".")[0],
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    expect(installs).toHaveLength(1);
    expect(installs[0].artifacts).toHaveLength(2);

    const full = installs[0].artifacts[0];
    expect(full.coord).toBe("com.example:full-lib:3.6.1");
    expect(full.versionRef?.readOnly).toBeUndefined();

    const truncated = installs[0].artifacts[1];
    expect(truncated.coord).toBe("com.example:minor-only-lib:3.6");
    expect(truncated.versionRef?.value).toBe("3.6");
    expect(truncated.versionRef?.constantName).toBe("VERSION");
    expect(truncated.versionRef?.readOnly).toBe(true);
    expect(truncated.versionRef?.templatePrefix).toBe("");
    expect(truncated.versionRef?.templateSuffix).toBe("");
  });

  it("resolves prefix template '...:4.%s' % VERSION.rpartition('.')[0]", async () => {
    const content = `
VERSION = "4.32.1"
maven.install(
    lock_file = "//:maven_install.json",
    artifacts = [
        "com.google.protobuf:protobuf-java:4.%s" % VERSION.rpartition(".")[0],
    ],
)
`;
    const installs = await extractMavenInstalls(content);
    const artifact = installs[0].artifacts[0];
    // coord uses the truncated head "4.32" as the substitution for %s, then adds "4." prefix
    expect(artifact.coord).toBe("com.google.protobuf:protobuf-java:4.4.32");
    expect(artifact.versionRef?.value).toBe("4.4.32");
    expect(artifact.versionRef?.templatePrefix).toBe("4.");
    expect(artifact.versionRef?.readOnly).toBe(true);
  });
});

// ─── Multibyte (astral-plane) offset invariant ────────────────────────────────
// web-tree-sitter returns startIndex/endIndex as UTF-16 code-unit offsets, which
// is what JavaScript's String.prototype.slice uses. An astral-plane character
// (emoji, CJK extension B, etc.) occupies 2 UTF-16 code units but 4 UTF-8 bytes;
// if the library ever changed to returning byte offsets, content.slice(nodeStart,
// nodeEnd) would mis-align and this test would fail, catching the regression before
// any real file is corrupted.
describe("bazel parser — multibyte offset invariant", () => {
  it("extractCrateSpecs: nodeStart/nodeEnd are UTF-16 code-unit offsets even with astral chars before version", async () => {
    // 🎉 (U+1F389 PARTY POPPER) is an astral-plane char: 2 UTF-16 code units, 4 UTF-8 bytes.
    // Placing it before VERSION ensures byte-offset vs UTF-16 offsets diverge by 2.
    const content = `# 🎉\nVERSION = "1.2.3"\ncrate.spec(package = "foo", version = VERSION)\n`;
    const specs = await extractCrateSpecs(content);
    expect(specs).toHaveLength(1);
    const vr = specs[0].versionRef;
    expect(vr).toBeDefined();
    if (!vr) return;
    // If nodeStart/nodeEnd are correct UTF-16 code-unit offsets, this slice must equal
    // exactly the version literal's content (the characters INSIDE the quotes).
    expect(content.slice(vr.nodeStart, vr.nodeEnd)).toBe("1.2.3");
  });

  it("extractBazelDeps: nodeStart/nodeEnd are UTF-16 code-unit offsets even with astral chars before version", async () => {
    const content = `# 🎉\nVER = "1.2.3"\nbazel_dep(name = "rules_go", version = VER)\n`;
    const deps = await extractBazelDeps(content);
    expect(deps).toHaveLength(1);
    const vr = deps[0].versionRef;
    expect(vr).toBeDefined();
    if (!vr) return;
    expect(content.slice(vr.nodeStart, vr.nodeEnd)).toBe("1.2.3");
  });
});
