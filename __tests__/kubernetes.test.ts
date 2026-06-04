import { describe, it, expect } from "vitest";
import { parseImageRef } from "../src/ecosystems/image.js";
import { parseManifestImages } from "../src/ecosystems/kubernetes.js";

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

  it("treats @non-digest suffix (no colon) as mutable — digest remains null", () => {
    // "nginx@latest" is a user typo; '@' without algorithm:hex is not a real digest
    const ref = parseImageRef("nginx@latest")!;
    expect(ref.digest).toBeNull();
    // The '@latest' stays in the repository name — the ref is malformed but
    // fails safe: getPublishDate sees no digest and returns null (unknown).
  });

  it("returns null for an empty string", () => {
    expect(parseImageRef("")).toBeNull();
    expect(parseImageRef("   ")).toBeNull();
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
