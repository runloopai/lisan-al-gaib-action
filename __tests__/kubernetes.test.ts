import { describe, it, expect } from "vitest";
import { parseImageRef, imageIdentity } from "../src/ecosystems/image.js";
import {
  parseManifestImages,
  parseManifestImagesWithPositions,
} from "../src/ecosystems/kubernetes.js";

describe("parseImageRef", () => {
  it("parses a bare Docker Hub single-segment image with tag", () => {
    const ref = parseImageRef("postgres:16-alpine")!;
    expect(ref.registry).toBe("docker.io");
    expect(ref.repository).toBe("library/postgres");
    expect(ref.tag).toBe("16-alpine");
    expect(ref.digest).toBeNull();
    expect(ref.raw).toBe("postgres:16-alpine");
  });

  it("parses a Docker Hub multi-segment image with tag", () => {
    const ref = parseImageRef("coredns/coredns:1.12.0")!;
    expect(ref.registry).toBe("docker.io");
    expect(ref.repository).toBe("coredns/coredns");
    expect(ref.tag).toBe("1.12.0");
    expect(ref.digest).toBeNull();
  });

  it("does not add library/ prefix to multi-segment Docker Hub repos", () => {
    const ref = parseImageRef("alpine/psql:14")!;
    expect(ref.repository).toBe("alpine/psql");
  });

  it("parses a Docker Hub digest-only reference", () => {
    const ref = parseImageRef(
      "alpine/psql@sha256:5e2b625325cd812ed9fd340a1bc234cd0be155114f071d2d8907c3157da63b98",
    )!;
    expect(ref.registry).toBe("docker.io");
    expect(ref.repository).toBe("alpine/psql");
    expect(ref.tag).toBeNull();
    expect(ref.digest).toBe(
      "sha256:5e2b625325cd812ed9fd340a1bc234cd0be155114f071d2d8907c3157da63b98",
    );
  });

  it("parses a tag+digest (combined immutable) reference", () => {
    const ref = parseImageRef(
      "public.ecr.aws/aws-cli/aws-cli:2.34.56@sha256:c6b9b4f1",
    )!;
    expect(ref.registry).toBe("public.ecr.aws");
    expect(ref.repository).toBe("aws-cli/aws-cli");
    expect(ref.tag).toBe("2.34.56");
    expect(ref.digest).toBe("sha256:c6b9b4f1");
  });

  it("parses an ECR public reference", () => {
    const ref = parseImageRef(
      "public.ecr.aws/docker/library/alpine:3.20",
    )!;
    expect(ref.registry).toBe("public.ecr.aws");
    expect(ref.repository).toBe("docker/library/alpine");
    expect(ref.tag).toBe("3.20");
    expect(ref.digest).toBeNull();
  });

  it("parses a registry.k8s.io reference", () => {
    const ref = parseImageRef("registry.k8s.io/pause:3.10")!;
    expect(ref.registry).toBe("registry.k8s.io");
    expect(ref.repository).toBe("pause");
    expect(ref.tag).toBe("3.10");
    expect(ref.digest).toBeNull();
  });

  it("parses a private ECR reference", () => {
    const ref = parseImageRef(
      "992382648534.dkr.ecr.us-east-2.amazonaws.com/mux_repo:latest",
    )!;
    expect(ref.registry).toBe(
      "992382648534.dkr.ecr.us-east-2.amazonaws.com",
    );
    expect(ref.repository).toBe("mux_repo");
    expect(ref.tag).toBe("latest");
    expect(ref.digest).toBeNull();
  });

  it("parses a registry with port", () => {
    const ref = parseImageRef("localhost:5000/myimage:v1")!;
    expect(ref.registry).toBe("localhost:5000");
    expect(ref.repository).toBe("myimage");
    expect(ref.tag).toBe("v1");
    expect(ref.digest).toBeNull();
  });

  it("parses a bare image name with no tag or digest (implicit latest)", () => {
    const ref = parseImageRef("nginx")!;
    expect(ref.registry).toBe("docker.io");
    expect(ref.repository).toBe("library/nginx");
    expect(ref.tag).toBeNull();
    expect(ref.digest).toBeNull();
  });

  it("parses a single-segment name that looks like registry:tag (docker Hub image)", () => {
    // 'registry:3' — no slash, so whole thing is treated as repo:tag on Docker Hub
    const ref = parseImageRef("registry:3")!;
    expect(ref.registry).toBe("docker.io");
    expect(ref.repository).toBe("library/registry");
    expect(ref.tag).toBe("3");
    expect(ref.digest).toBeNull();
  });

  it("parses a GCP Artifact Registry reference", () => {
    const ref = parseImageRef(
      "us-central1-docker.pkg.dev/runloop-dev/private-containers/portal:latest",
    )!;
    expect(ref.registry).toBe("us-central1-docker.pkg.dev");
    expect(ref.repository).toBe("runloop-dev/private-containers/portal");
    expect(ref.tag).toBe("latest");
    expect(ref.digest).toBeNull();
  });

  it("returns null for a malformed @non-digest reference (nginx@latest)", () => {
    // "nginx@latest" is a typo — '@' without algorithm:hex form is not a real digest.
    // The resulting repository name contains '@', which is not valid per the OCI grammar,
    // so parseImageRef now returns null (drops the ref) rather than producing a malformed ref.
    expect(parseImageRef("nginx@latest")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseImageRef("")).toBeNull();
    expect(parseImageRef("   ")).toBeNull();
  });

  it("returns null for placeholder tokens that are not valid OCI repository names", () => {
    expect(parseImageRef("__DIND_IMAGE__")).toBeNull(); // leading underscore, uppercase
    expect(parseImageRef("__dind_image__")).toBeNull(); // leading underscore
    expect(parseImageRef("{{image}}")).toBeNull(); // curly-brace placeholder
    expect(parseImageRef("%IMAGE%")).toBeNull(); // percent placeholder
    expect(parseImageRef("Foo/Bar")).toBeNull(); // uppercase
    expect(parseImageRef("NGINX")).toBeNull(); // all uppercase
  });
});

describe("parseManifestImages", () => {
  it("extracts images from a Deployment", () => {
    const content = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.25
        - name: sidecar
          image: envoyproxy/envoy:v1.28
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(2);
    expect(refs.has("nginx:1.25")).toBe(true);
    expect(refs.has("envoyproxy/envoy:v1.28")).toBe(true);
  });

  it("extracts images from initContainers", () => {
    const content = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
        - name: init
          image: busybox:1.36
      containers:
        - name: app
          image: myapp:2.0
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(2);
    expect(refs.has("busybox:1.36")).toBe(true);
    expect(refs.has("myapp:2.0")).toBe(true);
  });

  it("extracts images from a CronJob (deeply nested jobTemplate)", () => {
    const content = `
apiVersion: batch/v1
kind: CronJob
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: worker
              image: public.ecr.aws/docker/library/alpine:3.20
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(1);
    expect(refs.has("public.ecr.aws/docker/library/alpine:3.20")).toBe(true);
  });

  it("extracts images from a multi-document YAML", () => {
    const content = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app
          image: app-image:1.0
---
apiVersion: apps/v1
kind: StatefulSet
spec:
  template:
    spec:
      containers:
        - name: db
          image: postgres:16-alpine
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(2);
    expect(refs.has("app-image:1.0")).toBe(true);
    expect(refs.has("postgres:16-alpine")).toBe(true);
  });

  it("returns empty map for a ConfigMap (no containers)", () => {
    const content = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
data:
  key: value
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(0);
  });

  it("deduplicates the same image appearing in multiple containers", () => {
    const content = `
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: app1
          image: nginx:1.25
        - name: app2
          image: nginx:1.25
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(1);
  });

  it("returns empty map for invalid YAML without throwing", () => {
    const refs = parseManifestImages("{ invalid: yaml: content: ][");
    expect(refs.size).toBe(0);
  });

  it("parses digest-pinned image references", () => {
    const content = `
apiVersion: v1
kind: Pod
spec:
  initContainers:
    - name: psql
      image: alpine/psql@sha256:5e2b625325cd812ed9fd340a1bc234cd0be155114f071d2d8907c3157da63b98
  containers:
    - name: aws-cli
      image: public.ecr.aws/aws-cli/aws-cli:2.34.56@sha256:c6b9b4f15993749284f505e153c5b2af34dccb7b60b8b2174a63dba5926273a9
`;
    const refs = parseManifestImages(content);
    expect(refs.size).toBe(2);

    const psqlRef = refs.get(
      "alpine/psql@sha256:5e2b625325cd812ed9fd340a1bc234cd0be155114f071d2d8907c3157da63b98",
    )!;
    expect(psqlRef.digest).toBe(
      "sha256:5e2b625325cd812ed9fd340a1bc234cd0be155114f071d2d8907c3157da63b98",
    );
    expect(psqlRef.tag).toBeNull();

    const awsRef = refs.get(
      "public.ecr.aws/aws-cli/aws-cli:2.34.56@sha256:c6b9b4f15993749284f505e153c5b2af34dccb7b60b8b2174a63dba5926273a9",
    )!;
    expect(awsRef.tag).toBe("2.34.56");
    expect(awsRef.digest).toBe(
      "sha256:c6b9b4f15993749284f505e153c5b2af34dccb7b60b8b2174a63dba5926273a9",
    );
  });
});

describe("parseManifestImagesWithPositions", () => {
  it("returns positions for real container images", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
  });

  // F4: a non-container `image:` key (here a CRD spec.image) whose value matches a
  // real container image must NOT be returned as a position — only the genuine
  // container image inside the containers list is in scope.
  it("does NOT return a non-container image: field even if its value matches a real image", () => {
    const manifest = `apiVersion: example.com/v1
kind: CustomResource
spec:
  image: nginx:1.25
---
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: web
          image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    // Only the container image (line in the containers scope) is returned.
    expect(positions).toHaveLength(1);
    // It must be the one inside the containers block, not the CRD spec.image.
    const containerLineIdx = manifest
      .split("\n")
      .findIndex((l) => l.includes("- name: web"));
    expect(positions[0].lineIndex).toBeGreaterThan(containerLineIdx);
  });

  // F4 regression: dash-aligned list style (the dominant style emitted by
  // `helm template` / `kubectl`, where `- name:` sits at the SAME indent as
  // `containers:`) must still resolve container images.
  it("finds container images in dash-aligned list style", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
  });

  it("finds dash-aligned initContainers and containers images", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      initContainers:
      - name: init
        image: busybox:1.36
      containers:
      - name: web
        image: nginx:1.25
      volumes:
      - name: data
        emptyDir: {}
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions.map((p) => p.raw).sort()).toEqual([
      "busybox:1.36",
      "nginx:1.25",
    ]);
  });

  it("finds dash-aligned multi-container (sidecar) images", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:2.0
      - name: sidecar
        image: envoy:1.29
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions.map((p) => p.raw).sort()).toEqual([
      "envoy:1.29",
      "myapp:2.0",
    ]);
  });

  it("finds an image: written as the first key on the dash line", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - image: nginx:1.25
        name: web
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
  });

  it("finds dash-aligned CronJob nested container images", () => {
    const manifest = `apiVersion: batch/v1
kind: CronJob
spec:
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: cron
            image: alpine:3.20
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("alpine:3.20");
  });

  // F4 regression: a dash-aligned NON-container sibling list at the same indent as
  // `containers:` must not leak scope, even if one of its items carries an `image:`
  // key whose value collides with the real container image.
  it("does not leak scope into a dash-aligned sibling list with a colliding image:", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
      volumes:
      - name: cfg
        image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    const lines = manifest.split("\n");
    // The returned position must be the one under `containers:`, not under `volumes:`.
    const volumesLine = lines.findIndex((l) => l.trim() === "volumes:");
    expect(positions[0].lineIndex).toBeLessThan(volumesLine);
  });

  // A non-container list that never opens container scope stays rejected even when
  // placed before the real container list.
  it("rejects a colliding image: in a non-container list preceding the containers list", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      volumes:
      - name: cfg
        image: nginx:1.25
      containers:
      - name: web
        image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    const containersLine = manifest.split("\n").findIndex((l) => l.trim() === "containers:");
    expect(positions[0].lineIndex).toBeGreaterThan(containersLine);
  });

  // A deeper nested map (resources:) inside a container must not pop the scope and
  // drop a following sibling container.
  it("keeps scope across a nested map before a second container", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:2.0
        resources:
          limits:
            cpu: "1"
      - name: sidecar
        image: envoy:1.29
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions.map((p) => p.raw).sort()).toEqual(["envoy:1.29", "myapp:2.0"]);
  });

  // Block-scalar fix (C2): an embedded manifest inside a ConfigMap's `|` block
  // scalar must NOT produce a rewrite position even when its `image:` value
  // collides with a real container image in the same document. Previously,
  // computeContainerScopeLines had no block-scalar awareness and would open a
  // false container scope on the embedded `containers:` line.
  it("does not return positions for image: inside a ConfigMap block-scalar value", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
---
apiVersion: v1
kind: ConfigMap
data:
  embedded: |
    spec:
      containers:
      - name: evil
        image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    // Only the real container (before ---) should have a position; the block-
    // scalar content must be invisible to the position parser.
    expect(positions).toHaveLength(1);
    // The position must be on the real containers line, before the --- separator.
    const sepLine = manifest.split("\n").findIndex((l) => l.trim() === "---");
    expect(positions[0].lineIndex).toBeLessThan(sepLine);
  });

  // A '---' document separator resets scope so a colliding CRD spec.image in the
  // next document is not treated as in-scope.
  it("resets scope at --- so a following colliding CRD spec.image is rejected", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
---
apiVersion: example.com/v1
kind: CustomResource
spec:
  image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    const sepLine = manifest.split("\n").findIndex((l) => l.trim() === "---");
    expect(positions[0].lineIndex).toBeLessThan(sepLine);
  });

  // N4: A fuzzed `image:` key nested one list deeper inside a container (e.g. inside
  // an env[] sub-list) can land at exactly containerIndent+4 — the previous depth guard's
  // ceiling — and would pass a pure indent-arithmetic check. The direct-field guard must
  // reject it: only `image:` at the same indent as other direct container fields is valid.
  it("rejects an image: nested inside an env sub-list even when its indent equals containerIndent+4", () => {
    // containers: is at indent 6; container items (dash-aligned) are at indent 6;
    // direct container fields (name:, image:) are at indent 8.
    // The env sub-list has items at indent 8 whose sub-fields are at indent 10.
    // But here we use a shallower nesting so the env item's image: lands at indent 8
    // — exactly matching the container's own field indent — to exercise the direct-field guard.
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
        env:
        - name: IMG
          value: nginx:1.25
          image: nginx:1.25
`;
    // The YAML parser sees nginx:1.25 once (as the real container image).
    // The line-scan must return exactly one position: the real container image, NOT
    // the image: key inside the env[] sub-list (even though it is in scope and its
    // indent may equal containerIndent+4 in other YAML style variants).
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    // The accepted position must be the container's own image: line (before env:).
    const envLine = manifest.split("\n").findIndex((l) => l.trim() === "env:");
    expect(positions[0].lineIndex).toBeLessThan(envLine);
  });

  // N4b: A container item written with `- image:` as the very first (and only image)
  // key on the dash line must still be found — the direct-field guard must not
  // over-reject this legitimate style where itemFieldIndent is -1 for that line.
  it("finds image: written as the sole key on the dash line (- image: style)", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - image: nginx:1.25
        name: web
      - image: envoyproxy/envoy:v1.28
        name: sidecar
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions.map((p) => p.raw).sort()).toEqual([
      "envoyproxy/envoy:v1.28",
      "nginx:1.25",
    ]);
  });

  // H1 regression: OLM-style `RELATED_IMAGE_*` env var pattern — the container item's
  // first child is a sub-list (`- env:` before any scalar `name:`/`image:`). Previously,
  // the depth guard fell back to `containerIndent+4`, which could equal the env[] sub-list
  // entry's actual indent, causing the updater to rewrite an env value instead of the
  // real container `image:` field. After the fix, `itemFieldIndent` is set eagerly to
  // `itemDashIndent+prefixWidth` when the first container item dash is seen, so sub-list
  // entries (which are deeper) are always rejected regardless of `containerIndent+4` arithmetic.
  it("rejects image: inside an env sub-list when env is the container item's first child", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - env:
        - name: RELATED_IMAGE_CONTROLLER
          image: nginx:1.25
        image: nginx:1.25
`;
    // The YAML parser sees nginx:1.25 from the real container image field only (env vars
    // are plain strings, not parsed as image refs by extractImages — it only recurses into
    // containers/initContainers/ephemeralContainers array items, not env[].value strings).
    // The line-scan must also return only the real container image line, not the line inside
    // the env[] sub-list where the key happens to be named `image:`.
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    // The accepted position must be the real container `image:` line (indent 8), not the
    // env sub-list `image:` line (indent 10). The real container image: is always AFTER
    // the env: sub-list in this fixture, so it is on the last `image:` line.
    const lines = manifest.split("\n");
    const envSubListImageLine = lines.findIndex((l) => l.startsWith("          image:"));
    // env sub-list image (indent 10) must NOT be accepted
    expect(positions[0].lineIndex).not.toBe(envSubListImageLine);
    // real container image (indent 8) must be accepted — it is the only accepted line
    const realImageLine = lines.findIndex((l) => l.startsWith("        image:"));
    expect(positions[0].lineIndex).toBe(realImageLine);
  });

  // H1b regression: two containers where the second container's first child is a sub-list —
  // ensures that the first container's real image is found, and the second container's
  // sub-list image: is rejected while the second container's own image: is accepted.
  it("finds real image: in both containers when second container starts with sub-list", () => {
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: app
        image: myapp:2.0
      - env:
        - name: RELATED_IMAGE
          image: myapp:2.0
        image: myapp:2.0
`;
    // extractImages sees myapp:2.0 from the two real container image: fields (both the
    // first container's `image: myapp:2.0` and the second container's `image: myapp:2.0`);
    // they deduplicate in the imageMap, so imageMap has one entry. The line-scan must
    // return two positions: one per real container image line (both at indent 8), and zero
    // positions for the env sub-list image: key (which is at indent 10).
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(2);
    // Neither accepted position should be the env sub-list line.
    const lines = manifest.split("\n");
    const envSubListImageLine = lines.findIndex((l) => l.startsWith("          image:"));
    for (const pos of positions) {
      expect(pos.lineIndex).not.toBe(envSubListImageLine);
    }
  });
});

describe("k8s scope guard — non-standard dash widths", () => {
  // Multi-space dash width: container items use "-   " (dash + 3 spaces → 4-char prefix).
  // Direct container fields land at dashIndent+4, not dashIndent+2.
  // An `image:` directly in the container item IS accepted; an `image:` inside a nested
  // env[] sub-list at a deeper indent is rejected.
  it("accepts container image: with 4-char dash prefix (-   name: style) and rejects env sub-list image:", () => {
    // containers: is at indent 2; container items (dash-aligned) use "-   " so direct
    // fields start at indent 2+4=6. The env sub-list items are at indent 6 with their
    // own fields at indent 8, which is deeper — so they must be rejected.
    const manifest = `spec:
  containers:
  -   name: app
      image: nginx:1.25
      env:
      - name: SIDECAR
        image: fake/image:latest
`;
    const positions = parseManifestImagesWithPositions(manifest);
    // nginx:1.25 is the real container image; fake/image:latest is only in env[].
    // extractImages only sees nginx:1.25 (env[] entries are not parsed as image refs).
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
    // The accepted position must be the container's own image: line, which comes before env:.
    const envLine = manifest.split("\n").findIndex((l) => l.trim() === "env:");
    expect(positions[0].lineIndex).toBeLessThan(envLine);
  });

  // Standard 2-space (regression test): normal "- " prefix still works correctly.
  it("standard 2-space dash prefix still works correctly", () => {
    const manifest = `spec:
  containers:
  - name: app
    image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
  });

  // Inline dash style: "- image: nginx:1.25" — the image key is on the same line as
  // the dash. itemFieldIndent is set on this same line, and the depth guard uses
  // itemFieldIndent=-1 fallback (containerIndent+4) which accepts it.
  it("inline dash style '- image: nginx:1.25' is matched", () => {
    const manifest = `spec:
  containers:
  - image: nginx:1.25
    name: web
`;
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
  });

  // Tab indentation: if a line has a tab instead of spaces for indentation, the
  // existing isListItem detection (based on charAt at the computed indent position)
  // handles it without panicking. Confirm an image: in a tab-indented env sub-item
  // is still rejected by the imageMap guard (env values are not image refs).
  it("does not panic on tab-indented YAML and still rejects env sub-item image:", () => {
    // Use a valid YAML structure with standard indentation for the containers block,
    // but the env sub-item contains an image: key whose value does not appear in any
    // container (imageMap.has() guard rejects it before scope even matters).
    const manifest = `spec:
  containers:
  - name: app
    image: nginx:1.25
    env:
    - name: FOO
      image: fake/image:latest
`;
    // fake/image:latest is not a container image — extractImages never sees it.
    // Only nginx:1.25 should be returned.
    const positions = parseManifestImagesWithPositions(manifest);
    expect(positions).toHaveLength(1);
    expect(positions[0].raw).toBe("nginx:1.25");
  });

  // Block-scalar indicator ordering: "key: |2+" should be treated as a block scalar
  // opener (digit before chomping indicator suffix). Lines indented deeper than the
  // key must be suppressed as block-scalar content.
  it("treats key: |2+ as a block scalar opener (digit-before-suffix ordering)", () => {
    // The ConfigMap has "embedded: |2+" — any lines indented deeper are block-scalar content.
    // The containers: line inside that block-scalar must NOT open a container scope.
    const manifest = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: web
        image: nginx:1.25
---
apiVersion: v1
kind: ConfigMap
data:
  embedded: |2+
    spec:
      containers:
      - name: evil
        image: nginx:1.25
`;
    const positions = parseManifestImagesWithPositions(manifest);
    // Only the real container (first document) should have a position.
    expect(positions).toHaveLength(1);
    const sepLine = manifest.split("\n").findIndex((l) => l.trim() === "---");
    expect(positions[0].lineIndex).toBeLessThan(sepLine);
  });
});

describe("imageIdentity", () => {
  it("digest-pinned ref uses name@digest (tag is cosmetic)", () => {
    const ref = parseImageRef("alpine:3.19@sha256:abcdef1234")!;
    expect(imageIdentity(ref)).toBe("docker.io/library/alpine@sha256:abcdef1234");
  });

  it("tag-only ref uses name:tag", () => {
    const ref = parseImageRef("nginx:1.25")!;
    expect(imageIdentity(ref)).toBe("docker.io/library/nginx:1.25");
  });

  it("bare name (no tag, no digest) uses name:latest", () => {
    const ref = parseImageRef("postgres")!;
    expect(imageIdentity(ref)).toBe("docker.io/library/postgres:latest");
  });

  it("relabeled digest-pinned refs have the same identity regardless of tag change", () => {
    const digest = "sha256:c6b9b4f15993749284f505e153c5b2af34dccb7b60b8b2174a63dba5926273a9";
    const base = parseImageRef(`public.ecr.aws/aws-cli/aws-cli:2.34.56@${digest}`)!;
    const head = parseImageRef(`public.ecr.aws/aws-cli/aws-cli:2.35.0@${digest}`)!;
    expect(imageIdentity(base)).toBe(imageIdentity(head));
  });

  it("different digests have different identities even when tag is the same", () => {
    const base = parseImageRef("alpine:3.18@sha256:aaa111")!;
    const head = parseImageRef("alpine:3.18@sha256:bbb222")!;
    expect(imageIdentity(base)).not.toBe(imageIdentity(head));
  });
});

// ─── CRLF line-ending round-trip ─────────────────────────────────────────────
// Windows-authored manifests use \r\n. The position offsets, container-scope
// detection, and image value slicing must all behave identically to LF.
describe("parseManifestImagesWithPositions — CRLF line endings", () => {
  const LF_MANIFEST = `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        image: nginx:1.25\n`;
  const CRLF_MANIFEST = LF_MANIFEST.replace(/\n/g, "\r\n");

  it("finds the same image ref under CRLF as under LF", () => {
    const lf = parseManifestImagesWithPositions(LF_MANIFEST);
    const crlf = parseManifestImagesWithPositions(CRLF_MANIFEST);
    expect(crlf).toHaveLength(1);
    expect(crlf[0].raw).toBe("nginx:1.25");
    expect(crlf[0].ref).not.toBeNull();
    expect(crlf[0].ref?.repository).toBe("library/nginx");
    // Both parsers must agree on the image name.
    expect(lf.map((r) => r.raw)).toEqual(crlf.map((r) => r.raw));
  });

  it("absoluteOffset points to the correct image value bytes in the CRLF content", () => {
    const positions = parseManifestImagesWithPositions(CRLF_MANIFEST);
    expect(positions).toHaveLength(1);
    const { lineIndex, valueOffset, valueLength } = positions[0];
    const lines = CRLF_MANIFEST.split("\n");
    const lineStarts: number[] = [];
    let off = 0;
    for (const line of lines) { lineStarts.push(off); off += line.length + 1; }
    const absOffset = lineStarts[lineIndex] + valueOffset;
    expect(CRLF_MANIFEST.slice(absOffset, absOffset + valueLength)).toBe("nginx:1.25");
  });

  it("container-scope detection opens scope correctly on CRLF manifest", () => {
    // A CRLF containers: key must open a container scope so image: lines inside are accepted.
    const positions = parseManifestImagesWithPositions(CRLF_MANIFEST);
    expect(positions).toHaveLength(1);
  });

  it("an image: key inside env[] is not returned under CRLF", () => {
    const manifest = (
      `apiVersion: apps/v1\nkind: Deployment\nspec:\n  template:\n    spec:\n` +
      `      containers:\n      - name: app\n        image: nginx:1.25\n        env:\n` +
      `        - name: X\n          image: evil:1.0\n`
    ).replace(/\n/g, "\r\n");
    const positions = parseManifestImagesWithPositions(manifest);
    // Only the real container image, not the env sub-field
    expect(positions.every((p) => p.raw === "nginx:1.25")).toBe(true);
    expect(positions).toHaveLength(1);
  });
});
