import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "ed89e584c2c420e3e0547bbe8f32baf8e3a2ae4d";
const dependency = resolve(root, "node_modules/@hraness/support-foundation");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.equal(manifest.devDependencies?.["@hraness/support-foundation"], `github:hraness/support-foundation#${commit}`);
assert.equal(manifest.dependencies, undefined);
const inputs = {
  "package.json": "48a38d5a1b453762875bca5fe3a85a884e2720fad2287892010f8c3dc3c03768",
  "dist/index.js": "6f7cf64ab9e22b55cfd6e338e0a6fef35bf8126bf86313f22b49782f6184147d",
  "dist/node.js": "a46faacc63511ab6f0ca4f80fc0823a8f1676f00e0bdb6a0af62eebd07d97e96",
  "LICENSE": "74b69bf37c8f340c9c2a54d431a15218738d9c463d0e014fa6a8bb8edce4e539",
};
for (const [path, digest] of Object.entries(inputs)) assert.equal(createHash("sha256").update(await readFile(resolve(dependency, path))).digest("hex"), digest, `Reviewed foundation input ${path}`);
const notice = await readFile(resolve(root, "plugins/skillpack-admin/skills/skillpack-admin/THIRD_PARTY_NOTICES.md"), "utf8");
assert.ok(notice.includes(commit) && notice.includes((await readFile(resolve(dependency, "LICENSE"), "utf8")).trim()));
const [mode, ...extra] = process.argv.slice(2);
assert.ok((mode === undefined || mode === "--check") && extra.length === 0, "Use no argument to build or --check to verify");
const result = await Bun.build({ entrypoints: [resolve(root, "scripts/support-entry.mjs")], target: "node", format: "esm", metafile: true });
assert.ok(result.success && result.outputs.length === 1, "Support helper bundle failed");
assert.deepEqual(Object.keys(result.metafile?.inputs ?? {}).map(path => resolve(root, path)).sort(),
  [resolve(root, "scripts/support-entry.mjs"), resolve(dependency, "dist/node.js")].sort(),
  "Support bundle includes an unreviewed entrypoint");
const bytes = Buffer.from(await result.outputs[0].arrayBuffer());
const target = resolve(root, "plugins/skillpack-admin/skills/skillpack-admin/scripts/support.mjs");
if (mode === "--check") assert.ok(bytes.equals(await readFile(target)), "Committed helper differs from reviewed build inputs");
else await writeFile(target, bytes);
console.log(`Verified self-contained support helper (${bytes.length} bytes).`);
