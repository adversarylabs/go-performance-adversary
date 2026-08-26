import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("the published runtime executes without node_modules", async () => {
  const artifact = await mkdtemp(join(tmpdir(), "go-performance-artifact-"));
  const archiveDirectory = await mkdtemp(join(tmpdir(), "go-performance-archive-"));
  const repository = await mkdtemp(join(tmpdir(), "go-performance-target-"));
  const tarball = join(archiveDirectory, "artifact.tar");
  const entrypoint = join(artifact, "dist", "index.js");
  const input = join(artifact, "input.json");
  const output = join(artifact, "output.json");

  const archive = await execute("git", ["-C", projectRoot, "archive", "--format=tar", "HEAD"], {
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
  });
  await writeFile(tarball, archive.stdout);
  await execute("tar", ["-xf", tarball, "-C", artifact]);

  const inventory = await readdir(artifact, { recursive: true });
  assert.equal(inventory.some((path) => path.split("/").includes("node_modules")), false);
  assert.equal(inventory.some((path) => path.split("/").includes(".git")), false);
  for (const name of [
    "adversarylabs-sdk",
    "ajv",
    "fast-deep-equal",
    "fast-uri",
    "json-schema-traverse",
    "tree-sitter-go",
    "web-tree-sitter",
    "yaml",
  ]) {
    assert.match(await readFile(join(artifact, "licenses", `${name}.txt`), "utf8"), /copyright|license/i);
  }
  await writeFile(join(repository, "main.go"), "package sample\n\nfunc ready() bool { return true }\n");
  await writeFile(input, `${JSON.stringify({ source: { path: repository } })}\n`);

  const bundle = await readFile(entrypoint, "utf8");
  assert.doesNotMatch(bundle, /from\s+["'](?:@adversarylabs\/sdk|web-tree-sitter)["']/);
  assert.doesNotMatch(bundle, /\/Users\/|\/private\/tmp\//);

  await execute(process.execPath, [entrypoint], {
    cwd: artifact,
    env: {
      ...process.env,
      ADVERSARY_INPUT: input,
      ADVERSARY_OUTPUT: output,
      ADVERSARY_REPO: repository,
    },
  });

  const envelope = JSON.parse(await readFile(output, "utf8"));
  assert.equal(envelope.protocolVersion, 1);
  assert.equal(envelope.result.adversary.name, "go/performance");
  assert.equal(envelope.result.adversary.version, "0.0.10");
  assert.deepEqual(envelope.result.findings, []);
});
