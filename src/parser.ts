import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

let languagePromise: Promise<Language> | undefined;

function assetPath(name: string): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(currentDirectory, name),
    join(currentDirectory, "..", "node_modules", name === "web-tree-sitter.wasm" ? "web-tree-sitter" : "tree-sitter-go", name),
  ];
  const match = candidates.find(existsSync);
  if (match === undefined) throw new Error(`Unable to locate parser asset ${name}`);
  return match;
}

async function goLanguage(): Promise<Language> {
  languagePromise ??= (async () => {
    await Parser.init({ locateFile: () => assetPath("web-tree-sitter.wasm") });
    return Language.load(assetPath("tree-sitter-go.wasm"));
  })();
  return languagePromise;
}

export async function parseGo(source: string): Promise<Tree> {
  const language = await goLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  parser.delete();
  if (tree === null) throw new Error("Tree-sitter returned no syntax tree");
  return tree;
}

export function walk(node: Node, visit: (node: Node) => void): void {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    visit(current);
    for (let index = current.namedChildCount - 1; index >= 0; index -= 1) {
      const child = current.namedChild(index);
      if (child !== null) pending.push(child);
    }
  }
}

export function descendants(node: Node, type: string): Node[] {
  const result: Node[] = [];
  walk(node, (candidate) => {
    if (candidate.type === type) result.push(candidate);
  });
  return result;
}

export function sourceText(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}
