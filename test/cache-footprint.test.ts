import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { createApp } from "../src/index.ts";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("flags descriptor growth that contradicts a cache-footprint claim", async () => {
  const output = await reviewFixture("vulnerable");
  const finding = output.findings.find(
    (item) => item.ruleId === "go-perf.cache-element-footprint-claim",
  );
  assert.ok(finding);
  assert.equal(finding.evidence.length, 1);
  assert.match(finding.evidence[0]!.message ?? "", /stored as \[\]EndpointAddress/);
});

test("ignores ordinary registries and cache metadata kept in sidecar storage", async () => {
  const output = await reviewFixture("clean");
  assert.equal(
    output.findings.some((item) => item.ruleId === "go-perf.cache-element-footprint-claim"),
    false,
  );
});

test("diff mode reports only the changed descriptor field", async () => {
  const current = `package object

type Endpoints struct {
  Subsets []EndpointSubset
}
type EndpointSubset struct {
  Addresses []EndpointAddress
}
type EndpointAddress struct {
  IP string
  Hostname string
  NodeName string
  TargetRefName string
  Zone string
}

// buildEndpoints retains topology only when zonal behavior is enabled, so the
// default cache stays exactly as slim as before.
func buildEndpoints() {}
`;
  const changedLines = new Set<number>();
  current.split("\n").forEach((line, index) => {
    if (line.includes("Zone string") || line.startsWith("// buildEndpoints") ||
      line.startsWith("// default cache")) {
      changedLines.add(index + 1);
    }
  });

  const analysis = await analyzeDiscovery({
    mode: "diff",
    base: "main",
    files: [{ path: "plugin/kubernetes/object/endpoint.go", current, changedLines, status: "modified" }],
  });

  const signals = analysis.signals.filter(
    (item) => item.ruleId === "go-perf.cache-element-footprint-claim",
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.data.field, "Zone");
});

async function reviewFixture(name: string) {
  return createApp().run({
    input: { source: { path: join(projectRoot, "fixtures", "cache-footprint", name) } },
    includeRawObservations: true,
  });
}
