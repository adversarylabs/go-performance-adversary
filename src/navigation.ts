import type { RepoIndex, RuleContext } from "@adversarylabs/sdk";
import type { Analysis } from "./types.js";

export async function attachImportNavigation(
  ctx: RuleContext,
  analysis: Analysis,
): Promise<void> {
  if (ctx.repoIndex === null || ctx.repoIndex === undefined) {
    return;
  }
  const index = ctx.repoIndex;
  const seen = new Set<string>();

  for (const signal of analysis.signals) {
    const importers = await productionImporters(index, signal.path);
    if (importers.length === 0) {
      continue;
    }
    const key = `navigation.importers:${signal.path}:${signal.ruleId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ctx.review.observe({
      key,
      summary: `${signal.ruleId} in ${signal.path} is imported by production package(s): ${importers.slice(0, 8).join(", ")}.`,
      metadata: {
        role: "navigation",
        source: "repo-index",
        signalPath: signal.path,
        ruleId: signal.ruleId,
        importers: importers.slice(0, 20),
      },
      evidence: [
        {
          location: { file: signal.path, line: signal.line },
          message: signal.message,
          data: { importers: importers.slice(0, 12) },
        },
      ],
    });
  }
}

export async function productionImporters(
  index: RepoIndex,
  filePath: string,
): Promise<string[]> {
  const normalized = filePath.replaceAll("\\", "/");
  const packageDir = dirOf(normalized);
  const edges = [
    ...(await index.importersOf(normalized)),
    ...(packageDir ? await index.importersOf(packageDir) : []),
  ];
  const from = new Set<string>();
  for (const edge of edges) {
    if (edge.kind !== "import") {
      continue;
    }
    if (edge.from.endsWith("_test.go") || edge.from.includes("/testdata/")) {
      continue;
    }
    if (edge.from === normalized) {
      continue;
    }
    from.add(edge.from);
  }
  return [...from].sort();
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) {
    return "";
  }
  return path.slice(0, idx);
}
