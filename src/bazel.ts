import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — web-tree-sitter 0.24.x uses `export =` which needs esModuleInterop
import Parser from "web-tree-sitter";
import type { CrateSpec, MavenInstall, MavenArtifact, MavenArtifactRef, BazelOverride, BazelDep, VersionRef } from "./ecosystems/types.js";

const cwd = process.cwd();

type Node = Parser.SyntaxNode;
type Tree = Parser.Tree;

let parserPromise: Promise<Parser> | null = null;

async function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const thisDir = path.dirname(fileURLToPath(import.meta.url));

      // web-tree-sitter 0.24.x uses __dirname (CJS) but ncc bundles as ESM where
      // __dirname doesn't exist. Provide it globally for the emscripten init code.
      if (typeof globalThis.__dirname === "undefined") {
        (globalThis as Record<string, unknown>).__dirname = thisDir;
      }

      await Parser.init();
      const parser = new Parser();

      // In the ncc bundle, the WASM is copied to dist/ alongside index.js.
      // In dev/test, resolve from node_modules.
      let starlarkWasm = path.resolve(thisDir, "tree-sitter-starlark.wasm");
      try {
        await fs.access(starlarkWasm);
      } catch {
        starlarkWasm = path.resolve(
          thisDir, "..", "node_modules", "tree-sitter-starlark", "tree-sitter-starlark.wasm",
        );
      }
      const lang = await (Parser as unknown as { Language: { load: (path: string) => Promise<Parser.Language> } }).Language.load(starlarkWasm);

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

/** Extract a plain string literal value (strip quotes).
 * Returns null for prefixed strings (r"…", b"…", rb"…") and triple-quoted strings —
 * the offset arithmetic assumes the opening char is a quote, not a prefix byte.
 *
 * NOTE: escape sequences (e.g. `\"`, `\\`) are NOT decoded — the raw backslash is
 * preserved verbatim. Callers that rely on the returned value for path/URL matching
 * may get incorrect results for literals containing escaped characters. */
function extractString(node: Node): string | null {
  if (node.type !== "string") return null;
  const text = node.text;
  if (text.length < 2) return null;
  // Triple-quoted strings (""" or ''') have 3-char delimiters; the single-quote-stripping
  // logic below would slice into the literal content rather than past the delimiter,
  // yielding a value with stray interior quote characters rather than null. Reject
  // outright here so every caller gets this guard for free.
  if (text.startsWith('"""') || text.startsWith("'''")) return null;
  const open = text[0];
  const close = text[text.length - 1];
  if ((open !== '"' && open !== "'") || open !== close) return null;
  // Reject literals containing escape sequences — we don't decode them,
  // and an escaped version string won't match any registry lookup.
  // Fail-closed: return null so the caller skips this literal entirely.
  const inner = text.slice(1, -1);
  if (inner.includes("\\")) return null;
  return inner;
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

/** Valid characters that may appear at a `%s` template boundary in a version string. */
const PERCENT_SEPARATORS = new Set([".", ":", "-", "/", "+"]);

/** Internal shape for a top-level string constant (e.g. `FOO = "1.2.3"`). */
interface ConstEntry {
  value: string;
  // UTF-16 code-unit offsets (matching String.prototype.slice) — NOT byte offsets.
  valueNodeStart: number; // inside opening quote (+1 from node.startIndex)
  valueNodeEnd: number;   // inside closing quote (-1 from node.endIndex)
  /** End offset of the entire assignment statement — used to reject forward references. */
  assignmentEnd: number;
  /** The quote character used in the source: `"` or `'`. */
  quote: string;
}

/**
 * Walk the top-level statements of a parsed MODULE.bazel and collect all
 * simple string constant assignments: `IDENT = "literal"`.
 * List/dict/expression values are ignored.
 *
 * A name assigned more than once is dropped from the map: rewrites to an
 * ambiguous constant could corrupt the file if the two assignments have
 * different values or point at different regions.
 */
function extractStringConstants(rootNode: Node): Map<string, ConstEntry> {
  const constants = new Map<string, ConstEntry>();
  const reassigned = new Set<string>(); // names seen more than once — excluded
  for (let i = 0; i < rootNode.childCount; i++) {
    const stmt = rootNode.child(i)!;
    if (stmt.type !== "expression_statement") continue;
    const assign = stmt.child(0);
    if (!assign || assign.type !== "assignment") continue;
    const leftNode = assign.childForFieldName("left");
    const rightNode = assign.childForFieldName("right");
    if (!leftNode || leftNode.type !== "identifier") continue;
    if (!rightNode || rightNode.type !== "string") continue;
    // Triple-quoted and prefix-byte (r"…", b"…") strings are rejected inside extractString.
    const val = extractString(rightNode);
    // Reject an empty constant outright: e.g. `VER = ""` used as `bazel_dep(version=VER)`
    // would otherwise emit a writable DepRef with current:"" — not fail-closed.
    if (val === null || val === "") continue;
    const name = leftNode.text;
    if (reassigned.has(name)) continue; // already known-ambiguous, skip
    if (constants.has(name)) {
      // Second assignment — mark ambiguous and remove from usable map.
      constants.delete(name);
      reassigned.add(name);
      continue;
    }
    constants.set(name, {
      value: val,
      valueNodeStart: rightNode.startIndex + 1,
      valueNodeEnd: rightNode.endIndex - 1,
      assignmentEnd: stmt.endIndex,
      quote: rightNode.text[0] ?? '"',
    });
  }
  return constants;
}

/**
 * Resolve a Starlark expression node to a VersionRef.
 * Handles direct string literals, bare constant identifiers, and
 * `"template %s" % CONST` / `"template %s" % (CONST,)` interpolation.
 * Returns null for anything else (complex expressions, unknown identifiers, etc.).
 *
 * For direct literals: nodeStart/End point at the literal itself.
 * For constants/interpolation: nodeStart/End point at the constant's value literal
 * so the updater rewrites the constant, not the call site.
 * templatePrefix/templateSuffix are the literal fragments added around the constant
 * value by the template — the updater strips them from candidate.latest to recover
 * the new constant value.
 */

/**
 * Parsed result of a `"template %s" % CONST` Starlark binary-operator node.
 * `effectiveValue` is the resolved value substituted for `%s` — for a bare
 * identifier/tuple it equals `entry.value`; for an rpartition subscript it is
 * the truncated head.  `readOnly` is true when the RHS is a lossy transform
 * (rpartition) that cannot be inverted on write-back.
 */
interface PercentInterpolation {
  identName: string;
  entry: ConstEntry;
  prefix: string;
  suffix: string;
  effectiveValue: string;
  readOnly: boolean;
}

/**
 * If `node` is a `CONST.rpartition(SEP)[0]` subscript expression, parse and
 * validate it, returning the constant entry and the resulting head value.
 * Returns null for anything that doesn't match the supported shape.
 *
 * Accepted shape (verified via AST probe):
 *   subscript
 *     value: call
 *       function: attribute  (object: identifier, attribute: "rpartition")
 *       arguments: argument_list  (single string literal)
 *     subscript: integer "0"
 *
 * Guards: attribute name must be "rpartition"; index must be 0; SEP must appear
 * in the constant value (otherwise the head would be the full value, indistinguishable
 * from a non-rpartition reference and potentially misleading for age-gating); forward
 * references are rejected.
 */
function parseRpartitionHead(
  node: Node,
  constants: Map<string, ConstEntry>,
): { identName: string; entry: ConstEntry; head: string } | null {
  if (node.type !== "subscript") return null;

  // subscript field must be integer "0"
  const indexNode = node.childForFieldName("subscript");
  if (!indexNode || indexNode.type !== "integer" || indexNode.text !== "0") return null;

  // value field must be a call
  const callNode = node.childForFieldName("value");
  if (!callNode || callNode.type !== "call") return null;

  // function field of the call must be an attribute
  const attrNode = callNode.childForFieldName("function");
  if (!attrNode || attrNode.type !== "attribute") return null;

  // attribute field must be "rpartition"
  const methodNameNode = attrNode.childForFieldName("attribute");
  if (!methodNameNode || methodNameNode.text !== "rpartition") return null;

  // object field must be an identifier referencing a known constant
  const objNode = attrNode.childForFieldName("object");
  if (!objNode || objNode.type !== "identifier") return null;
  const identName = objNode.text;

  const entry = constants.get(identName);
  if (!entry) return null;
  // Reject forward references: the constant must be assigned before this use site.
  if (node.startIndex < entry.assignmentEnd) return null;

  // The argument list must contain exactly one string literal — the separator.
  const argsNode = callNode.childForFieldName("arguments");
  if (!argsNode || argsNode.type !== "argument_list") return null;
  if (argsNode.namedChildren.length !== 1) return null;
  const sepNode = argsNode.namedChildren[0];
  if (sepNode.type !== "string") return null;
  const sep = extractString(sepNode);
  if (sep === null || sep === "") return null;

  // Compute the head: everything before the last occurrence of SEP.
  const lastIdx = entry.value.lastIndexOf(sep);
  // If SEP is not found the head would equal the full value — that's
  // indistinguishable from a bare const reference and almost certainly a mistake.
  if (lastIdx < 0) return null;
  const head = entry.value.slice(0, lastIdx);
  // Guard against an empty head (SEP at position 0).
  if (!head) return null;

  return { identName, entry, head };
}

/**
 * If `node` is a `"template %s" % IDENT` (or tuple or rpartition subscript)
 * binary-operator, parse and validate it, returning the constant entry, template
 * prefix/suffix, effective substituted value, and readOnly flag.
 * Returns null for anything that doesn't match the supported form.
 *
 * Shared by resolveVersionExpr and resolveArtifactCoord to eliminate duplication
 * and ensure both apply the same guards (including the triple-quote guard).
 */
function parsePercentInterpolation(
  node: Node,
  constants: Map<string, ConstEntry>,
): PercentInterpolation | null {
  const opNode = node.childForFieldName("operator");
  const leftNode = node.childForFieldName("left");
  const rightNode = node.childForFieldName("right");
  if (!opNode || opNode.type !== "%" || !leftNode || !rightNode) return null;
  if (leftNode.type !== "string") return null;

  // RHS must be a single identifier, a single-element tuple, or an rpartition subscript.
  // Resolve all three shapes in an IIFE so each branch can return early without
  // initialising variables to null (which would trip the no-useless-assignment rule).
  const rhs = (() => {
    if (rightNode.type === "identifier") {
      const ident = rightNode.text;
      const e = constants.get(ident);
      if (!e) return null;
      if (node.startIndex < e.assignmentEnd) return null; // forward reference
      return { identName: ident, entry: e, effectiveValue: e.value, readOnly: false } as const;
    }
    if (rightNode.type === "tuple") {
      // Require exactly one tuple element total (not just exactly one identifier) — otherwise
      // "%s" % (CONST, "x") (one identifier + one non-identifier element, invalid Python that
      // would raise "not all arguments converted") is wrongly accepted as a single-element tuple.
      if (rightNode.namedChildren.length !== 1) return null;
      const identChildren = rightNode.namedChildren.filter((c) => c.type === "identifier");
      if (identChildren.length !== 1) return null; // reject non-identifier single element
      const ident = identChildren[0].text;
      const e = constants.get(ident);
      if (!e) return null;
      if (node.startIndex < e.assignmentEnd) return null; // forward reference
      return { identName: ident, entry: e, effectiveValue: e.value, readOnly: false } as const;
    }
    if (rightNode.type === "subscript") {
      const parsed = parseRpartitionHead(rightNode, constants);
      if (!parsed) return null;
      return { identName: parsed.identName, entry: parsed.entry, effectiveValue: parsed.head, readOnly: true } as const;
    }
    return null;
  })();
  if (!rhs) return null;
  const { identName, entry, effectiveValue, readOnly } = rhs;

  const template = extractString(leftNode);
  if (template === null) return null;

  // Reject templates containing "%%" (escaped percent in Starlark/Python).
  if (template.includes("%%")) return null;

  const pctParts = template.split("%s");
  if (pctParts.length !== 2) return null; // 0 or 2+ %s → skip

  const [prefix, suffix] = pctParts;

  // Fail-closed on any remaining bare/trailing `%` in prefix or suffix (e.g. "%s-100%",
  // "%(name)s", "%*s", "%s%d", "%s%r"). After stripping %% escapes and the single %s, any
  // remaining `%` is an unhandled Python format conversion that we cannot reason about —
  // emit null so the constant is never updated from a template Python would reject at runtime.
  if (prefix.includes("%") || suffix.includes("%")) return null;

  // Restrict interpolation to templates where the `%s` sits at a real version
  // boundary (the documented `"4.%s"` / `"prefix:%s"` forms). Mid-token templates
  // like `"1%s"` would produce semantically corrupt values (e.g. `"1" + "0.0"` →
  // `"10.0"`) so we reject them rather than emit a confidently-wrong rewrite.
  if (prefix !== "" && !PERCENT_SEPARATORS.has(prefix[prefix.length - 1])) return null;
  if (suffix !== "" && !PERCENT_SEPARATORS.has(suffix[0])) return null;

  return { identName, entry, prefix, suffix, effectiveValue, readOnly };
}

/**
 * Build a `VersionRef`, centralizing the field defaults/omissions every construction
 * site must apply consistently (this is where the single-quote `quote`-field
 * regression already recurred once across hand-duplicated literals).
 */
function makeVersionRef(opts: {
  value: string;
  nodeStart: number;
  nodeEnd: number;
  templatePrefix?: string;
  templateSuffix?: string;
  constantName?: string;
  quote: string;
  readOnly?: boolean;
}): VersionRef {
  return {
    value: opts.value,
    nodeStart: opts.nodeStart,
    nodeEnd: opts.nodeEnd,
    templatePrefix: opts.templatePrefix ?? "",
    templateSuffix: opts.templateSuffix ?? "",
    quote: opts.quote,
    ...(opts.constantName !== undefined ? { constantName: opts.constantName } : {}),
    ...(opts.readOnly ? { readOnly: true } : {}),
  };
}

function resolveVersionExpr(node: Node, constants: Map<string, ConstEntry>): VersionRef | null {
  if (node.type === "string") {
    // Triple-quoted strings: extractString only strips one quote, yielding stray interior
    // quotes. Guard here since the inline-literal path bypasses extractStringConstants.
    if (node.text.startsWith('"""') || node.text.startsWith("'''")) return null;
    const val = extractString(node);
    if (val === null) return null;
    return makeVersionRef({
      value: val,
      nodeStart: node.startIndex + 1,
      nodeEnd: node.endIndex - 1,
      quote: node.text[0] ?? '"',
    });
  }

  if (node.type === "identifier") {
    const entry = constants.get(node.text);
    if (!entry) return null;
    // Reject forward references: the constant must be assigned before this use site.
    if (node.startIndex < entry.assignmentEnd) return null;
    return makeVersionRef({
      value: entry.value,
      nodeStart: entry.valueNodeStart,
      nodeEnd: entry.valueNodeEnd,
      constantName: node.text,
      quote: entry.quote,
    });
  }

  if (node.type === "subscript") {
    // Handles `CONST.rpartition(SEP)[0]` — a lossy transform that cannot be
    // inverted on write-back, so the ref is read-only (discovered but never rewritten).
    const parsed = parseRpartitionHead(node, constants);
    if (!parsed) return null;
    const { identName, entry, head } = parsed;
    return makeVersionRef({
      value: head,
      nodeStart: entry.valueNodeStart,
      nodeEnd: entry.valueNodeEnd,
      constantName: identName,
      quote: entry.quote,
      readOnly: true,
    });
  }

  if (node.type === "binary_operator") {
    const interp = parsePercentInterpolation(node, constants);
    if (!interp) return null;
    const { identName, entry, prefix, suffix, effectiveValue, readOnly } = interp;
    return makeVersionRef({
      value: prefix + effectiveValue + suffix,
      nodeStart: entry.valueNodeStart,
      nodeEnd: entry.valueNodeEnd,
      templatePrefix: prefix,
      templateSuffix: suffix,
      constantName: identName,
      quote: entry.quote,
      readOnly,
    });
  }

  return null;
}

/**
 * Resolve a Starlark list element that is a Maven artifact coordinate string.
 * Like resolveVersionExpr but for coord templates ("group:artifact:version" or
 * "group:artifact:PREFIX%s" % CONST). Returns a MavenArtifact where versionRef
 * points at the constant's value literal and templatePrefix/Suffix encode the
 * fragment *within the version segment* of the coordinate (not the full coord prefix).
 */
function resolveArtifactCoord(node: Node, constants: Map<string, ConstEntry>): MavenArtifact | null {
  if (node.type === "string") {
    const coord = extractString(node);
    if (coord === null) return null;
    return { coord };
  }

  if (node.type === "binary_operator") {
    const interp = parsePercentInterpolation(node, constants);
    if (!interp) return null;
    const { identName, entry, prefix: leftPart, suffix: rightPart, effectiveValue, readOnly } = interp;

    const coord = leftPart + effectiveValue + rightPart;

    // The substituted value must not itself contain ":" — that would create extra segments in
    // the coord and make the version segment ambiguous. For bare-constant/tuple RHS,
    // effectiveValue === entry.value; for rpartition RHS, effectiveValue is the head (which
    // may not contain ":" even if the full constant does). Checking effectiveValue is correct
    // in all cases and avoids a false rejection when the rpartition head is colon-free.
    if (effectiveValue.includes(":")) {
      return { coord };  // no versionRef — discovered for age-gate but not rewritten
    }

    // Compute the prefix/suffix within the VERSION SEGMENT only.
    // leftPart is e.g. "group:artifact:4." — everything after the last ":" is the version prefix.
    const lastColonLeft = leftPart.lastIndexOf(":");
    const versionPrefix = lastColonLeft >= 0 ? leftPart.slice(lastColonLeft + 1) : leftPart;
    // rightPart is typically "" but may have ":classifier" etc. — stop at first ":"
    const firstColonRight = rightPart.indexOf(":");
    const versionSuffix = firstColonRight >= 0 ? rightPart.slice(0, firstColonRight) : rightPart;

    return {
      coord,
      // The full version segment = versionPrefix + effectiveValue + versionSuffix.
      // For bare-constant/tuple RHS, effectiveValue === entry.value and this equals
      // coord.split(":")[2] for the common "group:artifact:VERSION" form.
      // For rpartition RHS, effectiveValue is the truncated head — the versionRef is
      // readOnly and carries the effective (shorter) version for age-gating only.
      versionRef: makeVersionRef({
        value: versionPrefix + effectiveValue + versionSuffix,
        nodeStart: entry.valueNodeStart,
        nodeEnd: entry.valueNodeEnd,
        templatePrefix: versionPrefix,
        templateSuffix: versionSuffix,
        constantName: identName,
        quote: entry.quote,
        readOnly,
      }),
    };
  }

  return null;
}

/** Extract a list of Maven artifact coordinates, resolving constants and interpolations. */
function extractArtifactList(node: Node, constants: Map<string, ConstEntry>): MavenArtifact[] {
  if (node.type !== "list") return [];
  const results: MavenArtifact[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!;
    const artifact = resolveArtifactCoord(child, constants);
    if (artifact !== null) results.push(artifact);
  }
  return results;
}

/**
 * Resolve a Bazel label to a filesystem path.
 *   "//pkg:file"  → <workspaceRoot>/pkg/file
 *   "//:file"     → <workspaceRoot>/file
 *   ":file"       → <currentDir>/file
 *   "file"        → <currentDir>/file
 */
export function resolveBazelLabel(
  label: string,
  workspaceRoot: string,
  currentDir: string,
): string {
  if (label.startsWith("//")) {
    // "//pkg:file" → "pkg/file", "//:file" → "file"
    const stripped = label.slice(2);
    const colonIdx = stripped.indexOf(":");
    let relativePath: string;
    if (colonIdx === -1) {
      relativePath = stripped;
    } else if (colonIdx === 0) {
      relativePath = stripped.slice(1);
    } else {
      relativePath = stripped.slice(0, colonIdx) + "/" + stripped.slice(colonIdx + 1);
    }
    return path.resolve(workspaceRoot, relativePath);
  }
  if (label.startsWith(":")) {
    return path.resolve(currentDir, label.slice(1));
  }
  return path.resolve(currentDir, label);
}

/**
 * Resolve all MODULE.bazel files by following include() statements recursively.
 */
export async function resolveModuleFiles(rootPath: string): Promise<string[]> {
  const visited = new Set<string>();
  const result: string[] = [];
  const workspaceRoot = path.resolve(path.dirname(rootPath));

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
          const includePath = extractString(child);
          if (!includePath) continue;

          const resolved = resolveBazelLabel(
            includePath,
            workspaceRoot,
            path.dirname(abs),
          );
          await visit(resolved);
        }
      }
    }
  }

  await visit(rootPath);
  return result;
}

/** Parse Starlark content and collect its top-level string constants in one pass. */
async function parseModule(content: string): Promise<{ tree: Tree; constants: Map<string, ConstEntry> }> {
  const tree = await parseStarlark(content);
  const constants = extractStringConstants(tree.rootNode);
  return { tree, constants };
}

/**
 * Extract crate.spec() calls from Starlark content.
 * Resolves constant variables and % interpolation in version= arguments.
 */
export async function extractCrateSpecs(content: string): Promise<CrateSpec[]> {
  const { tree, constants } = await parseModule(content);
  const calls = findCallsByName(tree.rootNode, "crate.spec");
  const specs: CrateSpec[] = [];

  for (const call of calls) {
    const pkgNode = getKeywordArg(call, "package");
    const verNode = getKeywordArg(call, "version");
    const gitNode = getKeywordArg(call, "git");

    const pkg = pkgNode ? extractString(pkgNode) : null;
    const versionRef = verNode ? resolveVersionExpr(verNode, constants) : null;

    if (pkg && versionRef) {
      const spec: CrateSpec = {
        package: pkg,
        version: versionRef.value,
        isGit: gitNode !== null,
        versionNodeStart: versionRef.nodeStart,
        versionNodeEnd: versionRef.nodeEnd,
        versionRef,
      };
      specs.push(spec);
    }
  }

  return specs;
}

/**
 * Extract all override directives from MODULE.bazel content.
 * Handles: git_override, archive_override, local_path_override,
 * single_version_override, multiple_version_override
 */
export async function extractOverrides(
  content: string,
): Promise<Map<string, BazelOverride>> {
  const { tree, constants } = await parseModule(content);
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
          const versionRef = verNode ? resolveVersionExpr(verNode, constants) : null;
          override.version = versionRef?.value;
          override.registry = regNode ? extractString(regNode) ?? undefined : undefined;
          if (versionRef) {
            override.versionNodeStart = versionRef.nodeStart;
            override.versionNodeEnd = versionRef.nodeEnd;
            override.versionRef = versionRef;
          }
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
  workspaceRoot?: string,
): Promise<MavenInstall[]> {
  const { tree, constants } = await parseModule(content);
  const calls = findCallsByName(tree.rootNode, "maven.install");
  const installs: MavenInstall[] = [];
  const wsRoot = workspaceRoot ?? cwd;

  for (const call of calls) {
    const nameNode = getKeywordArg(call, "name");
    const lockNode = getKeywordArg(call, "lock_file");
    const repoNode = getKeywordArg(call, "repositories");
    const artNode = getKeywordArg(call, "artifacts");

    const name = nameNode ? extractString(nameNode) : null;
    const lockFile = lockNode ? extractString(lockNode) : null;

    if (!lockFile) continue;

    const resolvedLockFile = path.relative(
      cwd,
      resolveBazelLabel(lockFile, wsRoot, wsRoot),
    );

    installs.push({
      name,
      lockFile: resolvedLockFile,
      repositories: repoNode ? extractStringList(repoNode) : [],
      artifacts: artNode ? extractArtifactList(artNode, constants) : [],
    });
  }

  return installs;
}

/**
 * Extract standalone maven.artifact() calls from Starlark content.
 * These are individual artifact specifications (not nested inside maven.install()
 * artifacts= lists). Resolves constant variables in the version= argument.
 */
export async function extractMavenArtifacts(
  content: string,
): Promise<MavenArtifactRef[]> {
  const { tree, constants } = await parseModule(content);
  const calls = findCallsByName(tree.rootNode, "maven.artifact");
  const refs: MavenArtifactRef[] = [];

  for (const call of calls) {
    const groupNode = getKeywordArg(call, "group");
    const artifactNode = getKeywordArg(call, "artifact");
    const verNode = getKeywordArg(call, "version");

    const group = groupNode ? extractString(groupNode) : null;
    const artifact = artifactNode ? extractString(artifactNode) : null;

    if (!group || !artifact || !verNode) continue;

    const versionRef = resolveVersionExpr(verNode, constants);
    if (!versionRef) continue;

    refs.push({
      group,
      artifact,
      version: versionRef.value,
      versionRef,
    });
  }

  return refs;
}

/**
 * Extract bazel_dep() calls from MODULE.bazel content.
 * Returns each dependency's name, version, and the tree-sitter UTF-16 code-unit
 * offsets for the version string literal (quotes excluded) — used by the updater to
 * rewrite versions in-place without re-parsing.
 */
export async function extractBazelDeps(content: string): Promise<BazelDep[]> {
  const { tree, constants } = await parseModule(content);
  const calls = findCallsByName(tree.rootNode, "bazel_dep");
  const deps: BazelDep[] = [];

  for (const call of calls) {
    const nameNode = getKeywordArg(call, "name");
    const verNode = getKeywordArg(call, "version");

    const name = nameNode ? extractString(nameNode) : null;
    const versionRef = verNode ? resolveVersionExpr(verNode, constants) : null;

    if (name && versionRef) {
      deps.push({
        name,
        version: versionRef.value,
        versionNodeStart: versionRef.nodeStart,
        versionNodeEnd: versionRef.nodeEnd,
        versionRef,
      });
    }
  }

  return deps;
}

/**
 * Extract multitool.hub() calls from Starlark content and return lockfile paths.
 */
export async function extractMultitoolHubs(
  content: string,
  workspaceRoot?: string,
): Promise<string[]> {
  const tree = await parseStarlark(content);
  const calls = findCallsByName(tree.rootNode, "multitool.hub");
  const lockfiles: string[] = [];
  const wsRoot = workspaceRoot ?? cwd;

  for (const call of calls) {
    const lockNode = getKeywordArg(call, "lockfile");
    const lockfile = lockNode ? extractString(lockNode) : null;
    if (!lockfile) continue;

    const resolved = path.relative(
      cwd,
      resolveBazelLabel(lockfile, wsRoot, wsRoot),
    );
    lockfiles.push(resolved);
  }

  return lockfiles;
}
