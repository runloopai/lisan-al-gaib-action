import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as core from "@actions/core";
import { applyFileEdit, buildFileContent } from "../src/update/apply.js";
import type { FileEdit } from "../src/update/types.js";
import { buildBazelVersionEdits } from "../src/update/ecosystems/bazel-shared.js";
import type { BazelVersionPosition } from "../src/update/ecosystems/bazel-shared.js";

let tmpDir: string | undefined;

function tmpFile(content: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lisan-test-"));
  const f = path.join(tmpDir, "test.txt");
  fs.writeFileSync(f, content);
  return f;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("applyFileEdit", () => {
  it("string rewrite: replaces search string with replace", async () => {
    const f = tmpFile("uses: actions/checkout@old");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ search: "old", replace: "new" }],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("uses: actions/checkout@new");
  });

  it("string rewrite: errors and skips when 3 occurrences match", async () => {
    const original = "old old old";
    const f = tmpFile(original);
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const edit: FileEdit = {
      file: f,
      rewrites: [{ search: "old", replace: "new" }],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe(original); // unchanged — ambiguous rewrite skipped
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/3 occurrences/);
    warnSpy.mockRestore();
  });

  it("string rewrite no-op: file unchanged and core.warning called when search not found", async () => {
    const original = "no match here";
    const f = tmpFile(original);
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});

    const edit: FileEdit = {
      file: f,
      rewrites: [{ search: "missing", replace: "replacement" }],
    };
    await applyFileEdit(edit);

    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe(original);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toContain("missing");

    warnSpy.mockRestore();
  });

  it("offset rewrite: replaces specific byte range, preserves surrounding content", async () => {
    // "hello world" — replace bytes 6..10 ("world") with "there"
    const f = tmpFile("hello world");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: 6, length: 5, replace: "there", expected: "world" }],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("hello there");
  });

  it("multiple offset rewrites applied in reverse order", async () => {
    // "aaa bbb ccc" — replace "aaa" (offset 0, len 3) and "ccc" (offset 8, len 3)
    // Both should be applied correctly even if provided in forward order
    const f = tmpFile("aaa bbb ccc");
    const edit: FileEdit = {
      file: f,
      rewrites: [
        { offset: 0, length: 3, replace: "AAA", expected: "aaa" },  // first in array (lower offset)
        { offset: 8, length: 3, replace: "CCC", expected: "ccc" },  // second in array (higher offset)
      ],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("AAA bbb CCC");
  });

  it("mixed rewrites: offset rewrite applied before string rewrite", async () => {
    // Offset rewrite at bytes 0..4 changes "FROM" → "BASE"
    // String rewrite then changes "nginx" → "httpd"
    const content = "FROM nginx:1.20";
    const f = tmpFile(content);
    const edit: FileEdit = {
      file: f,
      rewrites: [
        { offset: 0, length: 4, replace: "BASE", expected: "FROM" },
        { search: "nginx", replace: "httpd" },
      ],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("BASE httpd:1.20");
  });

  it("identity rewrite: search === replace means no file write (file unchanged)", async () => {
    const original = "uses: actions/checkout@v4";
    const f = tmpFile(original);
    // Wait a tiny bit so mtime would differ if written
    await new Promise((r) => setTimeout(r, 10));

    const edit: FileEdit = {
      file: f,
      rewrites: [{ search: "v4", replace: "v4" }],
    };
    await applyFileEdit(edit);

    // The file should have the same content (no write happened or no change in content)
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe(original);
  });

  it("multiple offset rewrites are sorted descending by offset before application", async () => {
    // Provide in ascending offset order; implementation must sort descending
    // Content: "111 222 333"
    // Replace "111" at offset 0 with "AAA", "333" at offset 8 with "ZZZ"
    const f = tmpFile("111 222 333");
    const edit: FileEdit = {
      file: f,
      rewrites: [
        { offset: 8, length: 3, replace: "ZZZ", expected: "333" },  // high offset first in array
        { offset: 0, length: 3, replace: "AAA", expected: "111" },  // low offset second in array
      ],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("AAA 222 ZZZ");
  });

  it("offset rewrite changing length does not corrupt adjacent content", async () => {
    // Replace a shorter string with a longer one at beginning
    // "hi world" — replace "hi" (offset 0, len 2) with "hello"
    const f = tmpFile("hi world");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: 0, length: 2, replace: "hello", expected: "hi" }],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("hello world");
  });

  it("offset rewrite: throws on out-of-bounds offset", async () => {
    const f = tmpFile("hello");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: 3, length: 10, replace: "x" }], // 3+10=13 > 5
    };
    await expect(applyFileEdit(edit)).rejects.toThrow(/out of bounds/);
  });

  it("offset rewrite: throws on negative offset", async () => {
    const f = tmpFile("hello");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: -1, length: 2, replace: "x" }],
    };
    await expect(applyFileEdit(edit)).rejects.toThrow(/out of bounds/);
  });

  it("offset rewrite: throws on NaN offset (S2 fuzzer guard)", async () => {
    // NaN passes `< 0` checks, so it must be caught by the Number.isInteger guard.
    const f = tmpFile("hello");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: NaN, length: 2, replace: "x" } as never],
    };
    await expect(applyFileEdit(edit)).rejects.toThrow(/non-integer/);
  });

  it("offset rewrite: throws on NaN length (S2 fuzzer guard)", async () => {
    const f = tmpFile("hello");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: 0, length: NaN, replace: "x" } as never],
    };
    await expect(applyFileEdit(edit)).rejects.toThrow(/non-integer/);
  });

  it("offset rewrite: throws on non-integer float offset (S2 fuzzer guard)", async () => {
    const f = tmpFile("hello");
    const edit: FileEdit = {
      file: f,
      rewrites: [{ offset: 1.5, length: 2, replace: "x" } as never],
    };
    await expect(applyFileEdit(edit)).rejects.toThrow(/non-integer/);
  });

  it("offset rewrite: throws on overlapping rewrites", async () => {
    const f = tmpFile("hello world");
    const edit: FileEdit = {
      file: f,
      rewrites: [
        { offset: 0, length: 7, replace: "hi" },  // covers 0..7
        { offset: 4, length: 3, replace: "ZZ" },  // overlaps: 4..7 inside 0..7
      ],
    };
    await expect(applyFileEdit(edit)).rejects.toThrow(/overlapping/);
  });

  it("string rewrite: errors and skips when search matches multiple occurrences", async () => {
    const original = "v1.0 and v1.0";
    const f = tmpFile(original);
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const edit: FileEdit = {
      file: f,
      rewrites: [{ search: "v1.0", replace: "v2.0" }],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe(original); // unchanged — ambiguous rewrite skipped
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/2 occurrences/);
    warnSpy.mockRestore();
  });

  it("malformed Rewrite with both keys: warns and skips", async () => {
    const f = tmpFile("hello");
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const edit: FileEdit = {
      file: f,
      // Cast to bypass type system — simulates parser emitting garbage
      rewrites: [{ offset: 0, length: 1, replace: "x", search: "h" } as never],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("hello"); // unchanged
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toContain("both");
    warnSpy.mockRestore();
  });

  it("malformed Rewrite with neither key: warns and skips", async () => {
    const f = tmpFile("hello");
    const warnSpy = vi.spyOn(core, "warning").mockImplementation(() => {});
    const edit: FileEdit = {
      file: f,
      rewrites: [{} as never],
    };
    await applyFileEdit(edit);
    const result = fs.readFileSync(f, "utf8");
    expect(result).toBe("hello"); // unchanged
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(String(warnSpy.mock.calls[0][0])).toContain("neither");
    warnSpy.mockRestore();
  });
});

// ─── Round-trip: buildBazelVersionEdits + applyFileEdit ────────────────────
// These tests write a real temp file and run the full discover→build→apply
// pipeline to guard against regressions where `expected` is computed from
// versionRef.value (the full effective version) rather than the literal stored
// in the constant definition (the fragment without templatePrefix/Suffix).

describe("buildBazelVersionEdits + applyFileEdit round-trip", () => {
  it("non-templated version: updates constant literal in-place", async () => {
    // Simulates: SERDE_VERSION = "1.0.150"
    // Offsets:   0              19 20   24 25
    //            SERDE_VERSION   = " 1.0.150 "
    const content = 'SERDE_VERSION = "1.0.150"\n';
    // opening quote at index 16, content at 17..23, closing quote at 24
    const f = tmpFile(content);
    const position: BazelVersionPosition = {
      file: f,
      versionRef: {
        value: "1.0.150",
        nodeStart: 17,   // index of '1' (first char inside quotes)
        nodeEnd: 24,     // index of closing '"'
        templatePrefix: "",
        templateSuffix: "",
      },
    };
    const candidate = {
      dep: { ecosystem: "rust" as const, name: "serde", file: f, current: "1.0.150", position },
      latest: "1.0.200",
      updateLevel: "patch" as const,
      publishDate: null,
      ageDays: null,
      breaking: false,
    };
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    await applyFileEdit(edits[0]);
    expect(fs.readFileSync(f, "utf8")).toBe('SERDE_VERSION = "1.0.200"\n');
  });

  it("templated version: strips templatePrefix from expected, updates literal in file", async () => {
    // Simulates: PROTOBUF_VERSION = "32.1"  (used as "4.%s" % PROTOBUF_VERSION → "4.32.1")
    // Index:      0                  19 20  24 25
    const content = 'PROTOBUF_VERSION = "32.1"\n';
    // opening quote at index 19, content "32.1" at 20..23, closing quote at 24
    const f = tmpFile(content);
    const position: BazelVersionPosition = {
      file: f,
      versionRef: {
        value: "4.32.1",   // full effective version (prefix + literal)
        nodeStart: 20,     // index of '3' (first char inside quotes)
        nodeEnd: 24,       // index of closing '"'
        templatePrefix: "4.",
        templateSuffix: "",
      },
    };
    const candidate = {
      dep: { ecosystem: "rust" as const, name: "protobuf", file: f, current: "4.32.1", position },
      latest: "4.33.0",
      updateLevel: "minor" as const,
      publishDate: null,
      ageDays: null,
      breaking: false,
    };
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    // Must not throw "stale offset" — expected must be '"32.1"', not '"4.32.1"'
    await applyFileEdit(edits[0]);
    expect(fs.readFileSync(f, "utf8")).toBe('PROTOBUF_VERSION = "33.0"\n');
  });

  it("templateSuffix-only: strips suffix from expected, updates literal in file", async () => {
    // Simulates: RUST_VERSION = "32"  (used as "%s-final" % RUST_VERSION → "32-final")
    // Content:   RUST_VERSION = "32"\n
    // Index:     0            15 16 17 18 19
    const content = 'RUST_VERSION = "32"\n';
    // opening quote at 15, content "32" at 16-17, closing quote at 18
    const f = tmpFile(content);
    const position: BazelVersionPosition = {
      file: f,
      versionRef: {
        value: "32-final",   // full effective version (literal + suffix)
        nodeStart: 16,       // index of '3'
        nodeEnd: 18,         // index of closing '"'
        templatePrefix: "",
        templateSuffix: "-final",
      },
    };
    const candidate = {
      dep: { ecosystem: "bazel" as const, name: "my_module", file: f, current: "32-final", position },
      latest: "33-final",
      updateLevel: "major" as const,
      publishDate: null,
      ageDays: null,
      breaking: true,
    };
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    await applyFileEdit(edits[0]);
    expect(fs.readFileSync(f, "utf8")).toBe('RUST_VERSION = "33"\n');
  });

  it("Cargo-prefixed non-templated: expected includes specifier prefix, rewrite re-prepends it", async () => {
    // Simulates: SERDE_VERSION = "=1.0.150"  (Cargo exact-match specifier)
    // Content:   SERDE_VERSION = "=1.0.150"\n
    // Index:     0              16 17      25 26
    const content = 'SERDE_VERSION = "=1.0.150"\n';
    // opening quote at 16, content "=1.0.150" at 17-24, closing quote at 25
    const f = tmpFile(content);
    const position: BazelVersionPosition = {
      file: f,
      versionRef: {
        value: "=1.0.150",   // includes the Cargo specifier prefix
        nodeStart: 17,       // index of '='
        nodeEnd: 25,         // index of closing '"'
        templatePrefix: "",
        templateSuffix: "",
      },
      versionPrefix: "=",    // Cargo specifier to re-apply in the replacement
    };
    const candidate = {
      dep: { ecosystem: "rust" as const, name: "serde", file: f, current: "=1.0.150", position },
      latest: "1.0.200",     // bare version, versionPrefix is applied separately
      updateLevel: "patch" as const,
      publishDate: null,
      ageDays: null,
      breaking: false,
    };
    const edits = await buildBazelVersionEdits([candidate]);
    expect(edits).toHaveLength(1);
    await applyFileEdit(edits[0]);
    // The = prefix must appear exactly once in the output
    expect(fs.readFileSync(f, "utf8")).toBe('SERDE_VERSION = "=1.0.200"\n');
  });

  it("stale offset: throws when file content has changed since discover", async () => {
    const content = 'SERDE_VERSION = "1.0.150"\n';
    const f = tmpFile(content);
    const position: BazelVersionPosition = {
      file: f,
      versionRef: {
        value: "1.0.150",
        nodeStart: 17,
        nodeEnd: 24,
        templatePrefix: "",
        templateSuffix: "",
      },
    };
    const candidate = {
      dep: { ecosystem: "rust" as const, name: "serde", file: f, current: "1.0.150", position },
      latest: "1.0.200",
      updateLevel: "patch" as const,
      publishDate: null,
      ageDays: null,
      breaking: false,
    };
    const edits = await buildBazelVersionEdits([candidate]);
    // Mutate the file between build and apply to simulate a concurrent change
    fs.writeFileSync(f, 'SERDE_VERSION = "1.0.999"\n');
    await expect(applyFileEdit(edits[0])).rejects.toThrow(/stale offset/);
  });
});

// ─── Multi-byte / UTF-16 offset safety ───────────────────────────────────────
// These tests verify that offset rewrites are applied using UTF-16 code-unit
// positions (String.prototype.slice semantics), not byte positions. A mismatch
// would corrupt any file containing non-ASCII characters before the rewrite target.

describe("multi-byte UTF-16 offset safety", () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisan-utf16-"));
    tmpFilePath = path.join(tmpDir, "test.txt");
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true }).catch(() => undefined);
  });

  it("correctly applies a rewrite when a BMP non-ASCII char precedes the target", async () => {
    // "é" (U+00E9) is 1 UTF-16 code unit but 2 UTF-8 bytes.
    // If offsets were byte-based instead of UTF-16, the rewrite would target the wrong position.
    const content = "# café\nFROM nginx:1.24\n";
    // "nginx:1.24" starts at UTF-16 offset: "# café\nFROM ".length = 12 (é = 1 code unit)
    const fromOffset = "# café\nFROM ".length;
    const target = "nginx:1.24";
    // Rewrite to replace "nginx:1.24" with "nginx:1.25@sha256:abc"
    const replace = "nginx:1.25@sha256:abc";
    const edit: FileEdit = {
      file: tmpFilePath,
      rewrites: [{ offset: fromOffset, length: target.length, replace, expected: target }],
    };
    await fsp.writeFile(tmpFilePath, content, "utf8");
    await applyFileEdit(edit);
    const result = await fsp.readFile(tmpFilePath, "utf8");
    expect(result).toBe("# café\nFROM nginx:1.25@sha256:abc\n");
  });

  it("correctly applies a rewrite when an astral-plane char (surrogate pair) precedes the target", async () => {
    // "🎉" (U+1F389) is 2 UTF-16 code units (surrogate pair), 4 UTF-8 bytes.
    const emoji = "\u{1F389}"; // = "🎉" in UTF-16
    const content = `# ${emoji} release\nnginx:1.24\n`;
    // "nginx:1.24" starts at: "# 🎉 release\n".length where 🎉 = 2 code units
    const fromOffset = `# ${emoji} release\n`.length;
    const target = "nginx:1.24";
    const replace = "nginx:1.25";
    const edit: FileEdit = {
      file: tmpFilePath,
      rewrites: [{ offset: fromOffset, length: target.length, replace, expected: target }],
    };
    await fsp.writeFile(tmpFilePath, content, "utf8");
    await applyFileEdit(edit);
    const result = await fsp.readFile(tmpFilePath, "utf8");
    expect(result).toBe(`# ${emoji} release\nnginx:1.25\n`);
  });
});

// ─── Zero-length insertion overlap/adjacency ──────────────────────────────────
// buildFileContent must treat zero-length rewrites (insertions) as non-overlapping
// with adjacent rewrites and with each other, since they occupy no byte range.

describe("zero-length insertion (offset rewrite with length=0)", () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lisan-zero-"));
    tmpFilePath = path.join(tmpDir, "test.txt");
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true }).catch(() => undefined);
  });

  it("two zero-length insertions at the same offset both apply (not considered overlap)", async () => {
    // Two insertions at offset 0 are both insertions; the sorted order determines which comes first.
    // Both should be applied; no overlap error.
    const content = "foo";
    const edit: FileEdit = {
      file: tmpFilePath,
      rewrites: [
        { offset: 0, length: 0, replace: "A", expected: "" },
        { offset: 0, length: 0, replace: "B", expected: "" },
      ],
    };
    await fsp.writeFile(tmpFilePath, content, "utf8");
    // Should not throw
    const { content: result } = await buildFileContent(edit);
    // Both A and B should have been inserted at offset 0 (order depends on sort)
    expect(result).toContain("A");
    expect(result).toContain("B");
    expect(result).toContain("foo");
  });

  it("zero-length insertion at boundary of a non-zero rewrite does not throw overlap", async () => {
    const content = "hello world";
    const edit: FileEdit = {
      file: tmpFilePath,
      rewrites: [
        { offset: 5, length: 0, replace: ",", expected: "" }, // insert after "hello"
        { offset: 6, length: 5, replace: "earth", expected: "world" }, // replace "world"
      ],
    };
    await fsp.writeFile(tmpFilePath, content, "utf8");
    const { content: result } = await buildFileContent(edit);
    expect(result).toBe("hello, earth");
  });

  it("zero-length insertion strictly inside a positive-length rewrite's range throws", async () => {
    // Offset 5 falls strictly inside [0, 11) — this must be rejected as an overlap even
    // though a naive adjacency-only check (sorted by offset desc, tie-broken by ascending
    // length) would sort the zero-length insertion before the positive-length rewrite and
    // skip the check because "prev.length === 0".
    const content = "hello world";
    const edit: FileEdit = {
      file: tmpFilePath,
      rewrites: [
        { offset: 0, length: 11, replace: "goodbye moon", expected: "hello world" },
        { offset: 5, length: 0, replace: "!", expected: "" },
      ],
    };
    await fsp.writeFile(tmpFilePath, content, "utf8");
    await expect(buildFileContent(edit)).rejects.toThrow(/falls inside/);
  });
});
