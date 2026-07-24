import { type RuleContext } from "@adversarylabs/sdk";
import { domain } from "./domain.js";
import { type Analysis, type RuleDefinition, type Signal } from "./types.js";

const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

export function reviewDomain(ctx: RuleContext, analysis: Analysis): void {
  const active: Array<{ rule: RuleDefinition; signals: Signal[] }> = [];
  for (const rule of domain.rules) {
    const signals = analysis.signals.filter((signal) => signal.ruleId === rule.id);
    if (signals.length === 0) continue;
    active.push({ rule, signals });
    ctx.finding({
      ruleId: rule.id,
      title: rule.title,
      category: rule.category,
      severity: rule.severity,
      confidence: rule.confidence,
      summary: rule.summary(signals.length),
      whyItMatters: rule.whyItMatters,
      impact: rule.impact,
      evidence: signals.slice(0, 12).map((signal) => ({
        location: {
          file: signal.path,
          line: signal.line,
          ...(signal.endLine === undefined ? {} : { endLine: signal.endLine }),
        },
        message: signal.message,
        snippet: signal.snippet,
        data: signal.data,
      })),
      recommendation: rule.recommendation,
      remediation: { complexity: "small" },
    });
  }

  addPositives(ctx, analysis);
  if (active.length === 0) {
    ctx.review.assessment({ risk: "none", summary: domain.noRiskSummary });
    ctx.review.opinion({ ship: true, summary: domain.approvalSummary });
    return;
  }

  const primary = [...active].sort((left, right) =>
    RISK_ORDER[right.rule.severity] - RISK_ORDER[left.rule.severity] ||
    left.rule.id.localeCompare(right.rule.id))[0]!;
  ctx.review.assessment({
    risk: primary.rule.severity,
    summary: `${primary.rule.title}. ${primary.rule.impact}`,
  });
  ctx.review.opinion({
    ship: primary.rule.severity === "low",
    summary: primary.rule.severity === "low"
      ? `I would merge this change and address ${primary.rule.title.toLowerCase()} as follow-up hardening.`
      : `I would address ${primary.rule.title.toLowerCase()} before merging.`,
  });
}

function addPositives(ctx: RuleContext, analysis: Analysis): void {
  const byKey = new Map<string, typeof analysis.positives>();
  for (const item of analysis.positives) {
    const existing = byKey.get(item.key) ?? [];
    existing.push(item);
    byKey.set(item.key, existing);
  }
  for (const [key, items] of [...byKey].sort(([left], [right]) => left.localeCompare(right))) {
    ctx.review.positive({
      key,
      summary: items.length === 1 ? items[0]!.summary : `${items.length} reviewed locations: ${items[0]!.summary}`,
      evidence: items.slice(0, 8).map((item) => ({
        location: { file: item.path, line: item.line },
        message: item.summary,
      })),
    });
  }
}
