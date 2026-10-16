import process from "node:process";
import type { DesignScriptExecution } from "./agent/design-script-execution.js";
import { pathToFileURL } from "node:url";
import { main as runAgentCli } from "./agent/agent-cli.js";

export async function main(options: { argv?: string[]; designScriptExecution?: DesignScriptExecution } = {}): Promise<void> {
  await runAgentCli({
    argv: options.argv,
    profile: "design-agent",
    designScriptExecution: options.designScriptExecution
  });
}

function isDirectExecution(metaUrl: string, entryPath: string | undefined): boolean {
  return entryPath !== undefined && metaUrl === pathToFileURL(entryPath).href;
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
