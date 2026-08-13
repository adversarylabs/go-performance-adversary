export interface SourceRevision {
  path: string;
  current: string;
  previous?: string;
  changedLines: Set<number>;
  status: "added" | "modified" | "repository";
}

export interface Discovery {
  mode: "diff" | "repository";
  base?: string;
  files: SourceRevision[];
}

export interface Signal {
  ruleId: string;
  path: string;
  line: number;
  endLine?: number;
  message: string;
  snippet: string;
  data: Record<string, unknown>;
}

export interface PositiveSignal {
  key: string;
  path: string;
  line: number;
  summary: string;
}

export interface RuleDefinition {
  id: string;
  title: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  confidence: "medium" | "high";
  summary: (count: number) => string;
  whyItMatters: string;
  impact: string;
  recommendation: string;
}

export interface DomainDefinition {
  name: string;
  displayName: string;
  observationKey: string;
  sourceDescription: string;
  rules: RuleDefinition[];
  noRiskSummary: string;
  approvalSummary: string;
  includePath: (path: string) => boolean;
  analyze: (file: SourceRevision) => {
    signals: Signal[];
    positives: PositiveSignal[];
  };
}

export interface Analysis {
  mode: Discovery["mode"];
  base?: string;
  filesScanned: number;
  signals: Signal[];
  positives: PositiveSignal[];
  parseErrors: Array<{ path: string; message: string }>;
}
