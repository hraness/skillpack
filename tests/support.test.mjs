import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const skill = resolve(import.meta.dir, "../plugins/skillpack-admin/skills/skillpack-admin");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillpack-support-")));
  mkdirSync(join(root, "copied skill"));
  const script = join(root, "copied skill", "support.mjs");
  copyFileSync(join(skill, "scripts/support.mjs"), script);
  const env = { HOME: root, XDG_STATE_HOME: join(root, "state"), HRANESS_SUPPORT_AUDIENCE: "agent", HRANESS_SUPPORT_EMAIL: "off", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const invoke = (args, override = {}, executable = process.execPath) => {
    const result = spawnSync(executable, [script, ...args], { cwd: root, env: { ...env, ...override }, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
    return args.includes("--json") ? JSON.parse(result.stdout) : result.stdout;
  };
  return { root, script, env, invoke, close: () => rmSync(root, { recursive: true, force: true }) };
}
test("copied skill support is dependency-free, read-only for protocol and disabled offers", () => {
  const f = fixture();
  try {
    const protocol = f.invoke(["protocol", "--json"]);
    expect(protocol.schemaVersion).toBe("hraness-support-protocol-v1");
    expect(protocol.offer.product.id).toBe("hraness");
    expect(protocol.offer.actions.map(action => action.kind)).toEqual(["support"]);
    expect(protocol.offer.actions[0].url).toBe("https://account.hraness.com/support?product=hraness&source=agent#support");
    expect(protocol.commands.offer).toEqual([process.execPath, f.script, "support", "offer", "--json"]);
    expect(f.invoke(protocol.commands.offer.slice(2), { HRANESS_SUPPORT_AUDIENCE: "off" }).kind).toBe("quiet");
    expect(f.invoke(["offer", "--json"], { HRANESS_SUPPORT_AUDIENCE: "off" }).kind).toBe("quiet");
    expect(readdirSync(f.root)).toEqual(["copied skill"]);
    const node = Bun.which("node");
    if (node) expect(f.invoke(["protocol", "--json"], {}, node).offer).toEqual(protocol.offer);
  } finally { f.close(); }
});
test("copied helper executes through a Node symlink and stays quiet when imported", () => {
  const f = fixture();
  try {
    const node = Bun.which("node"); expect(node).toBeString();
    const alias = join(f.root, "support-alias.mjs"); symlinkSync(f.script, alias);
    const result = spawnSync(node, [alias, "protocol", "--json"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).schemaVersion).toBe("hraness-support-protocol-v1");
    for (const executable of [node, process.execPath]) {
      const imported = spawnSync(executable, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(alias).href)})`], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 5000 });
      expect(imported.status).toBe(0); expect(imported.stdout).toBe(""); expect(imported.stderr).toBe("");
    }
    expect(readdirSync(f.root).sort()).toEqual(["copied skill", "support-alias.mjs"]);
  } finally { f.close(); }
});
test("build rejects changed dependency exports before bundling", () => {
  const f = fixture(), repository = resolve(import.meta.dir, "..");
  try {
    mkdirSync(join(f.root, "scripts"));
    copyFileSync(join(repository, "scripts/build-support.mjs"), join(f.root, "scripts/build-support.mjs"));
    copyFileSync(join(repository, "package.json"), join(f.root, "package.json"));
    const dependency = join(f.root, "node_modules/@hraness/support-foundation"); mkdirSync(dependency, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(repository, "node_modules/@hraness/support-foundation/package.json"), "utf8"));
    manifest.exports["./node"].import = "./unreviewed.mjs";
    writeFileSync(join(dependency, "package.json"), JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [join(f.root, "scripts/build-support.mjs"), "--check"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 5000 });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain("Reviewed foundation input package.json"); expect(result.stdout).toBe("");
  } finally { f.close(); }
});
test("claims support release, acknowledged cooldown and suite decline without email lookup", () => {
  const f = fixture();
  try {
    const first = f.invoke(["offer", "--json"]);
    expect(first.kind).toBe("offer"); expect(first.invitation.emailSuggestion).toBeUndefined();
    expect(f.invoke(["offer", "--json"]).kind).toBe("quiet");
    f.invoke(["release", first.invitation.id]);
    const next = f.invoke(["offer", "--json"]); expect(next.kind).toBe("offer");
    // Synthetic host receipt: output is represented before acknowledgement.
    const visible = next.invitation; expect(visible.actions[0].kind).toBe("support");
    f.invoke(["shown", next.invitation.id]);
    expect(f.invoke(["offer", "--json"]).reason).toBe("cooldown");
    f.invoke(["dismiss"]); expect(f.invoke(["offer", "--json"]).kind).toBe("quiet");
    f.invoke(["enable"]); expect(f.invoke(["status", "--json"]).schemaVersion).toBe("hraness-support-result-v1");
  } finally { f.close(); }
});
test("explicit support addition leaves ordinary audit JSON and no-write behavior intact", () => {
  const f = fixture();
  try {
    const audit = resolve(skill, "scripts/audit.mjs");
    const result = spawnSync(process.execPath, [audit, "--root", skill, "--json"], { cwd: f.root, env: f.env, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    expect(result.status).toBe(0); expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout); expect(report.operation).toBe("audit"); expect(report.changed).toBe(false);
    expect(report.skills).toHaveLength(1); expect(readdirSync(f.root)).toEqual(["copied skill"]);
  } finally { f.close(); }
});
