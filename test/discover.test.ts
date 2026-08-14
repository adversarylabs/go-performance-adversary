import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadInScopeSources, type RuleContext } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "../src/analyze.ts";
import { discoverSources } from "../src/discover.ts";
import { createApp } from "../src/index.ts";

const execute = promisify(execFile);
const ruleId = "go-perf.cache-element-footprint-claim";
const requestCacheRuleId = "go-perf.request-keyed-cache-amplification";

test("an unrelated edit does not surface a legacy cache footprint claim", async () => {
  const repo = await repositoryWithLegacyClaim();
  const path = "cache.go";
  await writeFile(join(repo, path), cacheSource("new unrelated diagnostic"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "modified");
  assert.deepEqual([...discovery.files[0]!.changedLines], [7]);

  const analysis = await analyzeDiscovery(discovery);
  assert.deepEqual(analysis.signals.filter((signal) => signal.ruleId === ruleId), []);

  const review = await changedReview(repo, [path]);
  assert.deepEqual(review.findings.filter((finding) => finding.ruleId === ruleId), []);
});

test("an added Go file remains eligible in full", async () => {
  const repo = await repositoryWithLegacyClaim();
  const path = "added.go";
  await writeFile(join(repo, path), cacheSource("added file"));

  const discovery = await discoverSources(changedContext(repo, [path]));
  assert.equal(discovery.files[0]?.status, "added");

  const analysis = await analyzeDiscovery(discovery);
  assert.equal(analysis.signals.filter((signal) => signal.ruleId === ruleId).length, 1);

  const review = await changedReview(repo, [path]);
  assert.equal(review.findings.filter((finding) => finding.ruleId === ruleId).length, 1);
});

test("deleting the sole hard bound anchors the newly unsafe surviving miss path", async () => {
  const repo = await mkdtemp(join(tmpdir(), "go-performance-deleted-bound-"));
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  const path = "cache.go";
  const bounded = requestCacheSource(true);
  await writeFile(join(repo, path), bounded);
  await execute("git", ["add", path], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "bounded fixture"], { cwd: repo });
  const unbounded = requestCacheSource(false);
  await writeFile(join(repo, path), unbounded);

  const discovery = await discoverSources(changedContext(repo, [path]));
  const survivingAnchorLine = unbounded.split("\n").findIndex((line) => line.includes("cache[key]; ok")) + 1;
  assert.deepEqual([...discovery.files[0]!.changedLines], [survivingAnchorLine]);
  assert.deepEqual([...discovery.files[0]!.deletionAnchors!], [survivingAnchorLine]);
  const analysis = await analyzeDiscovery(discovery);
  const signal = analysis.signals.find((item) => item.ruleId === requestCacheRuleId);
  assert.equal(signal?.line, survivingAnchorLine);
  assert.equal(signal?.data.anchor, "cache lookup");
});

async function repositoryWithLegacyClaim(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "go-performance-discover-"));
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["config", "user.email", "tests@example.com"], { cwd: repo });
  await execute("git", ["config", "user.name", "Tests"], { cwd: repo });
  await writeFile(join(repo, "cache.go"), cacheSource("old diagnostic"));
  await execute("git", ["add", "cache.go"], { cwd: repo });
  await execute("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repo });
  return repo;
}

function cacheSource(diagnostic: string): string {
  return `package fixture

type Entry struct { Value string }
type Cache struct { Entries []Entry }
// The cache footprint stays unchanged.
func build() {
	println(${JSON.stringify(diagnostic)})
}
`;
}

function requestCacheSource(bounded: boolean): string {
  return `package fixture

import (
	"net/http"
	"os"
)

const maxEntries = 64
var cache = map[string][]byte{}

func handle(req *http.Request) {
	key := req.Header.Get("X-Tenant")
	if _, ok := cache[key]; ok { return }
${bounded ? "\tif len(cache) >= maxEntries { return }\n" : ""}	value, _ := os.ReadFile(key)
	cache[key] = value
}
`;
}

async function changedReview(repoPath: string, changedFiles: string[]) {
  return createApp().run({
    input: {
      source: { path: repoPath },
      change: {
        type: "diff",
        base_ref: "HEAD",
        head_ref: "WORKTREE",
        scan_mode: "changed",
        changed_files: changedFiles,
      },
    },
  });
}

function changedContext(repoPath: string, changedFiles: string[]): RuleContext {
  const change: RuleContext["change"] = {
    type: "diff",
    baseRef: "HEAD",
    headRef: "WORKTREE",
    scanMode: "changed",
    changedFiles,
    worktree: true,
  };
  return {
    repoPath,
    change,
    repoIndex: null,
    summary: {},
    cache: new Map(),
    relpath: (path) => path,
    glob: async () => [],
    rglob: async () => [],
    listInScopePaths: async () => [],
    loadInScopeSources: async (options) => loadInScopeSources(repoPath, change, options),
    model: {} as RuleContext["model"],
    observe: () => {},
    finding: () => {},
    review: {
      assessment: () => {},
      positive: () => {},
      observe: () => {},
      score: () => {},
      opinion: () => {},
    },
  };
}
