import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { environmentProcessInspectionSignals } from "../src/process-inspection.ts";
import { type SourceRevision } from "../src/types.ts";

const ruleId = "go-perf.environment-process-inspection-per-request";

function file(path: string, current: string, previous?: string, changedLines?: number[]): SourceRevision {
  return previous === undefined
    ? { path, current, status: "added", changedLines: new Set(changedLines ?? allLines(current)) }
    : { path, current, previous, status: "modified", changedLines: new Set(changedLines ?? allLines(current)) };
}

function allLines(source: string): number[] {
  return source.split("\n").map((_, index) => index + 1);
}

const middleware = `package endpoints
import "context"

type CallerInfo struct { PID int32; UID uint32 }
type podUIDResolver interface { GetPodUID(pid int32) string }
type workloadRateLimitMiddleware struct { resolver podUIDResolver }

func (m workloadRateLimitMiddleware) resolveRateLimitKey(caller CallerInfo) string {
  if m.resolver != nil {
    if podUID := m.resolver.GetPodUID(caller.PID); podUID != "" { return "pod:" + podUID }
  }
  return "uid"
}

func (m workloadRateLimitMiddleware) Preprocess(ctx context.Context, caller CallerInfo) error {
  _ = m.resolveRateLimitKey(caller)
  return nil
}

func buildWorkloadRateLimitMiddleware() workloadRateLimitMiddleware {
  return workloadRateLimitMiddleware{resolver: newPodUIDResolver()}
}
`;

const vulnerableResolver = `package endpoints
import (
  "context"
  "example.com/containerinfo"
)

type containerInfoPodUIDResolver struct { extractor containerinfo.Extractor }

func (r *containerInfoPodUIDResolver) GetPodUID(pid int32) string {
  id, _ := r.extractor.GetContainerIDByProcess(context.Background(), int(pid))
  return id
}

func newPodUIDResolver() podUIDResolver {
  return &containerInfoPodUIDResolver{}
}
`;

const cachedResolver = `package endpoints
import (
  "context"
  "example.com/containerinfo"
)

type containerInfoPodUIDResolver struct { extractor containerinfo.Extractor }
func (r *containerInfoPodUIDResolver) GetPodUID(pid int32) string {
  id, _ := r.extractor.GetContainerIDByProcess(context.Background(), int(pid))
  return id
}

type cachingPodUIDResolver struct { inner podUIDResolver; cache Cache; ttl Duration }
func (r *cachingPodUIDResolver) GetPodUID(pid int32) string {
  if uid, expiresAt, ok := r.cache.Load(pid); ok && expiresAt.After(now()) { return uid }
  uid := r.inner.GetPodUID(pid)
  r.cache.Store(pid, uid, now().Add(r.ttl))
  return uid
}

func newPodUIDResolver() podUIDResolver {
  return &cachingPodUIDResolver{inner: &containerInfoPodUIDResolver{}}
}
`;

const gatedResolver = `package endpoints
import (
  "context"
  "os"
  "example.com/containerinfo"
)

type containerInfoPodUIDResolver struct { extractor containerinfo.Extractor }
func (r *containerInfoPodUIDResolver) GetPodUID(pid int32) string {
  id, _ := r.extractor.GetContainerIDByProcess(context.Background(), int(pid))
  return id
}

func newPodUIDResolver() podUIDResolver {
  if os.Getenv("KUBERNETES_SERVICE_HOST") == "" { return nil }
  return &containerInfoPodUIDResolver{}
}
`;

test("reports the exact SPIRE-shaped per-RPC process inspection relationship", async () => {
  const signals = await environmentProcessInspectionSignals([
    file("pkg/agent/endpoints/ratelimit.go", middleware),
    file("pkg/agent/endpoints/ratelimit_linux.go", vulnerableResolver),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.ruleId, ruleId);
  assert.match(signals[0]?.message ?? "", /each request/);
  assert.deepEqual(signals[0]?.data, {
    hotPath: "Preprocess",
    resolverMethod: "GetPodUID",
    inspectionOperation: "GetContainerIDByProcess",
    constructor: "newPodUIDResolver",
    semanticFingerprint:
      "pkg/agent/endpoints:endpoints|workloadRateLimitMiddleware|Preprocess|resolveRateLimitKey|containerInfoPodUIDResolver|GetPodUID|GetContainerIDByProcess|newPodUIDResolver|buildWorkloadRateLimitMiddleware",
  });
});

test("accepts construction-time environment gating or a bounded process cache", async () => {
  const lookupEnvGate = gatedResolver.replace(
    "if os.Getenv(\"KUBERNETES_SERVICE_HOST\") == \"\" { return nil }",
    "if _, ok := os.LookupEnv(\"KUBERNETES_SERVICE_HOST\"); !ok { return nil }",
  );
  const namedLookupEnvGate = lookupEnvGate.replace("if _, ok :=", "if value, ok :=").replace("{ return nil }", "{ _ = value; return nil }");
  const directCache = vulnerableResolver
    .replace(
      "type containerInfoPodUIDResolver struct { extractor containerinfo.Extractor }",
      "type containerInfoPodUIDResolver struct { extractor containerinfo.Extractor; cache Cache; ttl Duration }",
    )
    .replace(
      "  id, _ := r.extractor.GetContainerIDByProcess(context.Background(), int(pid))",
      "  if id, expiresAt, ok := r.cache.Load(pid); ok && expiresAt.After(now()) { return id }\n" +
      "  id, _ := r.extractor.GetContainerIDByProcess(context.Background(), int(pid))\n" +
      "  r.cache.Store(pid, id, now().Add(r.ttl))",
    );
  assert.deepEqual(await environmentProcessInspectionSignals([
    file("pkg/agent/endpoints/ratelimit.go", middleware),
    file("pkg/agent/endpoints/ratelimit_linux.go", gatedResolver),
  ]), []);
  assert.deepEqual(await environmentProcessInspectionSignals([
    file("pkg/agent/endpoints/ratelimit.go", middleware),
    file("pkg/agent/endpoints/ratelimit_linux.go", cachedResolver),
  ]), []);
  assert.deepEqual(await environmentProcessInspectionSignals([
    file("pkg/agent/endpoints/ratelimit.go", middleware),
    file("pkg/agent/endpoints/ratelimit_linux.go", lookupEnvGate),
  ]), []);
  assert.deepEqual(await environmentProcessInspectionSignals([
    file("pkg/agent/endpoints/ratelimit.go", middleware),
    file("pkg/agent/endpoints/ratelimit_linux.go", namedLookupEnvGate),
  ]), []);
  assert.deepEqual(await environmentProcessInspectionSignals([
    file("pkg/agent/endpoints/ratelimit.go", middleware),
    file("pkg/agent/endpoints/ratelimit_linux.go", directCache),
  ]), []);
});

test("stays quiet for startup-only inspection, unresolved dispatch, unrelated reads, and dead hot calls", async () => {
  const startupOnly = middleware.replace("_ = m.resolveRateLimitKey(caller)", "_ = caller");
  const unresolved = vulnerableResolver.replace("GetContainerIDByProcess", "Inspect");
  const unrelated = vulnerableResolver.replace("GetPodUID", "ReadConfig");
  const dead = middleware.replace(
    "_ = m.resolveRateLimitKey(caller)",
    "if false { _ = m.resolveRateLimitKey(caller) }",
  );
  const unreachable = middleware.replace(
    "_ = m.resolveRateLimitKey(caller)\n  return nil",
    "return nil\n  _ = m.resolveRateLimitKey(caller)",
  );
  const storedHotCall = middleware.replace(
    "_ = m.resolveRateLimitKey(caller)",
    "work := func() { _ = m.resolveRateLimitKey(caller) }; _ = work",
  );
  const storedInspection = vulnerableResolver.replace(
    "  id, _ := r.extractor.GetContainerIDByProcess(context.Background(), int(pid))\n  return id",
    "  work := func() { _, _ = r.extractor.GetContainerIDByProcess(context.Background(), int(pid)) }; _ = work\n  return \"\"",
  );
  for (const [index, sources] of [
    [file("middleware.go", startupOnly), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", middleware), file("resolver.go", unresolved)],
    [file("middleware.go", middleware.replaceAll("GetPodUID", "ReadConfig")), file("resolver.go", unrelated)],
    [file("middleware.go", dead), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", unreachable), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", storedHotCall), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", middleware), file("resolver.go", storedInspection)],
  ].entries()) {
    assert.deepEqual(await environmentProcessInspectionSignals(sources), [], `quiet ${index}`);
  }
});

test("does not trust shadowed or non-dominating gates and requires an expiring cache", async () => {
  const shadowedGate = gatedResolver.replace(
    "func newPodUIDResolver() podUIDResolver {",
    "func newPodUIDResolver() podUIDResolver {\n  os := fakeOS{}",
  );
  const nestedGate = gatedResolver.replace(
    "if os.Getenv(\"KUBERNETES_SERVICE_HOST\") == \"\" { return nil }",
    "if enabled() { if os.Getenv(\"KUBERNETES_SERVICE_HOST\") == \"\" { return nil } }",
  );
  const conditionalGate = gatedResolver.replace(
    "if os.Getenv(\"KUBERNETES_SERVICE_HOST\") == \"\" { return nil }",
    "if enabled() && os.Getenv(\"KUBERNETES_SERVICE_HOST\") == \"\" { return nil }",
  );
  const unboundedCache = cachedResolver
    .replace("; ttl Duration", "")
    .replace("if uid, expiresAt, ok := r.cache.Load(pid); ok && expiresAt.After(now()) { return uid }", "if uid, ok := r.cache.Load(pid); ok { return uid }")
    .replace("r.cache.Store(pid, uid, now().Add(r.ttl))", "r.cache.Store(pid, uid) // ttl is intentionally absent");

  for (const [index, resolver] of [shadowedGate, nestedGate, conditionalGate, unboundedCache].entries()) {
    const signals = await environmentProcessInspectionSignals([
      file("middleware.go", middleware),
      file("resolver.go", resolver),
    ]);
    assert.equal(signals.length, 1, `unsafe control ${index}`);
  }
});

test("fails closed on unproven process libraries, receiver shadows, and non-RPC preprocessors", async () => {
  const unprovenLibrary = vulnerableResolver.replace("example.com/containerinfo", "example.com/helpers");
  const unprovenField = vulnerableResolver.replace("extractor containerinfo.Extractor", "extractor fake.Extractor");
  const shadowedReceiver = middleware.replace(
    "if m.resolver != nil {",
    "if enabled() { m := fakeMiddleware{}; _ = m.resolver.GetPodUID(caller.PID) }\n  if m.resolver != nil {",
  ).replace("if podUID := m.resolver.GetPodUID(caller.PID); podUID != \"\" { return \"pod:\" + podUID }", "return \"pod:disabled\"");
  const nonRPC = middleware.replace("import \"context\"", "import \"example.com/context\"");
  const unusedConstructor = middleware.replace("newPodUIDResolver()", "safeResolver()");
  const shadowedConstructor = middleware.replace(
    "func buildWorkloadRateLimitMiddleware() workloadRateLimitMiddleware {",
    "func buildWorkloadRateLimitMiddleware() workloadRateLimitMiddleware {\n  newPodUIDResolver := safeResolver",
  );
  for (const [index, sources] of [
    [file("middleware.go", middleware), file("resolver.go", unprovenLibrary)],
    [file("middleware.go", middleware), file("resolver.go", unprovenField)],
    [file("middleware.go", shadowedReceiver), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", nonRPC), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", unusedConstructor), file("resolver.go", vulnerableResolver)],
    [file("middleware.go", shadowedConstructor), file("resolver.go", vulnerableResolver)],
  ].entries()) {
    assert.deepEqual(await environmentProcessInspectionSignals(sources), [], `unproven ${index}`);
  }
});

test("requires a changed semantic relationship and anchors gate or cache removal", async () => {
  const unrelatedEdit = middleware.replace("return nil", "return nil // docs");
  const quiet = await environmentProcessInspectionSignals([
    file("middleware.go", unrelatedEdit, middleware, [18]),
    { path: "resolver.go", current: vulnerableResolver, status: "repository", changedLines: new Set() },
  ]);
  assert.deepEqual(quiet, []);

  const gateLine = vulnerableResolver.split("\n").findIndex((line) => line.includes("func newPodUIDResolver")) + 1;
  const activated = await environmentProcessInspectionSignals([
    { path: "middleware.go", current: middleware, status: "repository", changedLines: new Set() },
    {
      path: "resolver.go",
      current: vulnerableResolver,
      previous: gatedResolver,
      status: "modified",
      changedLines: new Set([gateLine]),
      deletionAnchors: new Set([gateLine + 1]),
    },
  ]);
  assert.equal(activated.length, 1);
  assert.equal(activated[0]?.path, "resolver.go");

  const cacheLine = vulnerableResolver.split("\n").findIndex((line) => line.includes("func newPodUIDResolver")) + 1;
  const cacheRemoved = await environmentProcessInspectionSignals([
    { path: "middleware.go", current: middleware, status: "repository", changedLines: new Set() },
    {
      path: "resolver.go",
      current: vulnerableResolver,
      previous: cachedResolver,
      status: "modified",
      changedLines: new Set([cacheLine]),
      deletionAnchors: new Set([cacheLine + 1]),
    },
  ]);
  assert.equal(cacheRemoved.length, 1);
});

test("process inspection signals flow through discovery analysis", async () => {
  const analysis = await analyzeDiscovery({
    mode: "repository",
    files: [
      { path: "middleware.go", current: middleware, status: "repository", changedLines: new Set() },
      { path: "resolver.go", current: vulnerableResolver, status: "repository", changedLines: new Set() },
    ],
  });
  assert.equal(analysis.signals.filter((signal) => signal.ruleId === ruleId).length, 1);
});
