import assert from "node:assert/strict";
import test from "node:test";
import { analyzeDiscovery } from "../src/analyze.ts";
import { type SourceRevision } from "../src/types.ts";

const ruleId = "go-perf.string-concat-loop";

test("detects string accumulators that survive unbounded loop iterations", async () => {
  const cases = [
    `package p
func join(items []string) string {
  var out string
  for _, item := range items {
    out += item
  }
  return out
}`,
    `package p
var shared string
func join(items []string) string {
  for _, item := range items { shared += item }
  return shared
}`,
    `package p
func many(values [100]string) string {
  var out string
  for i := 0; i < 100; i++ { out += values[i] }
  return out
}`,
    `package p
func join(groups [][]string) string {
  out := ""
  for _, group := range groups {
    for _, item := range group {
      out = out + item
    }
  }
  return out
}`,
    `package p
func join(items []string) string {
  var result string
  for _, item := range items {
    result = (result +
      "{") + item // braces are data, not loop syntax
  }
  return result
}`,
  ];

  for (const [index, source] of cases.entries()) {
    const analysis = await analyze(source, "repository");
    const signals = analysis.signals.filter((item) => item.ruleId === ruleId);
    assert.equal(signals.length, 1, `positive ${index}`);
    assert.match(signals[0]!.message, /grows across iterations/);
  }
});

test("ignores temporary concatenation, per-iteration values, numeric sums, and small fixed loops", async () => {
  const cases = [
    `package p
import "strings"
func has(items []string, want string) bool {
  for _, item := range items {
    if strings.HasPrefix(want, "prefix-"+item) { return true }
  }
  return false
}`,
    `package p
func labels(items []string) {
  for _, item := range items {
    label := "prefix-" + item
    consume(label)
  }
}`,
    `package p
func labels(items []string) {
  var out string
  for _, item := range items {
    out += item
    out = ""
  }
}`,
    `package p
func labels(items []string, enabled bool) {
  var out string
  for _, item := range items {
    if enabled {
      out = ""
      out += item
    }
  }
}`,
    `package p
func labels(items []string) {
  var out string
  for _, item := range items {
    out = ""
    out += item
    consume(out)
  }
}`,
    `package p
func total(values []int) int {
  var total int
  for _, value := range values { total += value }
  return total
}`,
    `package p
func four(values [4]string) string {
  var out string
  for i := 0; i < 4; i++ { out += values[i] }
  return out
}`,
    `package p
func literals() string {
  var out string
  for _, value := range []string{"{", "}"} { out += value }
  return out
}`,
    `package p
func descending(values [8]string) string {
  var out string
  for i := 7; i >= 0; i-- { out += values[i] }
  return out
}`,
    `package p
func highOffset(values [128]string) string {
  var out string
  for i := 100; i > 80; i-- { out += values[i] }
  return out
}`,
    `package p
func rangeInteger() string {
  var out string
  for i := range 8 { out += string(rune('a' + i)) }
  return out
}`,
    `package p
func labels(items []string) {
  for _, item := range items {
    var out string
    out += item
    consume(out)
  }
}`,
    `package p
func comments(items []string) {
  for _, item := range items {
    // pretend { result += item }
    consume("}" + item)
  }
}`,
  ];

  for (const [index, source] of cases.entries()) {
    const analysis = await analyze(source, "repository");
    assert.equal(analysis.signals.some((item) => item.ruleId === ruleId), false, `quiet ${index}`);
  }
});

test("diff mode anchors only a changed accumulator update", async () => {
  const source = `package p
func join(items []string) string {
  var out string
  for _, item := range items {
    temporary := "prefix-" + item
    consume(temporary)
    out += item
  }
  return out
}`;
  const lines = source.split("\n");
  const accumulationLine = lines.findIndex((line) => line.includes("out +=")) + 1;
  const temporaryLine = lines.findIndex((line) => line.includes("temporary :=")) + 1;

  const changed = await analyze(source, "modified", new Set([accumulationLine]));
  const signal = changed.signals.find((item) => item.ruleId === ruleId);
  assert.ok(signal);
  assert.equal(signal.line, accumulationLine);

  const unrelated = await analyze(source, "modified", new Set([temporaryLine]));
  assert.equal(unrelated.signals.some((item) => item.ruleId === ruleId), false);
});

test("diff mode ignores comment-only accumulator edits but reports fixed-bound removal", async () => {
  const previous = `package p
func join(items []string) string {
  var out string
  for i := 0; i < 4; i++ {
    out += items[i] // append item
  }
  return out
}`;
  const commentOnly = previous.replace("// append item", "// documented append");
  const commentLine = commentOnly.split("\n").findIndex((line) => line.includes("out +=")) + 1;
  const quiet = await analyzeDiscovery({
    mode: "diff",
    base: "main",
    files: [{
      path: "concat.go",
      current: commentOnly,
      previous,
      changedLines: new Set([commentLine]),
      status: "modified",
    }],
  });
  assert.equal(quiet.signals.some((item) => item.ruleId === ruleId), false);

  const unbounded = previous.replace("for i := 0; i < 4; i++", "for i := range items");
  const loopLine = unbounded.split("\n").findIndex((line) => line.includes("for i :=")) + 1;
  const activated = await analyzeDiscovery({
    mode: "diff",
    base: "main",
    files: [{
      path: "concat.go",
      current: unbounded,
      previous,
      changedLines: new Set([loopLine]),
      status: "modified",
    }],
  });
  const signal = activated.signals.find((item) => item.ruleId === ruleId);
  assert.ok(signal);
  assert.match(signal.snippet, /out \+= items\[i\]/);
});

async function analyze(current: string, status: SourceRevision["status"], changedLines?: Set<number>) {
  return analyzeDiscovery({
    mode: status === "repository" ? "repository" : "diff",
    ...(status === "repository" ? {} : { base: "main" }),
    files: [{
      path: "concat.go",
      current,
      changedLines: changedLines ?? new Set(current.split("\n").map((_, index) => index + 1)),
      status,
    }],
  });
}
