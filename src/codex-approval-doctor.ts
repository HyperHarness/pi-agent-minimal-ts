import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  analyzeCodexApproval,
  appendMissingCodexApprovalRules,
  collectCodexApprovalDoctorInput,
  formatCodexApprovalDoctorReport
} from "./agent/codex-approval-doctor.js";

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

function parseArgs(argv: string[]): { apply: boolean; help: boolean } {
  const parsed = { apply: false, help: false };

  for (const arg of argv) {
    if (arg === "--apply") {
      parsed.apply = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cli = parseArgs(argv);
  if (cli.help) {
    process.stdout.write("Usage: node dist/src/codex-approval-doctor.js [--apply]\n");
    return;
  }

  const input = await collectCodexApprovalDoctorInput(process.cwd());
  if (cli.apply) {
    const patch = await appendMissingCodexApprovalRules(input.codexRulesPath);
    if (patch) {
      process.stdout.write(`Appended missing safe Codex approval rules to ${input.codexRulesPath}:\n${patch}\n\n`);
      const separator = (input.codexRulesText ?? "").trim().length === 0 || input.codexRulesText?.endsWith("\n") ? "" : "\n";
      input.codexRulesText = `${input.codexRulesText ?? ""}${separator}${patch}\n`;
    } else {
      process.stdout.write(`No missing safe Codex approval rules to append in ${input.codexRulesPath}.\n\n`);
    }
  }

  const result = analyzeCodexApproval(input);

  process.stdout.write(`${formatCodexApprovalDoctorReport(result)}\n`);
  process.exitCode = result.status === "error" ? 1 : 0;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
