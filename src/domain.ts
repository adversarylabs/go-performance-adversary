import { contentSignal, positive } from "./signals.js";
import { type DomainDefinition, type Signal, type SourceRevision } from "./types.js";

export const domain: DomainDefinition = {
  // Catalog / package identity uses domain/name taxonomy.
  name: "go/performance",
  displayName: "Go Performance",
  observationKey: "go-performance.analysis",
  sourceDescription: "performance-relevant Go",
  includePath: (path) => path.endsWith(".go") && !path.endsWith("_test.go"),
  rules: [
    {
      id: "go-perf.defer-in-loop",
      title: "defer runs inside a loop body",
      category: "performance",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} loop${count === 1 ? "" : "s"} accumulate deferred calls until the function returns.`,
      whyItMatters:
        "Deferred Close/Unlock pile up for the whole function, not each iteration — classic FD and lock exhaustion.",
      impact: "Large inputs exhaust file descriptors or hold locks across the entire loop.",
      recommendation:
        "Extract the loop body into a function so defers run per iteration, or close explicitly at end of iteration.",
    },
    {
      id: "go-perf.http-client-per-request",
      title: "An HTTP client or transport is built per request",
      category: "performance",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} HTTP client/transport construction${count === 1 ? "" : "s"} sit on a hot path.`,
      whyItMatters:
        "Per-request clients throw away the connection pool; every call pays TCP+TLS and piles up TIME_WAIT.",
      impact: "Port exhaustion and latency spikes under concurrent load.",
      recommendation: "Build one Client (or one Transport) at startup and share it.",
    },
    {
      id: "go-perf.regexp-compile-in-hot-path",
      title: "A regular expression is compiled on a hot path",
      category: "performance",
      severity: "high",
      confidence: "high",
      summary: (count) =>
        `${count} hot path${count === 1 ? "" : "s"} repeatedly compile a regular expression.`,
      whyItMatters: "Compilation is orders of magnitude more expensive than matching.",
      impact: "CPU and allocation cost scale with request or loop volume.",
      recommendation: "Hoist to `var re = regexp.MustCompile(...)` at package scope.",
    },
    {
      id: "go-perf.string-concat-loop",
      title: "A string is built with += inside a loop",
      category: "performance",
      severity: "medium",
      confidence: "high",
      summary: (count) =>
        `${count} loop${count === 1 ? "" : "s"} concatenate strings with quadratic copying.`,
      whyItMatters: "Each += reallocates and copies the whole string — O(n²) on input size.",
      impact: "Fine at 10 items, an outage at millions.",
      recommendation: "Use strings.Builder (with Grow when size is known) or strings.Join.",
    },
    {
      id: "go-perf.large-value-copy",
      title: "A large composite value is copied per range iteration",
      category: "performance",
      severity: "medium",
      confidence: "medium",
      summary: (count) =>
        `${count} range loop${count === 1 ? "" : "s"} copy large struct values per element.`,
      whyItMatters: "Copy cost scales with struct size × iteration count.",
      impact: "Invisible in review, visible in profiles on hot paths.",
      recommendation: "Range over indices (`for i := range xs`) or use pointer elements where ownership allows.",
    },
  ],
  noRiskSummary:
    "No material defer-in-loop, per-request client, repeated compilation, or quadratic string building was found.",
  approvalSummary: "I would approve the performance characteristics evidenced by the reviewed change.",
  analyze(file) {
    return {
      signals: [
        ...deferInLoopSignals(file),
        ...httpClientPerRequestSignals(file),
        ...regexpHotPathSignals(file),
        ...stringConcatLoopSignals(file),
        ...largeValueCopySignals(file),
      ],
      positives: [
        ...positive(
          file,
          "go-perf.capacity-owned",
          /make\s*\(\s*\[\][^,]+,\s*0\s*,\s*\w+/,
          "Slice growth is preallocated from a known work bound.",
        ),
        ...positive(
          file,
          "go-perf.builder",
          /\bstrings\.Builder\b|\bbytes\.Buffer\b/,
          "String building uses a buffered builder.",
        ),
        ...positive(
          file,
          "go-perf.regexp-hoisted",
          /^\s*var\s+\w+\s*=\s*regexp\.MustCompile\s*\(/,
          "Regular expression is compiled once at package scope.",
        ),
      ],
    };
  },
};

function deferInLoopSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const lines = file.current.split("\n");
  // Track for/range loop body via brace depth.
  let loopDepth = 0;
  let braceDepth = 0;
  const loopBraceAt: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    // for / for range starts — count only statement-level for (not "for" in comments roughly).
    if (/^\s*for\b/.test(line) && !trimmed.startsWith("//")) {
      loopDepth += 1;
      loopBraceAt.push(braceDepth);
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;

    if (loopDepth > 0 && /\bdefer\s+/.test(line) && !trimmed.startsWith("//")) {
      signals.push({
        ruleId: "go-perf.defer-in-loop",
        path: file.path,
        line: i + 1,
        message: "defer inside a loop piles up until the function returns, not each iteration.",
        snippet: trimmed.slice(0, 300),
        data: {},
      });
    }

    // Pop loops when brace depth returns to the depth before the loop body opened.
    while (loopDepth > 0 && braceDepth <= (loopBraceAt[loopBraceAt.length - 1] ?? 0) && closes > 0) {
      // Only pop after we've entered the body (braceDepth went up then down).
      // Heuristic: if line closed braces and we're back at or below loop start depth.
      const startDepth = loopBraceAt[loopBraceAt.length - 1] ?? 0;
      if (braceDepth <= startDepth) {
        loopDepth -= 1;
        loopBraceAt.pop();
      } else {
        break;
      }
    }
  }
  return signals;
}

function httpClientPerRequestSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const lines = file.current.split("\n");
  let inHotFunc = false;
  let hotBraceBase = 0;
  let braceDepth = 0;
  let loopDepth = 0;
  const loopBraceAt: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const funcMatch = line.match(
      /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)?\s*\([^)]*\)/,
    );
    if (funcMatch && braceDepth === 0) {
      const name = funcMatch[1] ?? "";
      inHotFunc =
        /^(?:ServeHTTP|Handle|Handler|handle|serve|Serve)$/.test(name) ||
        /Handler$/.test(name);
      hotBraceBase = 0;
    }
    if (/^\s*for\b/.test(line)) {
      loopDepth += 1;
      loopBraceAt.push(braceDepth);
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;

    if (
      (inHotFunc || loopDepth > 0) &&
      /(?:\&)?http\.(?:Client|Transport)\s*\{/.test(line)
    ) {
      signals.push({
        ruleId: "go-perf.http-client-per-request",
        path: file.path,
        line: i + 1,
        message: inHotFunc
          ? "HTTP client/transport is constructed inside a request handler."
          : "HTTP client/transport is constructed inside a loop.",
        snippet: line.trim().slice(0, 300),
        data: {},
      });
    }

    while (loopDepth > 0 && braceDepth <= (loopBraceAt[loopBraceAt.length - 1] ?? 0) && closes > 0) {
      const startDepth = loopBraceAt[loopBraceAt.length - 1] ?? 0;
      if (braceDepth <= startDepth) {
        loopDepth -= 1;
        loopBraceAt.pop();
      } else break;
    }
    if (inHotFunc && braceDepth <= hotBraceBase && closes > 0 && braceDepth === 0) {
      inHotFunc = false;
    }
  }

  // Also flag obvious per-call helpers: Client literal immediately before Do/Get in same short function.
  if (signals.length === 0) {
    signals.push(
      ...contentSignal(
        file,
        "go-perf.http-client-per-request",
        /func\s+\w+\s*\([^)]*\)[^{]*\{[\s\S]{0,200}?\&http\.Client\s*\{[\s\S]{0,200}?\.(?:Do|Get|Post)\s*\(/,
        "HTTP client is constructed in a short helper that performs the request.",
      ),
    );
  }
  return signals;
}

function regexpHotPathSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  // Inside loops.
  signals.push(
    ...contentSignal(
      file,
      "go-perf.regexp-compile-in-hot-path",
      /for\b[\s\S]{0,400}?regexp\.(?:Compile|MustCompile)\s*\(/,
      "This loop compiles a regular expression on its iteration path.",
    ),
  );
  // Inside handlers.
  const lines = file.current.split("\n");
  let inHandler = false;
  let braceDepth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const funcMatch = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)?\s*\(/);
    if (funcMatch && braceDepth === 0) {
      const name = funcMatch[1] ?? "";
      inHandler =
        /^(?:ServeHTTP|Handle)$/.test(name) || /Handler$/.test(name);
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;
    if (inHandler && /regexp\.(?:Compile|MustCompile)\s*\(/.test(line)) {
      // Constant pattern only.
      if (/regexp\.(?:Compile|MustCompile)\s*\(\s*["`]/.test(line) || true) {
        signals.push({
          ruleId: "go-perf.regexp-compile-in-hot-path",
          path: file.path,
          line: i + 1,
          message: "Regular expression is compiled inside a request handler.",
          snippet: line.trim().slice(0, 300),
          data: {},
        });
      }
    }
    if (inHandler && braceDepth === 0 && closes > 0) inHandler = false;
  }
  // Dedup lines
  const seen = new Set<string>();
  return signals.filter((s) => {
    const key = `${s.line}:${s.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringConcatLoopSignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  const lines = file.current.split("\n");
  let loopDepth = 0;
  let braceDepth = 0;
  const loopBraceAt: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*for\b/.test(line)) {
      loopDepth += 1;
      loopBraceAt.push(braceDepth);
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    braceDepth += opens - closes;

    if (loopDepth > 0 && !/^\s*\/\//.test(line) && !/\b(?:append|make)\b/.test(line)) {
      // High-precision string concat only: string literal on the line, or
      // well-known string accumulator names with += / = x + y.
      const stringyAccum =
        /\b(?:out|s|str|text|msg|buf|body|joined|result|acc|builder)\s*(?:\+=|=\s*\w+\s*\+)/.test(
          line,
        ) || /\+=\s*["`]|=\s*\w+\s*\+\s*["`]|\+\s*["`]/.test(line);
      const numericAccum =
        /\b(?:total|sum|count|n|i|idx|index|num|score|len|bytes|size|offset)\s*\+=/.test(line) &&
        !/["`]/.test(line);
      if (stringyAccum && !numericAccum) {
        signals.push({
          ruleId: "go-perf.string-concat-loop",
          path: file.path,
          line: i + 1,
          message: "String concatenation inside a loop reallocates on every iteration.",
          snippet: line.trim().slice(0, 300),
          data: {},
        });
      }
    }

    while (loopDepth > 0 && braceDepth <= (loopBraceAt[loopBraceAt.length - 1] ?? 0) && closes > 0) {
      const startDepth = loopBraceAt[loopBraceAt.length - 1] ?? 0;
      if (braceDepth <= startDepth) {
        loopDepth -= 1;
        loopBraceAt.pop();
      } else break;
    }
  }
  return signals;
}

/**
 * Conservative range-value-copy signal: range over a named large composite type
 * (`for _, v := range xs` where type of elements is a struct with many fields
 * is hard without types). Flag explicit large array/struct range of byte arrays
 * or known large array types, and `for _, v := range` where element type in
 * composite literal is a big struct — also flag ranging copies of `[N]byte` with N>=128.
 */
function largeValueCopySignals(file: SourceRevision): Signal[] {
  const signals: Signal[] = [];
  // for _, v := range something of type [N]byte / [N]int with N large in same file type decl
  const largeArrayTypes = new Set<string>();
  for (const match of file.current.matchAll(
    /\btype\s+([A-Za-z_]\w*)\s+\[(\d+)\](?:byte|uint8|int|int64|float64)\b/g,
  )) {
    const n = Number(match[2]);
    if (n >= 128) largeArrayTypes.add(match[1]!);
  }
  for (const match of file.current.matchAll(
    /\btype\s+([A-Za-z_]\w*)\s+struct\s*\{([^}]{200,})\}/gs,
  )) {
    // Struct body > 200 chars ~ rough large struct
    largeArrayTypes.add(match[1]!);
  }

  file.current.split("\n").forEach((line, index) => {
    const rangeMatch = line.match(/for\s+[^;{]*,\s*([A-Za-z_]\w*)\s*:=\s*range\s+([A-Za-z_]\w*)/);
    if (rangeMatch === null) return;
    // for _, v := range largeSlice where we saw type LargeStruct
    // Without types, flag only when the range target's name suggests copies of big values
    // and there's a known large type used as slice element in same file: var x []Large
    const elemVar = rangeMatch[1];
    const sliceVar = rangeMatch[2];
    if (elemVar === undefined || sliceVar === undefined) return;
    for (const typeName of largeArrayTypes) {
      // File declares []TypeName and this range value-copies from a param/var of that slice type.
      if (
        new RegExp(`\\b${sliceVar}\\s+\\[\\]\\*?${typeName}\\b`).test(file.current) ||
        new RegExp(`\\b${sliceVar}\\s*:?=\\s*.*\\[\\]\\*?${typeName}\\b`).test(file.current)
      ) {
        signals.push({
          ruleId: "go-perf.large-value-copy",
          path: file.path,
          line: index + 1,
          message: `Range value-copies elements of large type ${typeName}.`,
          snippet: line.trim().slice(0, 300),
          data: { type: typeName, element: elemVar },
        });
        return;
      }
    }
    // Explicit: for _, v := range of large fixed-size arrays
    if (/range\s+\w*[^\n]*\[(?:[2-9]\d{2,}|\d{4,})\]/.test(line)) {
      signals.push({
        ruleId: "go-perf.large-value-copy",
        path: file.path,
        line: index + 1,
        message: "Range value-copies large fixed-size array elements.",
        snippet: line.trim().slice(0, 300),
        data: {},
      });
    }
  });
  return signals;
}
