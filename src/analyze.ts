import { domain } from "./domain.js";
import { descendants, parseGo, sourceText } from "./parser.js";
import { type Analysis, type Discovery, type PositiveSignal, type Signal, type SourceRevision } from "./types.js";
import { type Node } from "web-tree-sitter";

export async function analyzeDiscovery(discovery: Discovery): Promise<Analysis> {
  const signals: Signal[] = [];
  const positives: PositiveSignal[] = [];
  const parseErrors: Analysis["parseErrors"] = [];

  for (const file of discovery.files) {
    try {
      if (file.path.endsWith(".go")) {
        const tree = await parseGo(file.current);
        try {
          if (tree.rootNode.hasError) throw new Error("Go source contains syntax errors");
          signals.push(...cacheElementFootprintSignals(file, tree.rootNode));
        } finally {
          tree.delete();
        }
      }
      const result = domain.analyze(file);
      signals.push(...result.signals.filter((item) => changed(file, item.line, item.endLine)));
      positives.push(...result.positives.filter((item) => changed(file, item.line)));
    } catch (error) {
      parseErrors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    mode: discovery.mode,
    ...(discovery.base === undefined ? {} : { base: discovery.base }),
    filesScanned: discovery.files.length,
    signals: signals.sort(byLocation),
    positives: positives.sort(byLocation),
    parseErrors: parseErrors.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

interface FootprintClaim {
  line: number;
  text: string;
}

function cacheElementFootprintSignals(file: SourceRevision, root: Node): Signal[] {
  const claims = cacheFootprintClaims(file, root);
  if (claims.length === 0) return [];

  const fields = descendants(root, "field_declaration");
  const collectionTypes = new Map<string, string>();
  for (const field of fields) {
    const type = field.childForFieldName("type");
    if (type === null) continue;
    const text = sourceText(type, file.current).replace(/\s+/g, "");
    const slice = text.match(/^\[\]([A-Za-z_]\w*)$/);
    const map = text.match(/^map\[[^\]]+\]([A-Za-z_]\w*)$/);
    const match = slice ?? map;
    if (match?.[1] !== undefined) collectionTypes.set(match[1], text);
  }

  const signals: Signal[] = [];
  for (const typeSpec of descendants(root, "type_spec")) {
    const nameNode = typeSpec.childForFieldName("name");
    const typeNode = typeSpec.childForFieldName("type");
    if (nameNode === null || typeNode?.type !== "struct_type") continue;

    const structName = sourceText(nameNode, file.current);
    const collection = collectionTypes.get(structName);
    if (collection === undefined) continue;

    for (const field of descendants(typeNode, "field_declaration")) {
      const fieldTypeNode = field.childForFieldName("type");
      const fieldNameNode = field.childForFieldName("name");
      if (fieldTypeNode === null || fieldNameNode === null) continue;

      const fieldType = sourceText(fieldTypeNode, file.current).replace(/\s+/g, "");
      if (!isDescriptorBearing(fieldType)) continue;

      const line = field.startPosition.row + 1;
      const endLine = field.endPosition.row + 1;
      if (!changed(file, line, endLine)) continue;

      const claim = claims.find((item) => Math.abs(item.line - line) <= 80);
      if (claim === undefined) continue;

      const fieldName = sourceText(fieldNameNode, file.current);
      signals.push({
        ruleId: "go-perf.cache-element-footprint-claim",
        path: file.path,
        line,
        ...(endLine === line ? {} : { endLine }),
        message:
          `${fieldName} adds a descriptor-bearing ${fieldType} value to ${structName}, ` +
          `which is stored as ${collection}, while the changed source claims the cache footprint stays slim or unchanged.`,
        snippet: sourceText(field, file.current).trim().slice(0, 300),
        data: {
          struct: structName,
          field: fieldName,
          fieldType,
          collection,
          claimLine: claim.line,
          claim: claim.text.slice(0, 300),
        },
      });
    }
  }
  return signals;
}

function cacheFootprintClaims(file: SourceRevision, root: Node): FootprintClaim[] {
  const comments = descendants(root, "comment").sort(
    (left, right) => left.startPosition.row - right.startPosition.row,
  );
  const groups: Node[][] = [];
  for (const comment of comments) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (current !== undefined && previous !== undefined &&
      comment.startPosition.row <= previous.endPosition.row + 1) {
      current.push(comment);
    } else {
      groups.push([comment]);
    }
  }

  const claims: FootprintClaim[] = [];
  for (const group of groups) {
    const startLine = group[0]!.startPosition.row + 1;
    const endLine = group[group.length - 1]!.endPosition.row + 1;
    if (!changed(file, startLine, endLine)) continue;

    const text = group.map((node) => sourceText(node, file.current))
      .join(" ")
      .replace(/\/\/|\/\*|\*\//g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!/\bcach(?:e|ed|ing)\b/i.test(text)) continue;
    if (!/\b(?:unchanged|same|slim|compact|size[- ]neutral)\b|\bno\s+(?:additional|extra)\b/i.test(text)) {
      continue;
    }
    claims.push({ line: startLine, text });
  }
  return claims;
}

function isDescriptorBearing(type: string): boolean {
  return type === "string" || type.startsWith("[]") || type.startsWith("map[");
}

function changed(file: SourceRevision, line: number, endLine = line): boolean {
  if (file.status === "repository" || file.status === "added") return true;
  for (let candidate = line; candidate <= endLine; candidate += 1) {
    if (file.changedLines.has(candidate)) return true;
  }
  return false;
}

function byLocation(left: { path: string; line: number }, right: { path: string; line: number }): number {
  return left.path.localeCompare(right.path) || left.line - right.line;
}
