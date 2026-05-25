import process from "node:process";
import { pathToFileURL } from "node:url";
import { main as runAgentCli } from "./agent/agent-cli.js";

export async function main(options: { argv?: string[] } = {}): Promise<void> {
  await runAgentCli({
    argv: options.argv,
    profile: "design-agent"
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
