import { createHash } from "node:crypto";
import { copyFile, mkdir, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function maybeStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function assertNoSymlinkAncestors(path) {
  let cursor = resolve(path);
  const root = parse(cursor).root;
  while (true) {
    const stat = await maybeStat(cursor);
    if (stat?.isSymbolicLink()) throw new Error(`symbolic-link path refused: ${cursor}`);
    if (stat) return;
    if (cursor === root) return;
    cursor = dirname(cursor);
  }
}

async function assertNoSymlinkBelow(root, relativePath) {
  let cursor = resolve(root);
  for (const part of relativePath.split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await maybeStat(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`symbolic-link destination refused: ${cursor}`);
  }
}

export function assertBoundedTarget(target, source) {
  const bounded = resolve(target);
  if (!isAbsolute(bounded) || bounded === parse(bounded).root) {
    throw new Error("target must be an explicit bounded directory, not a filesystem root");
  }
  if (source) {
    const origin = resolve(source);
    if (bounded === origin || relative(origin, bounded) === "") {
      throw new Error("target must differ from source");
    }
  }
  return bounded;
}

export async function walkFiles(root) {
  const start = resolve(root);
  const stat = await maybeStat(start);
  if (!stat?.isDirectory()) throw new Error(`directory not found: ${start}`);
  if (stat.isSymbolicLink()) throw new Error(`symbolic-link directory refused: ${start}`);
  const files = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = relative(start, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`symbolic link refused: ${rel}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({ absolute, relative: rel });
      else throw new Error(`unsupported filesystem entry: ${rel}`);
    }
  }
  await visit(start);
  return files;
}

export async function hashTree(root) {
  const files = await walkFiles(root);
  const hash = createHash("sha256");
  const entries = [];
  for (const file of files) {
    const content = await readFile(file.absolute);
    const digest = createHash("sha256").update(content).digest("hex");
    entries.push({ path: file.relative, sha256: digest, bytes: content.byteLength });
    hash.update(file.relative).update("\0").update(digest).update("\n");
  }
  return { sha256: hash.digest("hex"), files: entries };
}

function parseSkillName(markdown, path) {
  if (!markdown.startsWith("---\n")) throw new Error(`missing YAML frontmatter: ${path}`);
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`unterminated YAML frontmatter: ${path}`);
  const frontmatter = markdown.slice(4, end);
  const match = frontmatter.match(/^name:\s*([^\n]+)$/m);
  if (!match) throw new Error(`missing frontmatter name: ${path}`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
}

export async function discoverSkills(source) {
  const root = resolve(source);
  const roots = [];
  if (await maybeStat(join(root, "SKILL.md"))) roots.push(root);
  if ((await maybeStat(join(root, "skills")))?.isDirectory()) roots.push(join(root, "skills"));
  const plugins = join(root, "plugins");
  if ((await maybeStat(plugins))?.isDirectory()) {
    for (const plugin of await readdir(plugins, { withFileTypes: true })) {
      if (plugin.isSymbolicLink()) throw new Error(`symbolic-link plugin refused: ${plugin.name}`);
      if (plugin.isDirectory()) {
        const skills = join(plugins, plugin.name, "skills");
        if ((await maybeStat(skills))?.isDirectory()) roots.push(skills);
      }
    }
  }

  const found = new Map();
  for (const container of roots) {
    if (basename(container) !== "skills" && (await maybeStat(join(container, "SKILL.md")))) {
      const markdown = await readFile(join(container, "SKILL.md"), "utf8");
      const name = parseSkillName(markdown, join(container, "SKILL.md"));
      if (name !== basename(container)) throw new Error(`skill name/folder mismatch: ${name} != ${basename(container)}`);
      found.set(name, container);
      continue;
    }
    for (const entry of await readdir(container, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillRoot = join(container, entry.name);
      const skillFile = join(skillRoot, "SKILL.md");
      if (!(await maybeStat(skillFile))) continue;
      const markdown = await readFile(skillFile, "utf8");
      const name = parseSkillName(markdown, skillFile);
      if (!NAME_PATTERN.test(name)) throw new Error(`invalid skill name: ${name}`);
      if (name !== entry.name) throw new Error(`skill name/folder mismatch: ${name} != ${entry.name}`);
      if (found.has(name)) throw new Error(`duplicate skill name: ${name}`);
      found.set(name, skillRoot);
    }
  }
  return new Map([...found.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export async function compareTrees(source, destination) {
  const destinationStat = await maybeStat(destination);
  if (!destinationStat) return { state: "missing", source: await hashTree(source) };
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
    return { state: "drift", reason: "destination is not a regular directory", source: await hashTree(source) };
  }
  const [sourceTree, destinationTree] = await Promise.all([hashTree(source), hashTree(destination)]);
  if (sourceTree.sha256 === destinationTree.sha256) return { state: "match", source: sourceTree, destination: destinationTree };
  const sourceByPath = new Map(sourceTree.files.map((item) => [item.path, item.sha256]));
  const destinationByPath = new Map(destinationTree.files.map((item) => [item.path, item.sha256]));
  return {
    state: "drift",
    source: sourceTree,
    destination: destinationTree,
    missing: sourceTree.files.filter((item) => !destinationByPath.has(item.path)).map((item) => item.path),
    changed: sourceTree.files.filter((item) => destinationByPath.has(item.path) && destinationByPath.get(item.path) !== item.sha256).map((item) => item.path),
    extra: destinationTree.files.filter((item) => !sourceByPath.has(item.path)).map((item) => item.path)
  };
}

export async function copyTreeOverlay(source, destination) {
  await assertNoSymlinkAncestors(destination);
  const files = await walkFiles(source);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const output = resolve(destination, file.relative);
    const rel = relative(resolve(destination), output);
    if (rel.startsWith(`..${sep}`) || rel === "..") throw new Error(`path escape refused: ${file.relative}`);
    await assertNoSymlinkBelow(destination, dirname(file.relative));
    await mkdir(dirname(output), { recursive: true });
    await assertNoSymlinkBelow(destination, dirname(file.relative));
    await copyFile(file.absolute, output);
  }
}

export function parseArgs(argv) {
  const result = { skills: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--root" || token === "--source" || token === "--target" || token === "--repos-root" || token === "--skill") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--skill") result.skills.push(value);
      else result[token.slice(2)] = value;
    } else if (["--all", "--apply", "--repair", "--json"].includes(token)) {
      result[token.slice(2)] = true;
    } else {
      throw new Error(`unknown argument: ${token}`);
    }
  }
  return result;
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:.]/g, "");
}
