import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  analyzeCodexApproval,
  collectCodexApprovalDoctorInput,
  formatCodexApprovalDoctorReport
} from "./agent/codex-approval-doctor.js";

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

export async function main(): Promise<void> {
  const input = await collectCodexApprovalDoctorInput(process.cwd());
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
