import { contentSignal, lineSignals, positive } from "./signals.js";
import { type DomainDefinition } from "./types.js";

export const domain: DomainDefinition = {
  name: "go-performance",
  displayName: "Go Performance",
  observationKey: "go-performance.analysis",
  sourceDescription: "performance-relevant Go",
  includePath: (path) => path.endsWith(".go") && !path.endsWith("_test.go"),
  rules: [
    {
      id: "go-performance.compile-in-loop",
      title: "A regular expression is compiled inside a loop",
      category: "performance",
      severity: "high",
      confidence: "high",
      summary: (count) => `${count} hot loop${count === 1 ? "" : "s"} repeatedly compile an invariant regular expression.`,
      whyItMatters: "Regular-expression compilation allocates and performs parsing work independent of the loop item.",
      impact: "CPU and allocation cost scale directly with item count on the affected path.",
      recommendation: "Compile the expression once outside the loop or at package initialization and reuse it.",
    },
    {
      id: "go-performance.string-copy",
      title: "A hot loop performs a redundant byte/string round trip",
      category: "performance",
      severity: "medium",
      confidence: "high",
      summary: (count) => `${count} loop conversion${count === 1 ? "" : "s"} copy data from string to bytes and back.`,
      whyItMatters: "The round trip allocates and copies the same contents without changing representation semantics.",
      impact: "Allocation volume and garbage collection grow with loop iterations and payload size.",
      recommendation: "Keep one representation through the loop and convert only at the API boundary that requires it.",
    },
    {
      id: "go-performance.unbounded-retention",
      title: "A long-lived map grows without a visible bound",
      category: "performance",
      severity: "medium",
      confidence: "medium",
      summary: (count) => `${count} package-level map${count === 1 ? "" : "s"} retain entries without capacity or eviction ownership.`,
      whyItMatters: "Long-lived maps keep both keys and values reachable for the process lifetime.",
      impact: "Memory grows with workload cardinality and cannot be reclaimed.",
      recommendation: "Define an ownership bound, eviction policy, or lifecycle reset and expose its operational limit.",
    },
  ],
  noRiskSummary: "No material allocation, repeated compilation, or unbounded-retention risk was found in the reviewed hot-path evidence.",
  approvalSummary: "I would approve the performance characteristics evidenced by the reviewed change.",
  analyze(file) {
    return {
      signals: [
        ...contentSignal(
          file,
          "go-performance.compile-in-loop",
          /for\b[\s\S]{0,240}?regexp\.(?:Compile|MustCompile)\s*\(/,
          "This loop compiles a regular expression on its iteration path.",
        ),
        ...contentSignal(
          file,
          "go-performance.string-copy",
          /for\b[\s\S]{0,240}?string\s*\(\s*\[\]byte\s*\(/,
          "This loop converts a string to bytes and immediately back to string.",
        ),
        ...lineSignals(
          file,
          "go-performance.unbounded-retention",
          /^\s*var\s+\w+\s*=\s*make\s*\(\s*map\[/,
          () => "This package-level map has process lifetime and no visible capacity policy.",
        ),
      ],
      positives: [
        ...positive(file, "go-performance-capacity-owned", /make\s*\(\s*\[\][^,]+,\s*0\s*,\s*\w+/, "Slice growth is preallocated from a known work bound."),
      ],
    };
  },
};
