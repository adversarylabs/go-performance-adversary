import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the benchmark corpus contains 50-100 unique calibration repositories", async () => {
  const corpus = JSON.parse(await readFile(new URL("../benchmarks/corpus.json", import.meta.url), "utf8")) as {
    schemaVersion: number;
    verifiedAt: string;
    repositories: Array<{ repository: string; defaultBranch: string; focus: string[] }>;
  };
  assert.equal(corpus.schemaVersion, 1);
  assert.match(corpus.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(corpus.repositories.length >= 50 && corpus.repositories.length <= 100);
  assert.equal(new Set(corpus.repositories.map((item) => item.repository)).size, corpus.repositories.length);
  for (const item of corpus.repositories) {
    assert.match(item.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.notEqual(item.defaultBranch, "");
    assert.ok(item.focus.length >= 2);
  }
});

