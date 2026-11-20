import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commit = "ed89e584c2c420e3e0547bbe8f32baf8e3a2ae4d";
const dependency = resolve(root, "scripts/vendor/support-node.mjs");
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.equal(manifest.devDependencies, undefined);
assert.equal(manifest.dependencies, undefined);
const provenance = JSON.parse(await readFile(resolve(root, "scripts/vendor/support-node.provenance.json"), "utf8"));
assert.equal(provenance.sourceCommit, "918fb84d8f75d971cdb99cf6d67e17b3983d1582");
assert.equal(provenance.sourceSha256, "b4a9ec815c41bfa6690641a4af20a4557f8a5062927bb02255cbac2d3e95289b");
assert.equal(provenance.upstreamCommit, commit);
assert.equal(provenance.moduleSha256, "3ffb99158cfabc43b20564e4989053f8bed06e2bc8903c12aa1b91b1de6fe0bd");
assert.equal(createHash("sha256").update(await readFile(dependency)).digest("hex"), provenance.moduleSha256, "Reviewed public support input scripts/vendor/support-node.mjs");
const notice = await readFile(resolve(root, "plugins/skillpack-admin/skills/skillpack-admin/THIRD_PARTY_NOTICES.md"), "utf8");
assert.ok(notice.includes(commit) && notice.includes("MIT License"));
const [mode, ...extra] = process.argv.slice(2);
assert.ok((mode === undefined || mode === "--check") && extra.length === 0, "Use no argument to build or --check to verify");
const result = await Bun.build({ entrypoints: [resolve(root, "scripts/support-entry.mjs")], target: "node", format: "esm", metafile: true });
assert.ok(result.success && result.outputs.length === 1, "Support helper bundle failed");
assert.deepEqual(Object.keys(result.metafile?.inputs ?? {}).map(path => resolve(root, path)).sort(),
  [resolve(root, "scripts/support-entry.mjs"), dependency].sort(),
  "Support bundle includes an unreviewed entrypoint");
const bytes = Buffer.from(await result.outputs[0].arrayBuffer());
const target = resolve(root, "plugins/skillpack-admin/skills/skillpack-admin/scripts/support.mjs");
if (mode === "--check") assert.ok(bytes.equals(await readFile(target)), "Committed helper differs from reviewed build inputs");
else await writeFile(target, bytes);
console.log(`Verified self-contained support helper (${bytes.length} bytes).`);
