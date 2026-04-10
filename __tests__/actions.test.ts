import { describe, it, expect } from "vitest";
import { parseActionRefs } from "../src/ecosystems/actions.js";

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

  it("ignores inline comments after uses", () => {
    const content = `
  - uses: actions/checkout@v4 # pin to v4
`;
    const refs = parseActionRefs(content);
    expect(refs.size).toBe(1);
    expect(refs.get("actions/checkout@v4")!.ref).toBe("v4");
  });
});
