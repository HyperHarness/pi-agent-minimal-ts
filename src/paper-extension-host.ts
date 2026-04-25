import path from "node:path";
import { runPaperExtensionNativeHost } from "./agent/paper-extension-host.js";

const workspaceDir = path.resolve(process.env.PI_PAPER_WORKSPACE ?? process.cwd());

await runPaperExtensionNativeHost({
  workspaceDir,
  stdin: process.stdin,
  stdout: process.stdout
});
