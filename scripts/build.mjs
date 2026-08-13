import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const bundledLicenses = [
  ["adversarylabs-sdk", "node_modules/@adversarylabs/sdk/LICENSE"],
  ["ajv", "node_modules/ajv/LICENSE"],
  ["fast-deep-equal", "node_modules/fast-deep-equal/LICENSE"],
  ["fast-uri", "node_modules/fast-uri/LICENSE"],
  ["json-schema-traverse", "node_modules/json-schema-traverse/LICENSE"],
  ["web-tree-sitter", "node_modules/web-tree-sitter/LICENSE"],
  ["yaml", "node_modules/yaml/LICENSE"],
];
const assetLicenses = [
  ["tree-sitter-go", "node_modules/tree-sitter-go/LICENSE"],
];

await rm("dist", { recursive: true, force: true });
await rm("licenses", { recursive: true, force: true });

const buildResult = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "external",
  metafile: true,
  outfile: "dist/index.js",
  banner: {
    js: "import { createRequire as __goPerformanceCreateRequire } from 'node:module'; const require = __goPerformanceCreateRequire(import.meta.url);",
  },
});

const bundledPackages = new Set();
for (const input of Object.keys(buildResult.metafile.inputs)) {
  const marker = "node_modules/";
  const offset = input.lastIndexOf(marker);
  if (offset === -1) continue;
  const parts = input.slice(offset + marker.length).split("/");
  bundledPackages.add(parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
}
const licensedPackages = new Set([
  "@adversarylabs/sdk",
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "web-tree-sitter",
  "yaml",
]);
const missingLicenses = [...bundledPackages].filter((name) => !licensedPackages.has(name));
const staleLicenses = [...licensedPackages].filter((name) => !bundledPackages.has(name));
if (missingLicenses.length > 0 || staleLicenses.length > 0) {
  throw new Error(
    `bundled dependency license inventory mismatch; missing=${missingLicenses.join(",")}; stale=${staleLicenses.join(",")}`,
  );
}

await mkdir("licenses", { recursive: true });
for (const [name, source] of [...bundledLicenses, ...assetLicenses]) {
  const text = await readFile(source, "utf8");
  if (text.trim().length === 0) throw new Error(`runtime dependency license is empty: ${source}`);
  const normalized = text.replaceAll("\r\n", "\n").split("\n").map((line) => line.trimEnd()).join("\n").trimEnd();
  await writeFile(`licenses/${name}.txt`, `${normalized}\n`);
}

await copyFile(
  "node_modules/web-tree-sitter/web-tree-sitter.wasm",
  "dist/web-tree-sitter.wasm",
);
await copyFile(
  "node_modules/tree-sitter-go/tree-sitter-go.wasm",
  "dist/tree-sitter-go.wasm",
);

await mkdir("schemas", { recursive: true });
await copyFile(
  "node_modules/@adversarylabs/sdk/schemas/adversary.review.v1.schema.json",
  "schemas/adversary.review.v1.schema.json",
);
