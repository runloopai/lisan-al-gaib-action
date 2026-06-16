import * as core from "@actions/core";
import * as fs from "node:fs/promises";
import yaml from "js-yaml";
import { resolveFiles, gitDiff, gitDiffNameOnly, gitShowFile } from "../diff.js";
import type { ChangedDep, ParsedImageRef } from "./types.js";
import { parseImageRef, makeName, makeVersion, imageIdentity, getImagePublishDate } from "./image.js";

/** Recursively walk a parsed YAML value and collect container image strings. */
function extractImages(
  obj: unknown,
  out: Map<string, ParsedImageRef>,
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) extractImages(item, out);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (
      key === "containers" ||
      key === "initContainers" ||
      key === "ephemeralContainers"
    ) {
      const arr = rec[key];
      if (Array.isArray(arr)) {
        for (const container of arr) {
          if (
            container &&
            typeof container === "object" &&
            !Array.isArray(container)
          ) {
            const imageStr = (container as Record<string, unknown>).image;
            if (typeof imageStr === "string") {
              const ref = parseImageRef(imageStr);
              if (ref) out.set(imageStr, ref);
            }
          }
        }
      }
    } else {
      extractImages(rec[key], out);
    }
  }
}

/**
 * Parse a rendered Kubernetes manifest (possibly multi-document YAML with '---'
 * separators) and return a map of raw image strings to parsed refs.
 *
 * Works across all workload kinds by recursively finding containers/
 * initContainers/ephemeralContainers arrays anywhere in the document tree —
 * handles Deployment, StatefulSet, DaemonSet, Job, CronJob (nested), Pod,
 * and CRDs like Argo Rollouts without hard-coding kinds.
 */
export function parseManifestImages(
  content: string,
): Map<string, ParsedImageRef> {
  const refs = new Map<string, ParsedImageRef>();
  try {
    yaml.loadAll(content, (doc) => {
      try {
        extractImages(doc, refs);
      } catch {
        // skip individual malformed documents
      }
    });
  } catch {
    // invalid YAML — return whatever was collected before the error
  }
  return refs;
}

export interface K8sImageRefWithPos {
  raw: string;
  ref: ParsedImageRef | null;
  /** Line index (0-based) in the source file */
  lineIndex: number;
  /** Character offset within that line where the image value starts */
  valueOffset: number;
  /** Length of the image value string on that line */
  valueLength: number;
}

const CONTAINER_LIST_KEY_RE =
  /^(\s*)(?:-\s*)?(?:containers|initContainers|ephemeralContainers):\s*(?:#.*)?$/;

interface ContainerScopeEntry {
  /** Indent of the `containers:` / `initContainers:` key that opened this scope. */
  indent: number;
  /**
   * Indent of the `-` dash for container list items within this scope.
   * -1 until the first list item is seen. In dash-aligned style this equals
   * `indent`; in dash-indented style it is `indent + 2` or deeper.
   */
  itemDashIndent: number;
  /**
   * Indent of the direct mapping keys for the current container item.
   * Derived from the actual source line's list-item prefix width when the first
   * container item is seen, so `itemFieldIndent` is always correct regardless of
   * the YAML formatter used to produce the manifest (e.g. `"-   name:"` with 4-char
   * prefix uses `dashIndent + 4`, not the hard-coded `dashIndent + 2`).
   * -1 until the first list item (container item) is seen.
   */
  itemFieldIndent: number;
}

interface ContainerScopeLineInfo {
  /** Innermost open container-list key indent, -1 if not in scope. */
  containerIndent: number;
  /**
   * Indent of the direct mapping keys of the current container item, or -1 if
   * no container item has been seen yet in this scope. Set eagerly when the first
   * item dash is observed (derived from the actual prefix width on that source line)
   * so the depth guard is never left with the `containerIndent+4` fallback (which
   * could equal a sub-list entry's indent and mis-accept it).
   */
  itemFieldIndent: number;
}

/**
 * Width of the YAML list-item prefix on a line that starts a container item.
 * YAML allows "- " followed by any number of spaces (e.g. "-   name:" uses 4 chars).
 * We derive the width from the actual source line so `itemFieldIndent` is always correct
 * regardless of the formatter used to produce the manifest.
 */
function listItemPrefixWidth(line: string, dashIndent: number): number {
  // Match "-" followed by one or more spaces starting at dashIndent.
  const match = /^-(\s+)/.exec(line.slice(dashIndent));
  // Must have at least one space (required by YAML spec), but be precise about how many.
  return match ? 1 + match[1].length : 2; // 2 is the absolute minimum fallback
}

/**
 * Determine, per source line, whether that line lies inside the YAML scope of a
 * `containers` / `initContainers` / `ephemeralContainers` list, and if so at
 * what container-list indent level and what the direct-field indent is.
 *
 * A container-list key at indent K opens a block whose members are either:
 *   - dash-aligned: list items `- name:` sit at the *same* indent K, with their
 *     fields (e.g. `image:`) deeper (the style emitted by `helm template`/`kubectl`); or
 *   - dash-indented: list items sit deeper than K.
 * The scope therefore stays open until a line dedents strictly below K, or a line
 * at exactly K that is NOT a list item (a sibling mapping key ends the list).
 *
 * In addition to the container-scope flag, this function tracks `itemFieldIndent`:
 * the expected indent of direct mapping keys in the current container item.
 * It is set eagerly when the first container item is seen, derived from the actual
 * list-item prefix width on that source line (`dashIndent + prefixWidth`), so the
 * depth guard in `parseManifestImagesWithPositions` always has a correct ceiling —
 * even when the container item's first child is a sub-list (e.g. `- env:` before
 * any scalar `name:`/`image:`). Without eager initialization, the guard would fall
 * back to `containerIndent + 4`, which can equal a sub-list entry's indent and
 * mis-accept an env-value `image:` field as a legitimate container image.
 */
function computeContainerScopeLines(lines: string[]): ContainerScopeLineInfo[] {
  const result: ContainerScopeLineInfo[] = Array.from(
    { length: lines.length },
    () => ({ containerIndent: -1, itemFieldIndent: -1 }),
  );
  // Stack of currently-open container-list scopes with per-item tracking.
  let containerScopes: ContainerScopeEntry[] = [];
  // Block-scalar tracking: >= 0 means we're inside a YAML block scalar (| or >)
  // whose key was at this indent level. Lines with indent > blockScalarKeyIndent
  // are block-scalar content and must be skipped — they may contain YAML-like text
  // (embedded manifests in ConfigMaps, etc.) that is opaque string data, not live YAML.
  // Reset on '---' or when indent dedents back to or past the key level.
  let blockScalarKeyIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Blank / comment-only lines don't affect scope or block-scalar state.
    if (/^\s*(#.*)?$/.test(line)) continue;

    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // A document separator resets all scope and block-scalar state.
    if (/^---(\s.*)?$/.test(line)) {
      containerScopes = [];
      blockScalarKeyIndent = -1;
      continue;
    }

    // If inside a block scalar, skip lines that are still part of it.
    if (blockScalarKeyIndent >= 0) {
      if (indent > blockScalarKeyIndent) {
        continue; // still block-scalar content — never a container key or image ref
      }
      // Dedented back to or past the key level — block scalar ends.
      blockScalarKeyIndent = -1;
    }

    // Is this line a YAML list item (starts with a dash after its indent)?
    const isListItem = line.charAt(indent) === "-";

    // Pop any container scopes we've dedented out of. A dash-aligned list item at
    // exactly the key's indent is still part of the list (keep); a plain mapping
    // key at that indent is a sibling that ends the list (pop).
    containerScopes = containerScopes.filter(
      (s) => indent > s.indent || (indent === s.indent && isListItem),
    );

    // Update per-item tracking for the innermost scope.
    const top = containerScopes[containerScopes.length - 1];
    if (top) {
      if (isListItem) {
        if (top.itemDashIndent === -1) {
          // First container item in this scope — record where its dashes live and
          // eagerly set itemFieldIndent from the actual prefix width on this source line.
          // YAML allows "- " followed by any number of spaces (e.g. "-   name:" uses a
          // 4-char prefix), so direct container fields start at dashIndent+prefixWidth,
          // not the hard-coded dashIndent+2. Setting this eagerly avoids the
          // `containerIndent+4` fallback below, which can equal a sub-list entry's
          // actual indent and mis-accept it when the container item's first child is a
          // sub-list (e.g. `- env:` before any scalar `name:`/`image:`).
          const prefixWidth = listItemPrefixWidth(line, indent);
          top.itemDashIndent = indent;
          top.itemFieldIndent = indent + prefixWidth;
        } else if (indent === top.itemDashIndent) {
          // Next container item at the same dash-level — reset field tracking using
          // the actual prefix width of this item's line.
          const prefixWidth = listItemPrefixWidth(line, indent);
          top.itemFieldIndent = indent + prefixWidth;
        }
        // A list item deeper than itemDashIndent is inside a sub-list of the container
        // (e.g. an env[] entry). It does NOT reset the container item's field tracking.
      }
      // No need to update itemFieldIndent from non-dash keys: it is set eagerly above.
    }

    // Record per-line info (after updating tracking so this line gets its own state).
    result[i] = top
      ? { containerIndent: top.indent, itemFieldIndent: top.itemFieldIndent }
      : { containerIndent: -1, itemFieldIndent: -1 };

    // After recording scope for this line, check whether it opens a new container list.
    if (CONTAINER_LIST_KEY_RE.test(line)) {
      containerScopes.push({ indent, itemDashIndent: -1, itemFieldIndent: -1 });
    }

    // Detect a block-scalar value indicator (| or >) on a mapping key line.
    // Any subsequent lines indented deeper than this key are block-scalar content
    // that must not be interpreted as live YAML structure.
    // Regex matches block-scalar indicators with optional chomping/indentation hints
    // in either order: "key: |2+" and "key: |+2" are both valid YAML.
    if (/:\s*[|>](?:[-+]?\d*|\d*[-+]?)\s*(#.*)?$/.test(line)) {
      blockScalarKeyIndent = indent;
    }
  }

  return result;
}

/**
 * Accept/reject ceiling check: is a line at `lineIndent` a direct field of the
 * current container item (per `info`, from `computeContainerScopeLines`)? Colocated
 * with the scope computer so the invariant is auditable/testable in one place rather
 * than duplicated inline at each call site.
 *
 * `itemFieldIndent` is set eagerly the moment the first container item's dash line is
 * seen (see computeContainerScopeLines), so the `containerIndent + 4` fallback is only
 * reachable before that point in the current scope (i.e. `itemFieldIndent === -1`).
 */
function isWithinContainerItemFieldScope(
  info: ContainerScopeLineInfo,
  lineIndent: number,
): boolean {
  const maxImageIndent =
    info.itemFieldIndent >= 0 ? info.itemFieldIndent : info.containerIndent + 4;
  return lineIndent <= maxImageIndent;
}

/**
 * Parse a rendered Kubernetes manifest and return all container image strings
 * with their source-level position info (line index and character offset within
 * that line where the image value starts).
 *
 * After parsing YAML to collect the canonical container-image set, the raw
 * content is scanned line-by-line to locate each `image: <value>` occurrence.
 * Matched lines are additionally required to fall inside a container-list scope
 * so that an unrelated `image:` key (e.g. a CRD `spec.image`) whose value
 * coincides with a real container image is never returned.
 */
export function parseManifestImagesWithPositions(
  content: string,
  sourceFile?: string,
): K8sImageRefWithPos[] {
  // First use the existing YAML parser to get the canonical set of image strings.
  const imageMap = parseManifestImages(content);
  if (imageMap.size === 0) return [];

  const results: K8sImageRefWithPos[] = [];
  const lines = content.split("\n");
  const containerScopeData = computeContainerScopeLines(lines);

  // For each line, check if it matches `image: <value>` (with optional quotes).
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const { containerIndent } = containerScopeData[lineIdx];
    if (containerIndent === -1) continue; // reject non-container `image:` keys

    const line = lines[lineIdx];

    // Match: optional leading whitespace, optional "- " list prefix, then "image:",
    // optional whitespace, then the image value (optionally quoted).
    const lineMatch = /^(\s*(?:-\s*)?image:\s*)(['"]?)([^'"#\s]+)\2/.exec(line);
    if (!lineMatch) continue;

    const imageValue = lineMatch[3];
    if (!imageMap.has(imageValue)) continue;

    // Depth guard: reject `image:` keys that are not a direct field of the container
    // list item — see isWithinContainerItemFieldScope for the ceiling invariant.
    //
    // LIMITATION: The image: field is identified by indentation depth alone. An image: key
    // at exactly itemFieldIndent is accepted regardless of its enclosing key path — e.g. a
    // nested map that happens to indent at the same level as a container field. Safety rests
    // on imageMap.has(value) (populated by the semantic YAML parse) agreeing with indentation.
    // Flow-style YAML and anchors are unaffected (they produce no imageMap entries).
    const lineIndent = /^(\s*)/.exec(line)?.[1].length ?? 0;
    if (!isWithinContainerItemFieldScope(containerScopeData[lineIdx], lineIndent)) continue;

    // valueOffset = length of the "image: " prefix + optional opening quote
    const valueOffset = lineMatch[1].length + lineMatch[2].length;
    const valueLength = imageValue.length;

    const ref = imageMap.get(imageValue) ?? null;
    results.push({
      raw: imageValue,
      ref,
      lineIndex: lineIdx,
      valueOffset,
      valueLength,
    });
  }

  // Warn when the YAML parser found images that the line-scan couldn't locate.
  // This happens for flow-style YAML (containers: [{image: …}]) and YAML anchors/aliases
  // — the age-gate (YAML-based) sees them but the updater position parser does not.
  // The result is a silent no-op write; the warning lets the user know.
  // Note: results.length counts per-line entries, NOT per-unique-image; a single image
  // used in both initContainers and containers produces two entries but one Map key.
  // Drive the warning off the set of *distinct* images found, not raw entry count.
  const located = new Set(results.map((r) => r.raw));
  const missing = [...imageMap.keys()].filter((raw) => !located.has(raw));
  if (missing.length > 0) {
    core.warning(
      `kubernetes${sourceFile ? ` (${sourceFile})` : ""}: ` +
      `${missing.length} image(s) found by YAML parser but could not be located in the ` +
      `source text (likely flow-style YAML or anchor/alias): ${missing.join(", ")}. ` +
      `These images are age-gated but cannot be updated in-place.`,
    );
  }

  return results;
}

export async function getChangedDeps(
  baseRef: string,
  kubernetesFilesInput: string,
): Promise<{ deps: ChangedDep[]; imageRefs: Map<string, ParsedImageRef> }> {
  let files: string[];

  if (kubernetesFilesInput) {
    const allFiles = new Set(await resolveFiles(kubernetesFilesInput));
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter((f) => allFiles.has(f));
  } else {
    // Auto-detect: any changed .yaml/.yml file that contains workload manifests
    const changedFiles = await gitDiffNameOnly(baseRef);
    files = changedFiles.filter(
      (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
    );
  }

  if (files.length === 0) {
    core.info("kubernetes: no changed YAML files");
    return { deps: [], imageRefs: new Map() };
  }

  const allDeps: ChangedDep[] = [];
  const imageRefs = new Map<string, ParsedImageRef>();

  for (const file of files) {
    const diff = await gitDiff(baseRef, file);
    if (!diff) continue;

    let headContent: string;
    try {
      headContent = await fs.readFile(file, "utf8");
    } catch {
      core.info(`kubernetes: could not read ${file}`);
      continue;
    }

    const headRefs = parseManifestImages(headContent);
    if (headRefs.size === 0) continue; // not a manifest with containers

    const baseContent = await gitShowFile(baseRef, file);
    const baseRefs = baseContent
      ? parseManifestImages(baseContent)
      : new Map<string, ParsedImageRef>();

    // No imageExists gate here: k8s manifest `image:` fields are unambiguous real
    // image references (unlike docker COPY --from which can be a build-context alias).
    // parseImageRef already drops invalid names (placeholders, uppercase, etc.).
    //
    // Compare by resolved identity (digest), not the raw manifest string: a
    // no-op relabel of an image whose digest is already on base must not be
    // re-flagged, since that exact content was already vetted on the base branch.
    const baseIdentities = new Set<string>();
    for (const bRef of baseRefs.values()) baseIdentities.add(imageIdentity(bRef));

    for (const ref of headRefs.values()) {
      if (baseIdentities.has(imageIdentity(ref))) continue; // identity already on base

      const name = makeName(ref);
      const version = makeVersion(ref);
      imageRefs.set(`${name}@${version}`, ref);

      allDeps.push({
        ecosystem: "kubernetes",
        name,
        version,
        file,
      });
    }
  }

  return { deps: allDeps, imageRefs };
}

/**
 * Get the publish date for an image reference.
 * Only digest-pinned (@sha256:...) refs are queried — tag-only refs are
 * mutable and cannot be reliably age-gated, so they return null (unknown).
 */
export async function getPublishDate(
  ref: ParsedImageRef | undefined,
): Promise<Date | null> {
  return getImagePublishDate(ref, "kubernetes");
}
