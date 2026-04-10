import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CrateSpec, MavenInstall, BazelOverride } from "./ecosystems/types.js";

const cwd = process.cwd();

type Parser = import("web-tree-sitter").Parser;
type Node = import("web-tree-sitter").Node;
type Language = import("web-tree-sitter").Language;
type Tree = import("web-tree-sitter").Tree;

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const { Parser: ParserClass, Language: LanguageClass } = await import("web-tree-sitter");
      await ParserClass.init();
      const parser = new ParserClass() as Parser;

      // Locate the WASM file from tree-sitter-starlark package
      const thisDir = path.dirname(fileURLToPath(import.meta.url));
      const wasmPath = path.resolve(
        thisDir,
        "..",
        "node_modules",
        "tree-sitter-starlark",
        "tree-sitter-starlark.wasm",
      );

      let lang: Language;
      try {
        lang = await LanguageClass.load(wasmPath);
      } catch {
        const fallback = path.resolve(
          process.cwd(),
          "node_modules",
          "tree-sitter-starlark",
          "tree-sitter-starlark.wasm",
        );
        lang = await LanguageClass.load(fallback);
      }

      parser.setLanguage(lang);
      return parser;
    })();
  }
  return parserPromise;
}

async function parseStarlark(content: string): Promise<Tree> {
  const parser = await getParser();
  return parser.parse(content)!;
}

/** Walk tree to find all call expressions matching a function name */
function findCallsByName(node: Node, name: string): Node[] {
  const results: Node[] = [];
  const walk = (n: Node) => {
    if (n.type === "call") {
      const fn = n.childForFieldName("function");
      if (fn && fn.text === name) {
        results.push(n);
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  };
  walk(node);
  return results;
}

/** Extract the value of a keyword argument from a call's argument_list */
function getKeywordArg(callNode: Node, key: string): Node | null {
  const argList = callNode.childForFieldName("arguments");
  if (!argList) return null;

  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i)!;
    if (child.type === "keyword_argument") {
      const nameNode = child.childForFieldName("name");
      const valueNode = child.childForFieldName("value");
      if (nameNode && nameNode.text === key && valueNode) {
        return valueNode;
      }
    }
  }
  return null;
}

/** Extract a string literal value (strip quotes) */
function extractString(node: Node): string | null {
  if (node.type === "string") {
    return node.text.replace(/^["']|["']$/g, "");
  }
  return null;
}

/** Extract a list of string literals */
function extractStringList(node: Node): string[] {
  if (node.type !== "list") return [];
  const results: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    if (child.type === "string") {
      const val = extractString(child);
      if (val !== null) results.push(val);
    }
  }
  return results;
}

/**
 * Resolve all MODULE.bazel files by following include() statements recursively.
 */
export async function resolveModuleFiles(rootPath: string): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];

  async function visit(filePath: string): Promise<void> {
    const abs = path.resolve(filePath);
    if (visited.has(abs)) return;
    visited.add(abs);

    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch {
      return;
    }

    // Store as relative path to match git diff output
    result.push(path.relative(cwd, abs));

    const tree = await parseStarlark(content);
    const includeCalls = findCallsByName(tree.rootNode, "include");

    for (const call of includeCalls) {
      const argList = call.childForFieldName("arguments");
      if (!argList) continue;

      for (let i = 0; i < argList.childCount; i++) {
        const child = argList.child(i)!;
        if (child.type === "string") {
          let includePath = extractString(child);
          if (!includePath) continue;

          // Strip Bazel label prefix "//"
          includePath = includePath.replace(/^\/\//, "");

          const resolved = path.resolve(path.dirname(abs), includePath);
          await visit(resolved);
        }
      }
    }
  }

  await visit(rootPath);
  return result;
}

/**
 * Extract crate.spec() calls from Starlark content.
 */
export async function extractCrateSpecs(content: string): Promise<CrateSpec[]> {
  const tree = await parseStarlark(content);
  const calls = findCallsByName(tree.rootNode, "crate.spec");
  const specs: CrateSpec[] = [];

  for (const call of calls) {
    const pkgNode = getKeywordArg(call, "package");
    const verNode = getKeywordArg(call, "version");
    const gitNode = getKeywordArg(call, "git");

    const pkg = pkgNode ? extractString(pkgNode) : null;
    const ver = verNode ? extractString(verNode) : null;

    if (pkg && ver) {
      specs.push({
        package: pkg,
        version: ver,
        isGit: gitNode !== null,
      });
    }
  }

  return specs;
}

/**
 * Extract maven.install() calls from Starlark content.
 */
/**
 * Extract all override directives from MODULE.bazel content.
 * Handles: git_override, archive_override, local_path_override,
 * single_version_override, multiple_version_override
 */
export async function extractOverrides(
  content: string,
): Promise<Map<string, BazelOverride>> {
  const tree = await parseStarlark(content);
  const overrides = new Map<string, BazelOverride>();

  const OVERRIDE_TYPE_MAP: Record<string, BazelOverride["type"]> = {
    git_override: "git",
    archive_override: "archive",
    local_path_override: "local_path",
    single_version_override: "single_version",
    multiple_version_override: "multiple_version",
  };

  for (const fnName of Object.keys(OVERRIDE_TYPE_MAP)) {
    const calls = findCallsByName(tree.rootNode, fnName);
    for (const call of calls) {
      const nameNode = getKeywordArg(call, "module_name");
      const moduleName = nameNode ? extractString(nameNode) : null;
      if (!moduleName) continue;

      const type = OVERRIDE_TYPE_MAP[fnName];

      const override: BazelOverride = { type, moduleName };

      switch (fnName) {
        case "git_override": {
          const remoteNode = getKeywordArg(call, "remote");
          const commitNode = getKeywordArg(call, "commit");
          const tagNode = getKeywordArg(call, "tag");
          const branchNode = getKeywordArg(call, "branch");
          override.remote = remoteNode ? extractString(remoteNode) ?? undefined : undefined;
          override.commit = commitNode ? extractString(commitNode) ?? undefined : undefined;
          override.tag = tagNode ? extractString(tagNode) ?? undefined : undefined;
          override.branch = branchNode ? extractString(branchNode) ?? undefined : undefined;
          break;
        }
        case "archive_override": {
          const urlsNode = getKeywordArg(call, "urls");
          override.urls = urlsNode ? extractStringList(urlsNode) : [];
          // Also handle single url= kwarg
          if (override.urls.length === 0) {
            const urlNode = getKeywordArg(call, "url");
            const url = urlNode ? extractString(urlNode) : null;
            if (url) override.urls = [url];
          }
          break;
        }
        case "single_version_override": {
          const verNode = getKeywordArg(call, "version");
          const regNode = getKeywordArg(call, "registry");
          override.version = verNode ? extractString(verNode) ?? undefined : undefined;
          override.registry = regNode ? extractString(regNode) ?? undefined : undefined;
          break;
        }
        case "multiple_version_override": {
          const versNode = getKeywordArg(call, "versions");
          const regNode = getKeywordArg(call, "registry");
          override.versions = versNode ? extractStringList(versNode) : [];
          override.registry = regNode ? extractString(regNode) ?? undefined : undefined;
          break;
        }
        // local_path_override — no extra fields needed, just the module name
      }

      overrides.set(moduleName, override);
    }
  }

  return overrides;
}

export async function extractMavenInstalls(
  content: string,
): Promise<MavenInstall[]> {
  const tree = await parseStarlark(content);
  const calls = findCallsByName(tree.rootNode, "maven.install");
  const installs: MavenInstall[] = [];

  for (const call of calls) {
    const nameNode = getKeywordArg(call, "name");
    const lockNode = getKeywordArg(call, "lock_file");
    const repoNode = getKeywordArg(call, "repositories");
    const artNode = getKeywordArg(call, "artifacts");

    const name = nameNode ? extractString(nameNode) : null;
    const lockFile = lockNode ? extractString(lockNode) : null;

    if (!lockFile) continue;

    const cleanLockFile = lockFile.replace(/^\/\//, "").replace(/^:/, "");

    installs.push({
      name,
      lockFile: cleanLockFile,
      repositories: repoNode ? extractStringList(repoNode) : [],
      artifacts: artNode ? extractStringList(artNode) : [],
    });
  }

  return installs;
}
