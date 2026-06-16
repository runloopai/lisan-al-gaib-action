import { describe, it, expect } from "vitest";
import { parseActionRefs, parseActionRefsWithPositions } from "../src/ecosystems/actions.js";

describe("parseActionRefsWithPositions", () => {
  it("matchOffset/matchLength span the full 'uses: <ref>' token", () => {
    const content = `      - uses: actions/checkout@v4\n`;
    const refs = parseActionRefsWithPositions(content);
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    const matched = content.slice(ref.matchOffset, ref.matchOffset + ref.matchLength);
    expect(matched).toBe("uses: actions/checkout@v4");
    expect(matched).toContain("actions/checkout@v4");
    expect(ref.raw).toBe("actions/checkout@v4");
  });

  it("captures a trailing version comment", () => {
    const content = `      - uses: actions/checkout@abc123  # v4.2.3\n`;
    const refs = parseActionRefsWithPositions(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].trailingComment).toBe("# v4.2.3");
    expect(refs[0].trailingCommentLength).toBeGreaterThan(0);
  });

  it("does not match an unbalanced opening quote (\\1 backreference requires a closing quote)", () => {
    const content = `      - uses: "actions/checkout@v4\n`;
    const refs = parseActionRefsWithPositions(content);
    expect(refs).toHaveLength(0);
  });

  it("skips expression-templated refs (${{ matrix.version }}) — cannot be rewritten safely", () => {
    const content = [
      "      - uses: actions/checkout@${{ matrix.ref }}",
      "      - uses: actions/setup-node@v4",
    ].join("\n") + "\n";
    const refs = parseActionRefsWithPositions(content);
    // Only the literal ref should be returned; the expression-templated one must be skipped
    expect(refs).toHaveLength(1);
    expect(refs[0].raw).toBe("actions/setup-node@v4");
  });

  it("skips bare-$ variable refs ($ACTIONS_REF) — cannot be rewritten safely", () => {
    const content = `      - uses: actions/checkout@$ACTIONS_REF\n`;
    const refs = parseActionRefsWithPositions(content);
    expect(refs).toHaveLength(0);
  });

  it("skips uses: tokens inside a run: | block scalar body (regression — corrupt rewrite risk)", () => {
    // A shell script inside `run: |` may contain a literal `uses: owner/repo@v1` line.
    // The linePrefix whitespace guard alone is insufficient because the line is indented.
    // Without the block-scalar exclusion, the updater would emit a byte-offset rewrite
    // targeting the shell script body, silently corrupting the workflow file.
    const content = [
      "jobs:",
      "  build:",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: |",
      "          echo 'this is shell'",
      "          uses: fake/action@v1",    // must NOT be parsed as an action ref
      "          echo 'end of script'",
      "      - uses: actions/setup-node@v3",  // must be parsed
    ].join("\n") + "\n";

    const refs = parseActionRefsWithPositions(content);

    // Only the two genuine step-level `uses:` directives should be returned.
    // The `uses:` inside the `run: |` block scalar must be excluded.
    expect(refs).toHaveLength(2);
    const raws = refs.map((r) => r.raw).sort();
    expect(raws).toContain("actions/checkout@v4");
    expect(raws).toContain("actions/setup-node@v3");
    expect(raws).not.toContain("fake/action@v1");
  });

  it("skips uses: tokens inside a run: > (folded) block scalar body", () => {
    // `>` (folded) block scalars are treated the same as `|` (literal).
    const content = [
      "steps:",
      "  - uses: actions/checkout@v4",
      "  - run: >",
      "      echo hello &&",
      "      uses: injected/action@v99",   // must NOT be parsed
      "  - uses: actions/setup-node@v3",
    ].join("\n") + "\n";

    const refs = parseActionRefsWithPositions(content);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.raw)).not.toContain("injected/action@v99");
  });
});

describe("parseActionRefs", () => {
  it("parses owner/repo@ref", () => {
    const content = `
steps:
  - uses: actions/checkout@v4
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(1);
    const ref = refs.get("actions/checkout@v4")!;
    expect(ref.owner).toBe("actions");
    expect(ref.repo).toBe("checkout");
    expect(ref.path).toBe("");
    expect(ref.ref).toBe("v4");
  });

  it("parses owner/repo/path@ref", () => {
    const content = `
  - uses: actions/cache/restore@v4
`;
    const refs = parseActionRefs(content);
    const ref = refs.get("actions/cache/restore@v4")!;
    expect(ref.owner).toBe("actions");
    expect(ref.repo).toBe("cache");
    expect(ref.path).toBe("restore");
    expect(ref.ref).toBe("v4");
  });

  it("parses commit SHA refs", () => {
    const content = `
  - uses: actions/checkout@a5ac7e51b41094c92402da3b24376905380afc29
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(1);
    const ref = refs.values().next().value!;
    expect(ref.ref).toBe("a5ac7e51b41094c92402da3b24376905380afc29");
  });

  it("skips local actions (./)", () => {
    const content = `
  - uses: ./
  - uses: ./.github/actions/my-action
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(0);
  });

  it("skips docker actions", () => {
    const content = `
  - uses: docker://alpine:3.18
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(0);
  });

  it("handles quoted uses values", () => {
    const content = `
  - uses: 'actions/checkout@v4'
  - uses: "actions/setup-node@v4"
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(2);
    expect(refs.has("actions/checkout@v4")).toBe(true);
    expect(refs.has("actions/setup-node@v4")).toBe(true);
  });

  it("extracts multiple actions from one file", () => {
    const content = `
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: actions/cache@v3
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(3);
  });

  it("skips uses without @ref", () => {
    const content = `
  - uses: actions/checkout
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(0);
  });

  it("handles deeply nested subpaths", () => {
    const content = `
  - uses: owner/repo/a/b/c@v1
`;
    const refs = parseActionRefs(content);
    const ref = refs.get("owner/repo/a/b/c@v1")!;
    expect(ref.path).toBe("a/b/c");
  });

  it("ignores uses: inside comment lines", () => {
    const content = `
# uses: actions/old-thing@v1
  # uses: actions/another-old@v2
steps:
  - uses: actions/checkout@v4
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(1);
    expect(refs.has("actions/checkout@v4")).toBe(true);
  });

  it("ignores inline comments after uses", () => {
    const content = `
  - uses: actions/checkout@v4 # pin to v4
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(1);
    expect(refs.get("actions/checkout@v4")!.ref).toBe("v4");
  });
});

// ─── CRLF line-ending round-trip ─────────────────────────────────────────────
describe("parseActionRefsWithPositions — CRLF line endings", () => {
  const LF_CONTENT = "steps:\n  - uses: actions/checkout@v4\n  - uses: actions/setup-node@v3\n";
  const CRLF_CONTENT = LF_CONTENT.replace(/\n/g, "\r\n");

  it("finds the same action refs under CRLF as under LF", () => {
    const lf = parseActionRefsWithPositions(LF_CONTENT);
    const crlf = parseActionRefsWithPositions(CRLF_CONTENT);
    expect(crlf.map((r) => r.raw).sort()).toEqual(lf.map((r) => r.raw).sort());
  });

  it("matchOffset points to the correct bytes in the CRLF content", () => {
    const refs = parseActionRefsWithPositions(CRLF_CONTENT);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      const matched = CRLF_CONTENT.slice(ref.matchOffset, ref.matchOffset + ref.matchLength);
      expect(matched).toContain(ref.raw);
    }
  });
});
