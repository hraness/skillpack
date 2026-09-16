import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runSupportCommand } from "@hraness/support-foundation/node";

const profile = { id: "hraness", name: "Hraness", valueProposition: "Support maintained agent methods and portable skills.", updates: false };
export async function main(args = process.argv.slice(2)) {
  const result = await runSupportCommand(profile, args[0] === "support" ? args.slice(1) : args, { command: [process.execPath, fileURLToPath(import.meta.url)], gitEmail: false });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
  return result.exitCode;
}
function isDirectExecution() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isDirectExecution()) await main();
