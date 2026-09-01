#!/usr/bin/env bun
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ALLOWED_SKILL_FRONTMATTER = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const TEXT_EXTENSIONS = new Set([".md", ".mdc", ".json", ".mjs", ".js", ".ts", ".yml", ".yaml", ".sh"]);
const PLACEHOLDERS = [/[[]TODO(?::|])/i, new RegExp(`\\b(?:${["FIX", "ME"].join("")}|${["CHANGE", "ME"].join("")})\\b`), /\bYOUR_(?:NAME|ORG|TOKEN|PATH)\b/, /<insert[-_ ]/i];
const FORBIDDEN = [
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//, label: "private macOS path" },
  { pattern: /\/home\/[A-Za-z0-9._-]+\//, label: "private Linux path" },
  { pattern: /[A-Za-z]:\\Users\\[^\\]+\\/, label: "private Windows path" },
  { pattern: /~\/(?:\.codex|\.cursor)\//, label: "host-specific home path" },
  { pattern: /\b(?:gpt|claude)-[0-9][A-Za-z0-9.-]*/i, label: "hard-coded model name" },
  { pattern: new RegExp(`\\b(?:${["Mo", "dal"].join("")}|${["Run", "Pod"].join("")}|${["Lambda", " Labs"].join("")})\\b`), label: "cloud execution dependency" }
];

function failure(message, path) {
  return path ? `${path}: ${message}` : message;
}

async function exists(path) {
  try { return await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function readJson(path, errors) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { errors.push(failure(`invalid JSON (${error.message})`, path)); return null; }
}

async function walk(root, options = {}) {
  const files = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", ".hra-skillpack-backups"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!options.allowSymlinks) files.push({ path, symlink: true });
      } else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path, symlink: false });
    }
  }
  await visit(root);
  return files;
}

export function parseFrontmatter(markdown, path = "SKILL.md") {
  if (!markdown.startsWith("---\n")) throw new Error(failure("missing YAML frontmatter", path));
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(failure("unterminated YAML frontmatter", path));
  const raw = markdown.slice(4, end);
  const values = {};
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s/.test(line) || !line.includes(":")) continue;
    const separator = line.indexOf(":");
    const key = line.slice(0, separator).trim();
    const scalar = line.slice(separator + 1).trim();
    if ([">", ">-", "|", "|-"].includes(scalar)) {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) parts.push(lines[index += 1].trim());
      values[key] = parts.join(scalar.startsWith(">") ? " " : "\n");
    } else values[key] = scalar.replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

async function validateSkillReferences(skillRoot, markdown, errors) {
  const candidates = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) candidates.push(match[1].trim().split(/[?#]/)[0]);
  for (const candidate of candidates) {
    if (!candidate || candidate.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) continue;
    if (!safeRelativePath(candidate)) {
      errors.push(failure(`unsafe skill reference: ${candidate}`, join(skillRoot, "SKILL.md")));
      continue;
    }
    const target = resolve(skillRoot, candidate);
    const rel = relative(skillRoot, target);
    if (rel === ".." || rel.startsWith(`..${sep}`)) errors.push(failure(`reference escapes skill: ${candidate}`, join(skillRoot, "SKILL.md")));
    else if (!(await exists(target))) errors.push(failure(`missing skill reference: ${candidate}`, join(skillRoot, "SKILL.md")));
  }
}

async function validateOpenAiMetadata(skill, errors) {
  const path = join(skill.root, "agents/openai.yaml");
  if (!(await exists(path))) {
    errors.push(failure("missing agents/openai.yaml", skill.file));
    return;
  }
  const content = await readFile(path, "utf8");
  const display = content.match(/^\s*display_name:\s*"([^"]+)"\s*$/m)?.[1];
  const short = content.match(/^\s*short_description:\s*"([^"]+)"\s*$/m)?.[1];
  const prompt = content.match(/^\s*default_prompt:\s*"([^"]+)"\s*$/m)?.[1];
  if (!display) errors.push(failure("openai.yaml needs a quoted display_name", path));
  if (!short || short.length < 25 || short.length > 64) errors.push(failure("openai.yaml short_description must be 25-64 characters", path));
  if (!prompt || !prompt.includes(`$${skill.name}`)) errors.push(failure(`openai.yaml default_prompt must mention $${skill.name}`, path));
  const policy = content.match(/^\s*allow_implicit_invocation:\s*(true|false)\s*$/m)?.[1];
  if (skill.plugin === "semantic-algos" && policy !== "false") errors.push(failure("semantic skills must disable implicit Codex invocation", path));
}

export async function discoverAndValidateSkills(root, errors = []) {
  const pluginsRoot = join(root, "plugins");
  const skills = [];
  if (!(await exists(pluginsRoot))) { errors.push("plugins directory is missing"); return skills; }
  for (const plugin of await readdir(pluginsRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const container = join(pluginsRoot, plugin.name, "skills");
    if (!(await exists(container))) continue;
    for (const entry of await readdir(container, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillRoot = join(container, entry.name);
      const skillFile = join(skillRoot, "SKILL.md");
      if (!(await exists(skillFile))) continue;
      try {
        const markdown = await readFile(skillFile, "utf8");
        const frontmatter = parseFrontmatter(markdown, skillFile);
        for (const key of Object.keys(frontmatter)) if (!ALLOWED_SKILL_FRONTMATTER.has(key)) errors.push(failure(`unsupported frontmatter key: ${key}`, skillFile));
        if (!NAME_PATTERN.test(frontmatter.name ?? "")) errors.push(failure(`invalid skill name: ${frontmatter.name ?? "missing"}`, skillFile));
        if ((frontmatter.name ?? "").length > 64) errors.push(failure("skill name exceeds 64 characters", skillFile));
        if (frontmatter.name !== entry.name) errors.push(failure(`folder must match frontmatter name ${frontmatter.name}`, skillFile));
        const description = frontmatter.description ?? "";
        if (description.length < 40) errors.push(failure("description is too short", skillFile));
        if (description.length > 1024) errors.push(failure("description exceeds 1024 characters", skillFile));
        if (/[<>]/.test(description)) errors.push(failure("description cannot contain angle brackets", skillFile));
        if (!/\bUse (?:when|for|only when)\b/i.test(description) || !/\b(?:Do not use|do not route|not a request to)\b/i.test(description)) errors.push(failure("description must contain both positive and negative use boundaries", skillFile));
        await validateSkillReferences(skillRoot, markdown, errors);
        const skill = { name: frontmatter.name, plugin: plugin.name, root: skillRoot, file: skillFile, description };
        await validateOpenAiMetadata(skill, errors);
        skills.push(skill);
      } catch (error) { errors.push(error.message); }
    }
  }
  const names = new Map();
  for (const skill of skills) {
    if (names.has(skill.name)) errors.push(failure(`duplicate skill name also at ${names.get(skill.name)}`, skill.file));
    else names.set(skill.name, skill.file);
  }
  return skills;
}

async function validateManifestPath(pluginRoot, value, label, errors) {
  if (!safeRelativePath(value)) { errors.push(failure(`${label} must be a safe relative path`, pluginRoot)); return; }
  if (!(await exists(resolve(pluginRoot, value)))) errors.push(failure(`${label} does not exist: ${value}`, pluginRoot));
}

async function validateManifests(root, errors) {
  const codexMarketplace = await readJson(join(root, ".agents/plugins/marketplace.json"), errors);
  const cursorMarketplace = await readJson(join(root, ".cursor-plugin/marketplace.json"), errors);
  for (const [host, marketplace] of [["Codex", codexMarketplace], ["Cursor", cursorMarketplace]]) {
    if (!marketplace) continue;
    const seen = new Set();
    for (const entry of marketplace.plugins ?? []) {
      if (!NAME_PATTERN.test(entry.name ?? "")) errors.push(`${host} marketplace has invalid plugin name: ${entry.name}`);
      if (seen.has(entry.name)) errors.push(`${host} marketplace duplicates plugin: ${entry.name}`);
      seen.add(entry.name);
      const sourceValue = host === "Codex" ? entry.source?.path : typeof entry.source === "string" ? entry.source : entry.source?.path;
      if (!safeRelativePath(sourceValue)) { errors.push(`${host} marketplace ${entry.name} has unsafe source path`); continue; }
      const sourcePath = resolve(root, sourceValue.replace(/^\.\//, ""));
      if (!(await exists(sourcePath))) errors.push(`${host} marketplace ${entry.name} source does not exist: ${sourceValue}`);
      if (host === "Codex") {
        const manifestPath = join(sourcePath, ".codex-plugin/plugin.json");
        const manifest = await readJson(manifestPath, errors);
        if (manifest?.name !== entry.name) errors.push(failure(`plugin name ${manifest?.name} must match folder/marketplace ${entry.name}`, manifestPath));
        if (manifest?.skills) await validateManifestPath(sourcePath, manifest.skills, "skills path", errors);
      } else {
        const manifestPath = join(sourcePath, ".cursor-plugin/plugin.json");
        if (await exists(manifestPath)) {
          const manifest = await readJson(manifestPath, errors);
          if (manifest?.name !== entry.name) errors.push(failure(`plugin name ${manifest?.name} must match marketplace ${entry.name}`, manifestPath));
          if (manifest?.skills) await validateManifestPath(sourcePath, manifest.skills, "skills path", errors);
        } else if (entry.skills) await validateManifestPath(sourcePath, entry.skills, "marketplace skills path", errors);
      }
    }
  }

  const pluginEntries = await readdir(join(root, "plugins"), { withFileTypes: true });
  const expectedNames = pluginEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const codexNames = (codexMarketplace?.plugins ?? []).map((entry) => entry.name).sort();
  const cursorNames = (cursorMarketplace?.plugins ?? []).map((entry) => entry.name).sort();
  if (JSON.stringify(codexNames) !== JSON.stringify(expectedNames)) errors.push("Codex marketplace must list every plugin exactly once");
  if (JSON.stringify(cursorNames) !== JSON.stringify(expectedNames)) errors.push("Cursor marketplace must list every plugin exactly once");

  for (const name of expectedNames) {
    const pluginRoot = join(root, "plugins", name);
    const portable = await readJson(join(pluginRoot, "plugin.json"), errors);
    const cursor = await readJson(join(pluginRoot, ".cursor-plugin/plugin.json"), errors);
    const codex = await readJson(join(pluginRoot, ".codex-plugin/plugin.json"), errors);
    for (const [kind, manifest] of [["Agent Plugin", portable], ["Cursor", cursor], ["Codex", codex]]) {
      if (!manifest) continue;
      if (manifest.name !== name) errors.push(`${kind} manifest name ${manifest.name} must match ${name}`);
      if (!SEMVER_PATTERN.test(manifest.version ?? "")) errors.push(`${kind} manifest ${name} needs strict semver`);
      if (!manifest.description || !manifest.author?.name) errors.push(`${kind} manifest ${name} needs description and author.name`);
    }
    if (portable?.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") errors.push(`Agent Plugin manifest ${name} needs the 1.0.0 schema`);
    if (portable?.version !== cursor?.version || portable?.version !== codex?.version) errors.push(`plugin ${name} manifest versions must match`);
    if (!codex?.interface?.displayName || !codex?.interface?.shortDescription || !codex?.interface?.longDescription || !codex?.interface?.developerName || !codex?.interface?.category || !Array.isArray(codex?.interface?.defaultPrompt)) errors.push(`Codex manifest ${name} needs complete interface metadata`);
  }

  const semanticRoot = join(root, "plugins/semantic-algos");
  const semanticCursor = await readJson(join(semanticRoot, ".cursor-plugin/plugin.json"), errors);
  if (semanticCursor?.skills !== "./cursor-explicit-skills/" || semanticCursor?.commands !== "./commands/") errors.push("semantic Cursor manifest must use explicit command adapters and suppress skill discovery");
  const semanticSkills = (await readdir(join(semanticRoot, "skills"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const semanticCommands = (await readdir(join(semanticRoot, "commands"), { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name.slice(0, -3)).sort();
  if (JSON.stringify(semanticCommands) !== JSON.stringify(semanticSkills)) errors.push("Cursor semantic commands must map one-to-one to canonical semantic skills");
  for (const name of semanticCommands) {
    const command = await readFile(join(semanticRoot, "commands", `${name}.md`), "utf8");
    if (!command.includes(`../skills/${name}/SKILL.md`)) errors.push(`Cursor semantic command ${name} must reference its canonical skill`);
  }
}

export function validateRouting(catalog, fixtures, errors = []) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.skills)) { errors.push("catalog/catalog.json has unsupported shape"); return; }
  if (fixtures?.schemaVersion !== 1 || !Array.isArray(fixtures.cases)) { errors.push("catalog/routing-fixtures.json has unsupported shape"); return; }
  const names = catalog.skills.map((skill) => skill.name);
  const unique = new Set(names);
  if (unique.size !== names.length) errors.push("catalog contains duplicate skill names");
  for (const skill of catalog.skills) {
    if (!NAME_PATTERN.test(skill.name) || !NAME_PATTERN.test(skill.plugin)) errors.push(`catalog has invalid identity for ${skill.name}`);
    if (!skill.owner || !skill.positive?.length || !skill.negative?.length) errors.push(`catalog ${skill.name} needs owner, positive, and negative boundaries`);
    const positive = fixtures.cases.filter((item) => item.kind === "positive" && item.expected?.includes(skill.name));
    const negative = fixtures.cases.filter((item) => item.kind === "negative" && item.excluded?.includes(skill.name));
    if (!positive.length) errors.push(`routing lacks a positive fixture for ${skill.name}`);
    if (!negative.length) errors.push(`routing lacks a negative fixture for ${skill.name}`);
  }
  const ids = new Set();
  for (const item of fixtures.cases) {
    if (ids.has(item.id)) errors.push(`duplicate routing fixture id: ${item.id}`);
    ids.add(item.id);
    if (!item.prompt || !["positive", "negative", "pairwise"].includes(item.kind)) errors.push(`invalid routing fixture: ${item.id}`);
    for (const name of [...(item.expected ?? []), ...(item.excluded ?? []), ...(item.candidates ?? [])]) if (!unique.has(name)) errors.push(`routing fixture ${item.id} references unknown skill ${name}`);
    if ((item.expected ?? []).length > 1) errors.push(`routing fixture ${item.id} has multiple owners`);
    if (item.expected?.some((name) => item.excluded?.includes(name))) errors.push(`routing fixture ${item.id} both expects and excludes ${item.expected[0]}`);
  }
  const requiredPairs = new Set();
  for (const skill of catalog.skills) for (const adjacent of skill.adjacent ?? []) {
    if (!unique.has(adjacent)) errors.push(`catalog ${skill.name} has unknown adjacent skill ${adjacent}`);
    else if (adjacent !== skill.name) requiredPairs.add([skill.name, adjacent].sort().join(" / "));
  }
  for (const pairKey of requiredPairs) {
    const pair = pairKey.split(" / ");
    const matches = fixtures.cases.filter((item) => item.kind === "pairwise" && JSON.stringify([...(item.candidates ?? [])].sort()) === JSON.stringify(pair));
    if (matches.length !== 1) errors.push(`routing needs exactly one pairwise fixture for adjacent skills ${pairKey}`);
    else {
      const item = matches[0];
      if (item.expected?.length !== 1 || !pair.includes(item.expected[0])) errors.push(`pairwise fixture ${item.id} needs exactly one candidate owner`);
      const loser = pair.find((name) => name !== item.expected?.[0]);
      if (!item.excluded?.includes(loser)) errors.push(`pairwise fixture ${item.id} must exclude non-owner ${loser}`);
    }
  }
}

async function validateProvenance(root, skills, errors) {
  const provenance = await readJson(join(root, "catalog/provenance.json"), errors);
  const lock = await readJson(join(root, "sources.lock.json"), errors);
  if (!provenance || !lock) return;
  const sourceById = new Map();
  for (const source of lock.sources ?? []) {
    if (sourceById.has(source.id)) errors.push(`duplicate source lock id: ${source.id}`);
    sourceById.set(source.id, source);
    if (!/^https:\/\//.test(source.canonicalUrl ?? "")) errors.push(`source ${source.id} needs a canonical HTTPS URL`);
    if (!REVISION_PATTERN.test(source.revision ?? "")) errors.push(`source ${source.id} needs an exact 40-character Git revision`);
    if (!source.license || !source.upstreamPaths?.length || !source.localPaths?.length) errors.push(`source ${source.id} lacks license or path inventory`);
    if (source.license?.startsWith("LicenseRef-Permission-") && !source.permissionNote) errors.push(`permission source ${source.id} needs a permissionNote`);
    for (const path of source.localPaths ?? []) if (!safeRelativePath(path) || !(await exists(resolve(root, path)))) errors.push(`source ${source.id} has invalid local path: ${path}`);
  }
  const provenanceByName = new Map();
  for (const item of provenance.skills ?? []) {
    if (provenanceByName.has(item.name)) errors.push(`duplicate provenance for ${item.name}`);
    provenanceByName.set(item.name, item);
    if (!["original", "adapted"].includes(item.classification)) errors.push(`invalid provenance classification for ${item.name}`);
    if (!item.localPaths?.length) errors.push(`provenance ${item.name} lacks local paths`);
    for (const path of item.localPaths ?? []) if (!safeRelativePath(path) || !(await exists(resolve(root, path)))) errors.push(`provenance ${item.name} has invalid local path: ${path}`);
    if (item.classification === "adapted" && !item.sourceIds?.length) errors.push(`adapted skill ${item.name} lacks sourceIds`);
    if (item.classification === "original" && item.sourceIds?.length) errors.push(`original skill ${item.name} must not claim upstream sources`);
    for (const sourceId of item.sourceIds ?? []) if (!sourceById.has(sourceId)) errors.push(`provenance ${item.name} references unlocked source ${sourceId}`);
  }
  for (const skill of skills) if (!provenanceByName.has(skill.name)) errors.push(`missing provenance for discovered skill ${skill.name}`);
  const discoveredNames = new Set(skills.map((skill) => skill.name));
  for (const name of provenanceByName.keys()) if (!discoveredNames.has(name)) errors.push(`provenance references undiscovered skill ${name}`);
}

async function validateText(root, errors) {
  for (const file of await walk(root)) {
    const rel = relative(root, file.path).split(sep).join("/");
    if (file.symlink) { errors.push(failure("symbolic links are not portable", rel)); continue; }
    if (!TEXT_EXTENSIONS.has(extname(file.path)) && !["LICENSE"].includes(rel)) continue;
    const content = await readFile(file.path, "utf8");
    for (const pattern of PLACEHOLDERS) if (pattern.test(content)) errors.push(failure(`placeholder pattern ${pattern} is forbidden`, rel));
    for (const entry of FORBIDDEN) if (entry.pattern.test(content)) errors.push(failure(`${entry.label} is forbidden`, rel));
  }
}

export async function validateRepository(inputRoot) {
  const root = await realpath(resolve(inputRoot));
  const errors = [];
  const skills = await discoverAndValidateSkills(root, errors);
  const catalog = await readJson(join(root, "catalog/catalog.json"), errors);
  const fixtures = await readJson(join(root, "catalog/routing-fixtures.json"), errors);
  validateRouting(catalog, fixtures, errors);
  if (catalog) {
    const catalogByName = new Map(catalog.skills.map((item) => [item.name, item]));
    for (const skill of skills) {
      const item = catalogByName.get(skill.name);
      if (!item) errors.push(`discovered skill ${skill.name} is absent from catalog`);
      else if (item.plugin !== skill.plugin) errors.push(`catalog plugin mismatch for ${skill.name}: ${item.plugin} != ${skill.plugin}`);
    }
    const discoveredNames = new Set(skills.map((skill) => skill.name));
    for (const item of catalog.skills) if (!discoveredNames.has(item.name)) errors.push(`catalog references undiscovered skill ${item.name}`);
  }
  await validateManifests(root, errors);
  await validateProvenance(root, skills, errors);
  await validateText(root, errors);
  return { root, skills: skills.map(({ name, plugin }) => ({ name, plugin })), errors };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1) throw new Error("usage: bun scripts/validate.mjs [repository-root]");
  const root = argv[0] ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await validateRepository(root);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`ERROR ${error}`);
    console.error(`validation failed: ${result.errors.length} error(s)`);
    process.exitCode = 1;
  } else process.stdout.write(`validation passed: ${result.skills.length} skill(s)\n`);
  return result;
}

if (import.meta.main) main().catch((error) => { console.error(`validation failed: ${error.message}`); process.exitCode = 1; });
