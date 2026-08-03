#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Adversary } from "@adversarylabs/sdk";
import { analyzeDiscovery } from "./analyze.js";
import { discoverSources } from "./discover.js";
import { domain } from "./domain.js";
import { reviewDomain } from "./review.js";

export function createApp(): Adversary {
  const app = new Adversary({
    name: domain.name,
    version: "0.0.2",
    review: { maximumFindings: 8, minimumConfidence: "medium" },
  });

  app.rule(`${domain.name}.review`, async (ctx) => {
    const discovery = await discoverSources(ctx);
    const analysis = await analyzeDiscovery(discovery);
    ctx.summary.files_scanned = analysis.filesScanned;
    ctx.review.observe({
      key: domain.observationKey,
      summary: analysis.mode === "diff"
        ? `Prepared ${analysis.filesScanned} changed ${domain.sourceDescription} files against ${analysis.base}.`
        : `Prepared ${analysis.filesScanned} ${domain.sourceDescription} files in repository review mode.`,
      metadata: { parser: "tree-sitter-go", mode: analysis.mode, parseErrors: analysis.parseErrors },
    });
    await reviewDomain(ctx, analysis);
  });
  return app;
}

async function runIfDirect(): Promise<void> {
  if (
    process.argv[1] !== undefined &&
    (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)))
  ) {
    await createApp().runFromEnvironment();
  }
}

void runIfDirect();
