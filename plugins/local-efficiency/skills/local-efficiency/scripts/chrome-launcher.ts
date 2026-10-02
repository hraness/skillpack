import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const provisioningHelp = "configure Chrome for Testing or the project's pinned Playwright Chromium "
  + "with HRA_CHROME_REAL or agent-browser's executablePath; system Google Chrome is never a fallback";

function configured(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function isSystemChrome(path: string): boolean {
  return path.split(sep).some((part) => /^Google Chrome(?: Beta| Dev| Canary)?\.app$/iu.test(part))
    || /(?:^|[\\/])Google Chrome$/iu.test(path);
}

/** Resolve aliases before execution so renaming a symlink cannot select system Chrome. */
export function validateChromeExecutable(path: string, cwd = process.cwd(), launcher?: string): string {
  if (/[\x00-\x1f\x7f]/u.test(path)) throw new Error("browser executable contains control characters");
  const candidate = resolve(cwd, path);
  if (isSystemChrome(candidate)) throw new Error(`refusing system Google Chrome; ${provisioningHelp}`);
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
    if (!statSync(canonical).isFile()) throw new Error("not a regular file");
    accessSync(canonical, constants.X_OK);
  } catch {
    throw new Error(`browser executable is unavailable: ${candidate}; ${provisioningHelp}`);
  }
  if (isSystemChrome(canonical)) throw new Error(`refusing system Google Chrome; ${provisioningHelp}`);
  if (launcher !== undefined && canonical === realpathSync(launcher)) {
    throw new Error(`browser executable resolves to hra-chrome itself; ${provisioningHelp}`);
  }
  return canonical;
}

export function isChromeLauncher(path: string, launcher: string, cwd = process.cwd()): boolean {
  try {
    return realpathSync(resolve(cwd, path)) === realpathSync(launcher);
  } catch {
    return false;
  }
}

function configExecutable(path: string, required: boolean): string | undefined {
  let contents: string;
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("invalid config file");
    contents = readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read browser config: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`invalid JSON in browser config: ${path}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`browser config must be an object: ${path}`);
  }
  const value = (parsed as Record<string, unknown>).executablePath;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new Error(`invalid executablePath in browser config: ${path}`);
  return value;
}

/** Read only the executable choice; agent-browser still owns its other config fields. */
export function resolveChromeExecutable(options: {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly cwd?: string;
  readonly userHome?: string;
  readonly launcher: string;
}): string {
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const userHome = options.userHome ?? homedir();
  let choice: string | undefined = environment.HRA_CHROME_REAL;
  if (!configured(choice)) {
    const agentChoice = environment.AGENT_BROWSER_EXECUTABLE_PATH;
    if (configured(agentChoice) && !isChromeLauncher(agentChoice, options.launcher, cwd)) choice = agentChoice;
  }
  if (!configured(choice)) {
    const explicitConfig = environment.AGENT_BROWSER_CONFIG;
    if (configured(explicitConfig)) {
      choice = configExecutable(resolve(cwd, explicitConfig), true);
    } else {
      // agent-browser layers ./agent-browser.json over ~/.agent-browser/config.json.
      const globalChoice = configExecutable(join(userHome, ".agent-browser", "config.json"), false);
      choice = configExecutable(join(cwd, "agent-browser.json"), false) ?? globalChoice;
    }
  }
  if (!configured(choice)) throw new Error(`no provisioned browser executable selected; ${provisioningHelp}`);
  return validateChromeExecutable(choice, cwd, options.launcher);
}

/** Chromium uses the last switch of a given name: combine all feature values once. */
export function chromeArguments(arguments_: readonly string[]): string[] {
  const features = new Set<string>();
  const retained: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument === "--") {
      retained.push(...arguments_.slice(index));
      break;
    }
    let featureValue: string | undefined;
    if (argument.startsWith("--disable-features=")) {
      featureValue = argument.slice("--disable-features=".length);
    } else if (argument === "--disable-features") {
      featureValue = arguments_[++index];
      if (featureValue === undefined || featureValue.startsWith("--")) {
        throw new Error("--disable-features requires a comma-separated value");
      }
    } else if (argument === "--mute-audio" || argument.startsWith("--mute-audio=")) {
      continue;
    } else {
      retained.push(argument);
    }
    for (const feature of featureValue?.split(",") ?? []) {
      if (feature !== "") features.add(feature);
    }
  }
  features.add("PaintHolding");
  features.add("MacAppCodeSignClone");
  return [`--disable-features=${[...features].join(",")}`, "--mute-audio", ...retained];
}

/** The parent shell performs exec so browser pipes above stderr remain open. */
export function chromeExecCommand(launcher: string, arguments_: readonly string[]): string {
  const executable = resolveChromeExecutable({ launcher });
  const quote = (value: string) => {
    if (value.includes("\0")) throw new Error("browser argument contains NUL");
    return "'" + value.replaceAll("'", "'\\''") + "'";
  };
  return "exec " + [executable, ...chromeArguments(arguments_)].map(quote).join(" ");
}
