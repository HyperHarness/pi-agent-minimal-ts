import process from "node:process";
import { pathToFileURL } from "node:url";
import { main } from "./agent/agent-cli.js";

export * from "./agent/agent-prompts.js";
export * from "./agent/agent-routing.js";
export * from "./agent/agent-runtime.js";
export {
  applyModelBaseUrlOverride,
  consumePromptLines,
  createAgentChatSessionStats,
  createReplEventHandler,
  formatAgentChatSessionStats,
  getPendingDownloadQueueCount,
  main,
  parseCliArgs,
  readInteractivePrompt,
  recordAgentChatSessionStats,
  refreshAgentChatSessionDownloadQueue
} from "./agent/agent-cli.js";
export type {
  AgentChatSessionStats,
  CliArgs
} from "./agent/agent-cli.js";

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
