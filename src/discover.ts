import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { domain } from "./domain.js";
import { type Discovery, type SourceRevision } from "./types.js";

const execute = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([
  ".git", "build", "dist", "generated", "node_modules", "third_party", "vendor",
]);
const MAX_FILE_BYTES = 750_000;
const MAX_FILES = 750;

export async function discoverSources(repoPath: string): Promise<Discovery> {
  if (!(await isGitRepository(repoPath)) || !(await revisionExists(repoPath, "HEAD"))) {
    return { mode: "repository", files: await readSources(repoPath, await repositoryFiles(repoPath)) };
  }

  const worktree = await gitOutput(repoPath, ["diff", "--name-status", "--find-renames", "HEAD", "--"]);
  if (worktree.trim() !== "") return diffDiscovery(repoPath, "HEAD", worktree);

  const base = await chooseBase(repoPath);
  if (base !== undefined) {
    const names = await gitOutput(repoPath, ["diff", "--name-status", "--find-renames", base, "HEAD", "--"]);
    if (names.trim() !== "") return diffDiscovery(repoPath, base, names);
  }

  const paths = (await gitOutput(repoPath, ["ls-files", "-z"]))
    .split("\0").filter((path) => domain.includePath(path)).slice(0, MAX_FILES);
  return { mode: "repository", files: await readSources(repoPath, paths) };
}

async function diffDiscovery(repoPath: string, base: string, names: string): Promise<Discovery> {
  const records = parseNameStatus(names)
    .filter((record) => record.status !== "D" && domain.includePath(record.path))
    .slice(0, MAX_FILES);
  const files: SourceRevision[] = [];
  for (const record of records) {
    const current = await safeRead(join(repoPath, record.path));
    if (current === undefined) continue;
    files.push({
      path: record.path,
      current,
      changedLines: await changedLineNumbers(repoPath, base, record.path),
      status: record.status === "A" ? "added" : "modified",
    });
  }
  return { mode: "diff", base, files };
}

async function chooseBase(repoPath: string): Promise<string | undefined> {
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (!(await revisionExists(repoPath, candidate))) continue;
    const mergeBase = (await gitOutput(repoPath, ["merge-base", "HEAD", candidate])).trim();
    const head = (await gitOutput(repoPath, ["rev-parse", "HEAD"])).trim();
    if (mergeBase !== "" && mergeBase !== head) return mergeBase;
  }
  return (await revisionExists(repoPath, "HEAD^")) ? "HEAD^" : undefined;
}

async function changedLineNumbers(repoPath: string, base: string, path: string): Promise<Set<number>> {
  const patch = await gitOutput(repoPath, ["diff", "--unified=0", base, "--", path]);
  const lines = new Set<number>();
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line += 1) lines.add(line);
  }
  return lines;
}

async function repositoryFiles(repoPath: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    if (result.length >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= MAX_FILES || entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolute);
      } else {
        const path = relative(repoPath, absolute).split(sep).join("/");
        if (domain.includePath(path)) result.push(path);
      }
    }
  }
  await walk(repoPath);
  return result;
}

async function readSources(repoPath: string, paths: string[]): Promise<SourceRevision[]> {
  const files: SourceRevision[] = [];
  for (const path of paths) {
    const current = await safeRead(join(repoPath, path));
    if (current !== undefined) files.push({ path, current, changedLines: new Set(), status: "repository" });
  }
  return files;
}

async function safeRead(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path);
    if (content.byteLength > MAX_FILE_BYTES || content.includes(0)) return undefined;
    return content.toString("utf8");
  } catch {
    return undefined;
  }
}

async function revisionExists(repoPath: string, revision: string): Promise<boolean> {
  try {
    await execute("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", revision]);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    return (await gitOutput(repoPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function parseNameStatus(output: string): Array<{ status: string; path: string }> {
  return output.split("\n").filter(Boolean).map((line) => {
    const fields = line.split("\t");
    const status = fields[0]?.slice(0, 1) ?? "";
    return { status, path: (status === "R" || status === "C" ? fields[2] : fields[1]) ?? "" };
  });
}
