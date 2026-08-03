import type { RuleContext } from "@adversarylabs/sdk";
import { domain } from "./domain.js";
import { type Discovery, type SourceRevision } from "./types.js";

const MAX_FILE_BYTES = 750_000;
const MAX_FILES = 750;

/**
 * Load Go sources for the runner's review scope.
 *
 * Scope ownership lives in the CLI/SDK (`change.changedFiles` includes untracked
 * worktree paths; `--all-files` walks the target). This adversary only filters
 * to domain-relevant paths — it does not shell out to git.
 */
export async function discoverSources(ctx: RuleContext): Promise<Discovery> {
  const sources = await ctx.loadInScopeSources({
    include: domain.includePath,
    limit: MAX_FILES,
    maxBytes: MAX_FILE_BYTES,
  });

  const wholeTarget = ctx.change === null || ctx.change.scanMode === "all";
  const files: SourceRevision[] = sources.map((source) => ({
    path: source.path,
    current: source.content,
    // Full-file eligibility: platform already scoped the change; do not re-diff.
    changedLines: new Set<number>(),
    status: source.status === "repository" ? "repository" : "added",
  }));

  return {
    mode: wholeTarget ? "repository" : "diff",
    ...(ctx.change?.baseRef === undefined ? {} : { base: ctx.change.baseRef }),
    files,
  };
}
