import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  banner: {
    js: "import { createRequire as __goPerformanceCreateRequire } from 'node:module'; const require = __goPerformanceCreateRequire(import.meta.url);",
  },
});

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
