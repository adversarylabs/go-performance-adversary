import { type PositiveSignal, type Signal, type SourceRevision } from "./types.js";

export function lineSignals(
  file: SourceRevision,
  ruleId: string,
  pattern: RegExp,
  message: (match: RegExpMatchArray) => string,
  data: (match: RegExpMatchArray) => Record<string, unknown> = () => ({}),
): Signal[] {
  const signals: Signal[] = [];
  file.current.split("\n").forEach((line, index) => {
    const match = line.match(pattern);
    if (match !== null) {
      signals.push({
        ruleId,
        path: file.path,
        line: index + 1,
        message: message(match),
        snippet: line.trim().slice(0, 300),
        data: data(match),
      });
    }
  });
  return signals;
}

export function positive(
  file: SourceRevision,
  key: string,
  pattern: RegExp,
  summary: string,
): PositiveSignal[] {
  const result: PositiveSignal[] = [];
  file.current.split("\n").forEach((line, index) => {
    if (pattern.test(line)) result.push({ key, path: file.path, line: index + 1, summary });
  });
  return result;
}

export function contentSignal(
  file: SourceRevision,
  ruleId: string,
  pattern: RegExp,
  message: string,
  data: Record<string, unknown> = {},
): Signal[] {
  const match = pattern.exec(file.current);
  if (match?.index === undefined) return [];
  const line = file.current.slice(0, match.index).split("\n").length;
  return [{
    ruleId,
    path: file.path,
    line,
    endLine: line + match[0].split("\n").length - 1,
    message,
    snippet: match[0].trim().slice(0, 300),
    data,
  }];
}
