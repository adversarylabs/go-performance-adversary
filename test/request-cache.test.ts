import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { type SourceRevision } from "../src/types.ts";

const ruleId = "go-perf.request-keyed-cache-amplification";

test("detects the exact Grafana preview-cookie cache amplification shape", async () => {
  const analysis = await analyzeDiscovery({
    mode: "diff",
    base: "main",
    files: grafanaPreFix("added"),
  });
  const finding = analysis.signals.find((signal) => signal.ruleId === ruleId);
  assert.ok(finding);
  assert.equal(finding.data.ttlIsNotCardinalityBound, true);
  assert.equal(finding.data.sharedLinearScanUnderLock, true);
  assert.match(finding.message, /ReadWebAssetsFromCDN/);
});

test("stays quiet for Grafana's bounded LRU fix", async () => {
  const files = grafanaPreFix("added").map((file) =>
    file.path.endsWith("preview.go")
      ? revision(file.path, file.current
        .replace("previewCache = map[string]cachedPreviewAssets{}", "previewCache = expirable.NewLRU[string, cachedPreviewAssets](64, nil, previewCacheTTL)")
        .replace(/previewCacheMu\.Lock\(\)[\s\S]*?previewCacheMu\.Unlock\(\)/g, "")
        .replace("cached, ok := previewCache[assetsURL]", "cached, ok := previewCache.Get(assetsURL)")
        .replace("previewCache[assetsURL] = entry", "previewCache.Add(assetsURL, entry)"))
      : file,
  );
  const analysis = await analyzeDiscovery({ mode: "diff", base: "main", files });
  assert.equal(analysis.signals.some((signal) => signal.ruleId === ruleId), false);
});

test("TTL cleanup alone does not prove a cardinality bound", async () => {
  const analysis = await analyzeDiscovery({ mode: "repository", files: grafanaPreFix("repository") });
  assert.equal(analysis.signals.some((signal) => signal.ruleId === ruleId), true);
});

test("requires a persistent cache, a proven lookup, and material key-dependent miss work", async () => {
  const cases = [
    `package p
import "net/http"
func handle(req *http.Request) {
  cache := map[string][]byte{}
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; !ok { cache[key] = os.ReadFile(key) }
}`,
    `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.URL.Query().Get("tenant")
  value := os.ReadFile(key)
  cache[key] = value
}`,
    `package p
import "net/http"
var cache = map[string]string{}
func handle(req *http.Request) {
  key := req.PathValue("tenant")
  if _, ok := cache[key]; !ok { cache[key] = strings.ToUpper(key) }
}`,
    `package p
type Request struct { Header fakeHeader }
var cache = map[string][]byte{}
func handle(req *Request) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  cache[key] = fetchRemoteFile(key)
}`,
    `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request, client *Client) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  cache[key] = client.Do(key)
}`,
    `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  audit := fetchRemoteFile(key)
  if _, ok := cache[key]; ok { return }
  cache[key] = []byte("constant")
  _ = audit
}`,
    `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  _, _ = cache[key]
  value := fetchRemoteFile(key)
  cache[key] = value
}`,
  ];
  for (const [index, source] of cases.entries()) {
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`case${index}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((signal) => signal.ruleId === ruleId), false, `case ${index}`);
  }
});

test("does not trust a request-controlled variable as a hard cache bound", async () => {
  const source = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request, maxEntries int) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  if len(cache) >= maxEntries { return }
  cache[key] = fetchRemoteFile(key)
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("unproven-bound.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("does not accept a conditional max-entry guard as a global bound", async () => {
  const source = `package p
import "net/http"
const maxEntries = 64
var cache = map[string][]byte{}
func handle(req *http.Request, enforce bool) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  if enforce {
    if len(cache) >= maxEntries { return }
  }
  cache[key] = fetchRemoteFile(key)
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("conditional-bound.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("does not treat comments or string literals as request/cache proof", async () => {
  const source = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := "req.Header.Get(\\\"X-Tenant\\\")"
  // pretend := req.URL.Query().Get("tenant")
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("noncode.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);
});

test("does not inherit request provenance through a shadowing callback parameter", async () => {
  const source = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  run(func(req *fakeRequest) {
    key := req.Header.Get("X-Tenant")
    if _, ok := cache[key]; ok { return }
    cache[key] = fetchRemoteFile(key)
  })
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("shadow.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);
});

test("recognizes aliased net/http request types and direct header indexing", async () => {
  const source = `package p
import transport "net/http"
var cache = map[string][]byte{}
func handle(req *transport.Request) {
  key := req.Header["X-Tenant"][0]
  if _, ok := cache[key]; ok { return }
  cache[key] = fetchRemoteFile(key)
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("alias.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("binds same-named map fields to the actual receiver type", async () => {
  const source = `package p
import "net/http"
type longLived struct { cache map[string][]byte }
type scratch struct { cache map[string][]byte }
func (s *scratch) handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  if _, ok := s.cache[key]; ok { return }
  s.cache[key] = fetchRemoteFile(key)
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("receiver.go", source, "repository")] });
  const signal = analysis.signals.find((item) => item.ruleId === ruleId);
  assert.ok(signal);
  assert.match(String(signal.data.cacheDeclaration), /receiver\.go:4/);
});

test("accepts explicit entry bounds and fixed allowlists but not unproven admission names", async () => {
  const bounded = baseHeaderCase(`
  if len(cache) >= maxEntries { return }
  value := os.ReadFile(key)
  cache[key] = value`);
  const allowlisted = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Theme")
  switch key { case "light", "dark": default: return }
  if _, ok := cache[key]; ok { return }
  cache[key] = mustReadRemoteFile(key)
}`;
  const admitted = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  if !tenantAdmission.Allow(key) { return }
  if _, ok := cache[key]; ok { return }
  cache[key] = mustReadRemoteFile(key)
}`;
  for (const [index, source] of [bounded, allowlisted].entries()) {
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`safe${index}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((signal) => signal.ruleId === ruleId), false, `safe case ${index}`);
  }
  const unproven = await analyzeDiscovery({
    mode: "repository",
    files: [revision("unproven-admission.go", admitted, "repository")],
  });
  assert.equal(unproven.signals.some((signal) => signal.ruleId === ruleId), true);
});

test("detects receiver caches for cookie, header, query, and path request keys", async () => {
  for (const [name, sourceExpression] of [
    ["cookie", `cookie, _ := req.Cookie("preview")\n  key := cookie.Value`],
    ["header", `key := req.Header.Get("X-Tenant")`],
    ["query", `key := req.URL.Query().Get("tenant")`],
    ["path", `key := req.PathValue("tenant")`],
  ]) {
    const source = `package p
import "net/http"
type service struct { cache map[string][]byte }
func (s *service) handle(req *http.Request) {
  ${sourceExpression}
  if _, ok := s.cache[key]; ok { return }
  value := fetchRemoteFile(key)
  s.cache[key] = value
}`;
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`${name}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((signal) => signal.ruleId === ruleId), true, name);
  }
});

test("diff locality anchors only to changed cache relationships", async () => {
  const files = grafanaPreFix("modified");
  const unrelated = files.map((file) => ({ ...file, changedLines: new Set([1]) }));
  const quiet = await analyzeDiscovery({ mode: "diff", base: "main", files: unrelated });
  assert.equal(quiet.signals.some((signal) => signal.ruleId === ruleId), false);

  const sourceChanged = files.map((file) => ({
    ...file,
    changedLines: new Set(file.path.endsWith("index.go") ? [5] : []),
  }));
  const reported = await analyzeDiscovery({ mode: "diff", base: "main", files: sourceChanged });
  const signal = reported.signals.find((item) => item.ruleId === ruleId);
  assert.ok(signal);
  assert.equal(signal.path, "pkg/services/frontend/index.go");
  assert.equal(signal.line, 5);
});

test("flow-sensitive request taint is killed by reassignment but preserved by deterministic derivation", async () => {
  const reassigned = baseHeaderCase(`
  key = "fixed"
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const derived = baseHeaderCase(`
  key = strings.TrimSpace(key)
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("reassigned.go", reassigned, "repository")] });
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("derived.go", derived, "repository")] });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
});

test("material-result flow kills overwritten and shadowed values but preserves captured values", async () => {
  const overwritten = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  value = []byte("fallback")
  cache[key] = value`, false);
  const shadowed = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  func(value []byte) { cache[key] = value }(nil)`, false);
  const captured = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  func(done bool) { cache[key] = value; _ = done }(true)`, false);
  for (const [name, source, expected] of [
    ["overwritten", overwritten, false],
    ["shadowed", shadowed, false],
    ["captured", captured, true],
  ] as const) {
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`${name}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), expected, name);
  }
});

test("same-line material calls bind to the value actually inserted", async () => {
  const unrelatedResult = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  fallback := fetchRemoteFile("fixed"); unused := fetchRemoteFile(key); cache[key] = fallback; _ = unused`, false);
  const unrelatedDirectCall = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  unused := fetchRemoteFile(key); cache[key] = fetchRemoteFile("fixed"); _ = unused`, false);
  for (const [name, source] of [
    ["unrelated-result", unrelatedResult],
    ["unrelated-direct-call", unrelatedDirectCall],
  ] as const) {
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`${name}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false, name);
  }
});

test("lookup, material work, and insertion must share one request-key lineage", async () => {
  const mismatched = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  lookupKey := req.Header.Get("X-Lookup")
  insertKey := req.Header.Get("X-Insert")
  if _, ok := cache[lookupKey]; ok { return }
  value := fetchRemoteFile(insertKey)
  cache[insertKey] = value
}`;
  const equivalent = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  normalized := strings.TrimSpace(key)
  if _, ok := cache[normalized]; ok { return }
  value := fetchRemoteFile(normalized)
  cache[normalized] = value
}`;
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("different-keys.go", mismatched, "repository")] });
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("same-key.go", equivalent, "repository")] });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
});

test("different deterministic transforms of one request source are not equivalent cache keys", async () => {
  const crossed = baseHeaderCase(`
  lower := strings.ToLower(key)
  upper := strings.ToUpper(key)
  if _, ok := cache[lower]; ok { return }
  value := fetchRemoteFile(upper)
  cache[upper] = value`, false);
  const same = baseHeaderCase(`
  lower := strings.ToLower(key)
  if _, ok := cache[lower]; ok { return }
  value := fetchRemoteFile(lower)
  cache[lower] = value`, false);
  const directCrossed = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  if _, ok := cache[strings.ToLower(req.Header.Get("X-Tenant"))]; ok { return }
  value := fetchRemoteFile(strings.ToUpper(req.Header.Get("X-Tenant")))
  cache[strings.ToUpper(req.Header.Get("X-Tenant"))] = value
}`;
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("crossed-transform.go", crossed, "repository")] });
  const directQuiet = await analyzeDiscovery({ mode: "repository", files: [revision("direct-crossed.go", directCrossed, "repository")] });
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("same-transform.go", same, "repository")] });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(directQuiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
});

test("equivalent deterministic key expressions join across separate assignments", async () => {
  const source = baseHeaderCase(`
  lookupKey := strings.ToLower(key)
  insertKey := strings.ToLower(key)
  if _, ok := cache[lookupKey]; ok { return }
  value := fetchRemoteFile(insertKey)
  cache[insertKey] = value`, false);
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("equivalent-joins.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
  const differentLiteral = source.replace(
    "insertKey := strings.ToLower(key)",
    'insertKey := strings.TrimPrefix(key, "tenant:")',
  ).replace(
    "lookupKey := strings.ToLower(key)",
    'lookupKey := strings.TrimPrefix(key, "org:")',
  );
  const quiet = await analyzeDiscovery({
    mode: "repository",
    files: [revision("literal-sensitive.go", differentLiteral, "repository")],
  });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
});

test("hit escape is structurally bound to the selected cache lookup and key", async () => {
  const unrelated = `package p
import "net/http"
var cache = map[string][]byte{}
var other = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  _, _ = cache[key]
  if _, ok := other[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value
}`;
  const split = baseHeaderCase(`
  _, ok := cache[key]
  if ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const wrapped = baseHeaderCase(`
  _, ok := wrap(cache[key])
  if ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("other-hit.go", unrelated, "repository")] });
  const wrappedQuiet = await analyzeDiscovery({ mode: "repository", files: [revision("wrapped-hit.go", wrapped, "repository")] });
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("split-hit.go", split, "repository")] });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(wrappedQuiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
});

test("recognizes canonical cache-miss branches", async () => {
  const source = baseHeaderCase(`
  if _, ok := cache[key]; !ok {
    value := fetchRemoteFile(key)
    cache[key] = value
  }`, false);
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("miss-branch.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("interprocedural parameter positions prevent crossed request-key identities", async () => {
  const source = `package p
import "net/http"
var cache = map[string][]byte{}
func fill(lookupKey, insertKey string) {
  if _, ok := cache[lookupKey]; ok { return }
  value := fetchRemoteFile(insertKey)
  cache[insertKey] = value
}
func handle(req *http.Request) {
  first := req.Header.Get("X-First")
  second := req.Header.Get("X-Second")
  fill(first, second)
  fill(second, first)
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("crossed.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);
});

test("bounds and admission must dominate expensive miss work", async () => {
  const boundAfter = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  if len(cache) >= maxEntries { return }
  cache[key] = value`, false);
  const admissionAfter = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  if !tenantAdmission.Allow(key) { return }
  cache[key] = value`, false);
  const sameLineBoundAfter = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key); if len(cache) >= maxEntries { return }; cache[key] = value`, false);
  const sameLineAdmissionAfter = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key); if !tenantAdmission.Allow(key) { return }; cache[key] = value`, false);
  for (const [name, source] of [
    ["late-bound", boundAfter],
    ["late-admission", admissionAfter],
    ["same-line-late-bound", sameLineBoundAfter],
    ["same-line-late-admission", sameLineAdmissionAfter],
  ] as const) {
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`${name}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true, name);
  }
});

test("deleting an unrelated sentinel does not prove cache capacity preservation", async () => {
  const source = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  if len(cache) >= maxEntries { delete(cache, "sentinel") }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("sentinel-delete.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
  const unrelatedEviction = source.replace(
    'delete(cache, "sentinel")',
    "other.Evict()",
  );
  const evictionAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("unrelated-eviction.go", unrelatedEviction, "repository")],
  });
  assert.equal(evictionAnalysis.signals.some((item) => item.ruleId === ruleId), true);
  const rangedEviction = source.replace(
    'delete(cache, "sentinel")',
    "for victim := range cache { delete(cache, victim); break }",
  );
  const bounded = await analyzeDiscovery({
    mode: "repository",
    files: [revision("ranged-eviction.go", rangedEviction, "repository")],
  });
  assert.equal(bounded.signals.some((item) => item.ruleId === ruleId), false);
  const conditionalDelete = source.replace(
    'delete(cache, "sentinel")',
    "for victim := range cache { if enabled { delete(cache, victim) }; break }",
  );
  const conditional = await analyzeDiscovery({
    mode: "repository",
    files: [revision("conditional-eviction.go", conditionalDelete, "repository")],
  });
  assert.equal(conditional.signals.some((item) => item.ruleId === ruleId), true);
  const reinserted = rangedEviction.replace(
    "value := fetchRemoteFile(key)",
    'cache["regrown"] = []byte("x")\n  value := fetchRemoteFile(key)',
  );
  const regrown = await analyzeDiscovery({
    mode: "repository",
    files: [revision("regrown-after-eviction.go", reinserted, "repository")],
  });
  assert.equal(regrown.signals.some((item) => item.ruleId === ruleId), true);
  const sideEffected = rangedEviction.replace(
    "value := fetchRemoteFile(key)",
    "refill(cache)\n  value := fetchRemoteFile(key)",
  );
  const sideEffect = await analyzeDiscovery({
    mode: "repository",
    files: [revision("side-effect-after-eviction.go", sideEffected, "repository")],
  });
  assert.equal(sideEffect.signals.some((item) => item.ruleId === ruleId), true);
});

test("allowlist proof never combines cases and default arms from different switches", async () => {
  const source = baseHeaderCase(`
  switch other { case "light", "dark": _ = other }
  switch key { default: return }
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("split-switch.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
  const shadowed = baseHeaderCase(`
  switch key := "fixed"; key { case "light": default: return }
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const shadowedAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("switch-init-shadow.go", shadowed, "repository")],
  });
  assert.equal(shadowedAnalysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("direct guards inside closures dominate work but nested optional guards do not", async () => {
  const direct = baseHeaderCase(`
  func() {
    if _, ok := cache[key]; ok { return }
    if len(cache) >= maxEntries { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }()`, false);
  const nested = direct.replace(
    "if len(cache) >= maxEntries { return }",
    "if enforceLimit { if len(cache) >= maxEntries { return } }",
  );
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("closure-bound.go", direct, "repository")] });
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("nested-bound.go", nested, "repository")] });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
});

test("unproven caller admission names do not suppress shared cache work", async () => {
  const helper = `package p
var cache = map[string][]byte{}
func fill(key string) {
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value
}`;
  const callers = (secondGuard: string) => `package p
import "net/http"
func admitted(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  if !tenantAdmission.Allow(key) { return }
  fill(key)
}
func another(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  ${secondGuard}
  fill(key)
}`;
  const partial = await analyzeDiscovery({
    mode: "repository",
    files: [revision("cache.go", helper, "repository"), revision("partial.go", callers(""), "repository")],
  });
  const complete = await analyzeDiscovery({
    mode: "repository",
    files: [
      revision("cache.go", helper, "repository"),
      revision("complete.go", callers("if !tenantAdmission.Allow(key) { return }"), "repository"),
    ],
  });
  assert.equal(partial.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(complete.signals.some((item) => item.ruleId === ruleId), true);
});

test("allowlist default break or fallthrough does not reject unknown keys", async () => {
  for (const terminal of ["break", "fallthrough"]) {
    const source = baseHeaderCase(`
  switch key { case "light", "dark": default: ${terminal} }
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`allow-${terminal}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true, terminal);
  }
});

test("resolves local aliases to persistent caches and invalidates reassigned aliases", async () => {
  const aliased = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  local := cache
  key := req.Header.Get("X-Tenant")
  if _, ok := local[key]; ok { return }
  value := fetchRemoteFile(key)
  local[key] = value
}`;
  const invalidated = aliased.replace("key :=", "local = map[string][]byte{}\n  key :=");
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("alias.go", aliased, "repository")] });
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("invalidated.go", invalidated, "repository")] });
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
});

test("closure parameters shadow only matching names while captured request values remain traceable", async () => {
  const captured = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  func(value []byte) {
    key := req.URL.Query().Get("tenant")
    if _, ok := cache[key]; ok { return }
    value = fetchRemoteFile(key)
    cache[key] = value
  }(nil)
}`;
  const shadowed = captured.replace("func(value []byte)", "func(value []byte, req *fakeRequest)");
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("captured-request.go", captured, "repository")] });
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("shadowed-request.go", shadowed, "repository")] });
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
});

test("closure parameters stay shadowed after outer request and cache-alias assignments", async () => {
  const requestShadow = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  func(key string) {
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }("fixed")
}`;
  const cacheShadow = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  local := cache
  key := req.Header.Get("X-Tenant")
  func(local map[string][]byte) {
    if _, ok := local[key]; ok { return }
    value := fetchRemoteFile(key)
    local[key] = value
  }(map[string][]byte{})
}`;
  for (const [name, source] of [["request-shadow", requestShadow], ["cache-shadow", cacheShadow]] as const) {
    const analysis = await analyzeDiscovery({ mode: "repository", files: [revision(`${name}.go`, source, "repository")] });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false, name);
  }
});

test("tracks material results assigned to outer values through a branch", async () => {
  const branch = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  var value []byte
  if enabled { value = fetchRemoteFile(key) }
  cache[key] = value`, false);
  const shadowed = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := []byte("fallback")
  if enabled { value := fetchRemoteFile(key); _ = value }
  cache[key] = value`, false);
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("branch-flow.go", branch, "repository")] });
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("branch-shadow.go", shadowed, "repository")] });
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
});

test("material result flow joins conditional overwrites and rejects non-reaching branches", async () => {
  const conditionalOverwrite = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  if useFallback { value = []byte("fallback") }
  cache[key] = value`, false);
  const nonReaching = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := []byte("fallback")
  if enabled {
    value = fetchRemoteFile(key)
    return
  }
  cache[key] = value`, false);
  const unconditionalOverwrite = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  {
    value = []byte("fallback")
  }
  cache[key] = value`, false);
  const reported = await analyzeDiscovery({
    mode: "repository",
    files: [revision("conditional-overwrite.go", conditionalOverwrite, "repository")],
  });
  const quiet = await analyzeDiscovery({
    mode: "repository",
    files: [revision("non-reaching.go", nonReaching, "repository")],
  });
  const overwritten = await analyzeDiscovery({
    mode: "repository",
    files: [revision("unconditional-overwrite.go", unconditionalOverwrite, "repository")],
  });
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(overwritten.signals.some((item) => item.ruleId === ruleId), false);
});

test("maps direct IIFE arguments to closure parameters without tainting ordinary shadows", async () => {
  const iife = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  func(key string) {
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }(req.Header.Get("X-Tenant"))
}`;
  const fixed = iife.replace('req.Header.Get("X-Tenant")', '"fixed"');
  const cacheIife = `package p
import "net/http"
var cache = map[string][]byte{}
func handle(req *http.Request) {
  func(local map[string][]byte, key string) {
    if _, ok := local[key]; ok { return }
    value := fetchRemoteFile(key)
    local[key] = value
  }(cache, req.Header.Get("X-Tenant"))
}`;
  const reported = await analyzeDiscovery({ mode: "repository", files: [revision("iife.go", iife, "repository")] });
  const quiet = await analyzeDiscovery({ mode: "repository", files: [revision("fixed-iife.go", fixed, "repository")] });
  const cacheReported = await analyzeDiscovery({
    mode: "repository",
    files: [revision("cache-iife.go", cacheIife, "repository")],
  });
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
  assert.equal(cacheReported.signals.some((item) => item.ruleId === ruleId), true);
});

test("comment-only trailing-line edits do not make legacy relationships eligible", async () => {
  const current = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value // refreshed wording`, false);
  const previous = current.replace("// refreshed wording", "// old wording");
  const changedLine = current.split("\n").findIndex((line) => line.includes("cache[key] = value")) + 1;
  const file = revision("comment.go", current, "modified");
  file.previous = previous;
  file.changedLines = new Set([changedLine]);
  const analysis = await analyzeDiscovery({ mode: "diff", base: "main", files: [file] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);
});

test("an unrelated changed request source does not anchor a legacy cache relationship", async () => {
  const previous = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const current = previous.replace(
    "key := req.Header.Get(\"X-Tenant\")",
    "other := req.Header.Get(\"X-Other\")\n  _ = other\n  key := req.Header.Get(\"X-Tenant\")",
  );
  const changedLine = current.split("\n").findIndex((line) => line.includes("X-Other")) + 1;
  const file = revision("unrelated-source.go", current, "modified");
  file.previous = previous;
  file.changedLines = new Set([changedLine]);
  const analysis = await analyzeDiscovery({ mode: "diff", base: "main", files: [file] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);
});

test("multiline insertion locality anchors the changed key continuation", async () => {
  const current = baseHeaderCase(`
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[
    key
  ] = value`, false);
  const previous = current.replace("    key\n  ] = value", '    "fixed"\n  ] = value');
  const changedLine = current.split("\n").findIndex((line) => line.trim() === "key") + 1;
  const file = revision("multiline.go", current, "modified");
  file.previous = previous;
  file.changedLines = new Set([changedLine]);
  const analysis = await analyzeDiscovery({ mode: "diff", base: "main", files: [file] });
  const signal = analysis.signals.find((item) => item.ruleId === ruleId);
  assert.equal(signal?.line, changedLine);
  assert.equal(signal?.snippet, "key");
});

test("tracks var bindings and respects block, range, and select shadowing", async () => {
  const positiveBodies = [
    `var requestKey = req.Header.Get("X-Tenant")
  if _, ok := cache[requestKey]; ok { return }
  value := fetchRemoteFile(requestKey)
  cache[requestKey] = value`,
    `if _, ok := cache[key]; ok { return }
  var value = fetchRemoteFile(key)
  cache[key] = value`,
    `var local = cache
  if _, ok := local[key]; ok { return }
  value := fetchRemoteFile(key)
  local[key] = value`,
  ];
  for (const [index, body] of positiveBodies.entries()) {
    const analysis = await analyzeDiscovery({
      mode: "repository",
      files: [revision(`var-positive-${index}.go`, baseHeaderCase(body, false), "repository")],
    });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true, `positive ${index}`);
  }

  const quietBodies = [
    `{
    var key = "fixed"
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }`,
    `{
    var cache = map[string][]byte{}
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }`,
    `for _, key := range []string{"light", "dark"} {
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }`,
    `ch := make(chan string)
  select { case key := <-ch:
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  default: }`,
  ];
  for (const [index, body] of quietBodies.entries()) {
    const analysis = await analyzeDiscovery({
      mode: "repository",
      files: [revision(`shadow-quiet-${index}.go`, baseHeaderCase(body, false), "repository")],
    });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false, `quiet ${index}`);
  }
});

test("joins conditional request taint and ignores material work in an uninvoked closure", async () => {
  const conditional = baseHeaderCase(`if enabled { key = req.Header.Get("X-Tenant") }
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false).replace('key := req.Header.Get("X-Tenant")', 'key := "fixed"');
  const closure = baseHeaderCase(`if _, ok := cache[key]; ok { return }
  cache[key] = func() []byte { return fetchRemoteFile(key) }`, false)
    .replace("map[string][]byte{}", "map[string]func() []byte{}");
  const reported = await analyzeDiscovery({
    mode: "repository",
    files: [revision("conditional-taint.go", conditional, "repository")],
  });
  const quiet = await analyzeDiscovery({
    mode: "repository",
    files: [revision("stored-closure.go", closure, "repository")],
  });
  assert.equal(reported.signals.some((item) => item.ruleId === ruleId), true);
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);
});

test("merges exhaustive branch values and still analyzes invoked callbacks", async () => {
  const bothKeysCleared = baseHeaderCase(`if enabled { key = "light" } else { key = "dark" }
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const oneKeyTainted = baseHeaderCase(`if enabled { key = req.Header.Get("X-Other") } else { key = "dark" }
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false).replace('key := req.Header.Get("X-Tenant")', 'key := "fixed"');
  const bothResultsCleared = baseHeaderCase(`if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  if enabled { value = []byte("a") } else { value = []byte("b") }
  cache[key] = value`, false);
  const callback = baseHeaderCase(`func() {
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }()`, false);
  for (const [name, source, expected] of [
    ["all-key-paths-cleared", bothKeysCleared, false],
    ["one-key-path-tainted", oneKeyTainted, true],
    ["all-result-paths-cleared", bothResultsCleared, false],
    ["invoked-callback", callback, true],
  ] as const) {
    const analysis = await analyzeDiscovery({
      mode: "repository",
      files: [revision(`${name}.go`, source, "repository")],
    });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), expected, name);
  }
});

test("accepts Go integer bounds and loop-continue guards", async () => {
  const sources = [
    baseHeaderCase(`if _, ok := cache[key]; ok { return }
  if len(cache) >= 0x40 { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false),
    baseHeaderCase(`if _, ok := cache[key]; ok { return }
  if len(cache) >= maxHex { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false).replace("const maxEntries = 64", "const maxEntries = 64\nconst maxHex = 0x40"),
    baseHeaderCase(`if _, ok := cache[key]; ok { return }
  if len(cache) >= maxBinary { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false).replace("const maxEntries = 64", "const maxEntries = 64\nconst maxBinary uint64 = 0b1_000_000"),
    baseHeaderCase(`for {
    if _, ok := cache[key]; !ok {
      if len(cache) >= maxEntries { continue }
      value := fetchRemoteFile(key)
      cache[key] = value
    }
  }`, false),
  ];
  for (const [index, source] of sources.entries()) {
    const analysis = await analyzeDiscovery({
      mode: "repository",
      files: [revision(`integer-bound-${index}.go`, source, "repository")],
    });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false, `bound ${index}`);
  }
});

test("does not accept an equality-only size check as a hard bound", async () => {
  const source = baseHeaderCase(`if _, ok := cache[key]; ok { return }
  if len(cache) == maxEntries { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const analysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("equality-bound.go", source, "repository")],
  });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("requires the builtin len for a hard cache bound", async () => {
  const source = `package p
import "net/http"
const maxEntries = 64
var cache = map[string][]byte{}
func handle(req *http.Request, len func(map[string][]byte) int) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  if len(cache) >= maxEntries { return }
  value := fetchRemoteFile(key)
  cache[key] = value
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("shadowed-len.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);

  const crossFile = await analyzeDiscovery({
    mode: "repository",
    files: [
      revision("cache.go", baseHeaderCase(`if _, ok := cache[key]; ok { return }
  if len(cache) >= maxEntries { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false), "repository"),
      revision("shadow.go", `package p
func len(map[string][]byte) int { return 100 }`, "repository"),
    ],
  });
  assert.equal(crossFile.signals.some((item) => item.ruleId === ruleId), true);
});

test("keeps type-switch aliases lexical for request keys and cache bindings", async () => {
  const keyShadow = baseHeaderCase(`var candidate any = "fixed"
  switch key := candidate.(type) {
  case string:
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }`, false);
  const cacheShadow = baseHeaderCase(`var candidate any = map[string][]byte{}
  switch cache := candidate.(type) {
  case map[string][]byte:
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }`, false);
  for (const [name, source] of [["key", keyShadow], ["cache", cacheShadow]] as const) {
    const analysis = await analyzeDiscovery({
      mode: "repository",
      files: [revision(`type-switch-${name}.go`, source, "repository")],
    });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false, name);
  }
});

test("analyzes stored closures only when a direct invocation is proven", async () => {
  const body = `work := func() {
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }
  %INVOKE%`;
  for (const [name, invocation, expected] of [
    ["direct", "work()", true],
    ["parenthesized", "((work))()", true],
    ["go", "go work()", true],
    ["defer", "defer work()", true],
    ["uninvoked", "_ = work", false],
    ["conditional", "if enabled { work() }", false],
    ["reassigned", "work = func() {}; work()", false],
  ] as const) {
    const source = baseHeaderCase(body.replace("%INVOKE%", invocation), false);
    const analysis = await analyzeDiscovery({
      mode: "repository",
      files: [revision(`stored-closure-${name}.go`, source, "repository")],
    });
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), expected, name);
  }
  const assigned = baseHeaderCase(`var work func()
  work = func() {
    if _, ok := cache[key]; ok { return }
    value := fetchRemoteFile(key)
    cache[key] = value
  }
  work()`, false);
  const assignedAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("stored-closure-assigned.go", assigned, "repository")],
  });
  assert.equal(assignedAnalysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("invalidates ranged eviction for a known no-arg cache-mutating helper", async () => {
  const source = baseHeaderCase(`if _, ok := cache[key]; ok { return }
  if len(cache) >= maxEntries { for victim := range cache { delete(cache, victim); break } }
  refill()
  value := fetchRemoteFile(key)
  cache[key] = value`, false) + `
func refill() { for i := 0; i < 100; i++ { cache[itoa(i)] = []byte("x") } }`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("refill.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("ignores unreachable miss work and compares changed multiline nodes by position", async () => {
  const unreachable = baseHeaderCase(`if _, ok := cache[key]; ok { return }
  return
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const quiet = await analyzeDiscovery({
    mode: "repository",
    files: [revision("unreachable.go", unreachable, "repository")],
  });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);

  const previous = baseHeaderCase(`if _, ok := cache[
    key
  ]; ok { return }
  value := fetchRemoteFile(key)
  cache[
    "fixed"
  ] = value`, false);
  const current = previous.replace('    "fixed"', "    key");
  const changedLine = current.split("\n").findLastIndex((line) => line.trim() === "key") + 1;
  const file = revision("duplicate-line.go", current, "modified");
  file.previous = previous;
  file.changedLines = new Set([changedLine]);
  const reported = await analyzeDiscovery({ mode: "diff", base: "main", files: [file] });
  assert.equal(reported.signals.find((item) => item.ruleId === ruleId)?.line, changedLine);
});

test("does not treat stored callbacks as executed miss paths", async () => {
  const source = `package p
import (
  "net/http"
  "os"
)
var cache = map[string][]byte{}
var callbacks []func()
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  callbacks = append(callbacks, func() {
    if _, ok := cache[key]; ok { return }
    value, _ := os.ReadFile(key)
    cache[key] = value
  })
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("stored.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);

  const arbitraryDo = source
    .replace("var callbacks []func()", "var registry fakeRegistry")
    .replace("callbacks = append(callbacks, func() {", "registry.Do(\"deferred\", func() {");
  const arbitraryAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("arbitrary-do.go", arbitraryDo, "repository")],
  });
  assert.equal(arbitraryAnalysis.signals.some((item) => item.ruleId === ruleId), false);
});

test("does not report cache work after an unconditional builtin panic", async () => {
  const source = baseHeaderCase(`panic("disabled")
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value`, false);
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("panic.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);

  const shadowed = source.replace("func handle(req *http.Request) {", "func handle(req *http.Request, panic func(any)) {");
  const shadowedAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("shadowed-panic.go", shadowed, "repository")],
  });
  assert.equal(shadowedAnalysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("does not call a receiver cache request-persistent when its receiver is allocated per request", async () => {
  const source = `package p
import (
  "net/http"
  "os"
)
type scratch struct { cache map[string][]byte }
func (s *scratch) fill(key string) {
  if _, ok := s.cache[key]; ok { return }
  value, _ := os.ReadFile(key)
  s.cache[key] = value
}
func handle(req *http.Request) {
  s := &scratch{cache: map[string][]byte{}}
  s.fill(req.Header.Get("X-Tenant"))
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("local-receiver.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);

  const shared = source.replace(
    "func handle(req *http.Request) {\n  s := &scratch{cache: map[string][]byte{}}\n  s.fill(req.Header.Get(\"X-Tenant\"))",
    "func handle(s *scratch, req *http.Request) {\n  { s := &scratch{cache: map[string][]byte{}}; _ = s }\n  s.fill(req.Header.Get(\"X-Tenant\"))",
  );
  const sharedAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("shared-receiver.go", shared, "repository")],
  });
  assert.equal(sharedAnalysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("does not confuse a shadowing parameter with a finite package bound", async () => {
  const source = `package p
import "net/http"
const maxEntries = 64
var cache = map[string][]byte{}
func handle(req *http.Request, maxEntries int) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  if len(cache) >= maxEntries { return }
  value := fetchRemoteFile(key)
  cache[key] = value
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("shadowed-bound.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), true);
});

test("does not infer material backend work from a misleading local helper name", async () => {
  const source = `package p
import "net/http"
var cache = map[string][]byte{}
var embeddedFiles = map[string][]byte{}
func readCachedFile(key string) []byte { return embeddedFiles[key] }
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  value := readCachedFile(key)
  cache[key] = value
}`;
  const analysis = await analyzeDiscovery({ mode: "repository", files: [revision("local-helper.go", source, "repository")] });
  assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false);

  const transitive = `package p
import (
  "net/http"
  "os"
)
var cache = map[string][]byte{}
func helper(key string) []byte { value, _ := os.ReadFile(key); return value }
func fetchRemoteFile(key string) []byte { return helper(key) }
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  if _, ok := cache[key]; ok { return }
  value := fetchRemoteFile(key)
  cache[key] = value
}`;
  const transitiveAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("transitive-helper.go", transitive, "repository")],
  });
  assert.equal(transitiveAnalysis.signals.some((item) => item.ruleId === ruleId), true);

  const plainName = transitive
    .replace("func fetchRemoteFile(key string) []byte { return helper(key) }", "func load(key string) []byte { return helper(key) }")
    .replace("value := fetchRemoteFile(key)", "value := load(key)");
  const plainNameAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("plain-local-helper.go", plainName, "repository")],
  });
  assert.equal(plainNameAnalysis.signals.some((item) => item.ruleId === ruleId), true);

  const cycle = source
    .replace("func readCachedFile(key string) []byte { return embeddedFiles[key] }", [
      "func readCachedFile(key string) []byte { return helper(key) }",
      "func helper(key string) []byte { return readCachedFile(key) }",
    ].join("\n"));
  const cycleAnalysis = await analyzeDiscovery({
    mode: "repository",
    files: [revision("cyclic-helper.go", cycle, "repository")],
  });
  assert.equal(cycleAnalysis.signals.some((item) => item.ruleId === ruleId), false);
});

function baseHeaderCase(body: string, includeLookup = true): string {
  return `package p
import "net/http"
const maxEntries = 64
var cache = map[string][]byte{}
func handle(req *http.Request) {
  key := req.Header.Get("X-Tenant")
  ${includeLookup ? "if _, ok := cache[key]; ok { return }" : ""}
  ${body}
}`;
}

function grafanaPreFix(status: SourceRevision["status"]): SourceRevision[] {
  return [
    revision("pkg/services/frontend/index.go", `package frontend
import "net/http"
func (p *Provider) serve(req *http.Request) {
  if p.previewCfg.Active("default") {
    if cookie, err := req.Cookie("grafana_preview_assets"); err == nil && cookie.Value != "" {
      assets, err := GetPreviewWebAssets(req.Context(), p.previewCfg, cookie.Value)
      _ = assets
      _ = err
    }
  }
}`, status),
    revision("pkg/services/frontend/webassets/preview.go", `package webassets
import (
  "context"
  "golang.org/x/sync/singleflight"
  "sync"
  "time"
)
const previewCacheTTL = 30 * time.Second
var (
  previewCacheMu sync.Mutex
  previewCache = map[string]cachedPreviewAssets{}
  previewFlights singleflight.Group
)
func ResolvePreviewAssetsURL(baseURL, folder string) (string, error) {
  base := baseURL
  return base + folder + "/", nil
}
func GetPreviewWebAssets(ctx context.Context, preview PreviewAssetsConfig, folder string) ([]byte, error) {
  assetsURL, err := ResolvePreviewAssetsURL(preview.BaseURL, folder)
  if err != nil { return nil, err }
  if cached, ok := getCachedPreviewAssets(assetsURL); ok { return cached.assets, nil }
  ch := previewFlights.DoChan(assetsURL, func() (any, error) {
    assets, err := ReadWebAssetsFromCDN(ctx, "build", assetsURL)
    if err != nil { return nil, err }
    entry := cachedPreviewAssets{assets: assets, cachedAt: time.Now()}
    previewCacheMu.Lock()
    previewCache[assetsURL] = entry
    previewCacheMu.Unlock()
    return assets, nil
  })
  result := <-ch
  return result.Val.([]byte), result.Err
}
func getCachedPreviewAssets(assetsURL string) (cachedPreviewAssets, bool) {
  previewCacheMu.Lock()
  defer previewCacheMu.Unlock()
  for key, cached := range previewCache {
    if time.Since(cached.cachedAt) >= previewCacheTTL { delete(previewCache, key) }
  }
  cached, ok := previewCache[assetsURL]
  return cached, ok
}`, status),
  ];
}

function revision(path: string, current: string, status: SourceRevision["status"] = "added"): SourceRevision {
  return {
    path,
    current,
    status,
    changedLines: status === "modified" ? new Set() : new Set(current.split("\n").map((_, index) => index + 1)),
  };
}
