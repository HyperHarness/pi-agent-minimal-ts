import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as publicApi from "../src/index.js";
import {
  applyModelBaseUrlOverride,
  createReplEventHandler,
  DEFAULT_SYSTEM_PROMPT,
  DESIGN_AGENT_SYSTEM_PROMPT,
  DESIGN_SUBAGENT_SYSTEM_PROMPT,
  main,
  PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT,
  PAPER_WRITING_WORKER_SYSTEM_PROMPT,
  parseCliArgs,
  parsePaperWritingWorkerCommand,
  routeChatPromptToWorker,
  runSessionPrompt,
  WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT,
  runAgentTurn
} from "../src/pi-agent.js";
import { resolveInitialModel } from "../src/agent/model-resolver.js";
import { createTools } from "../src/agent/tools.js";

test("public entrypoint re-exports the reusable library APIs", () => {
  assert.equal(publicApi.runAgentTurn, runAgentTurn);
  assert.equal(publicApi.parseCliArgs, parseCliArgs);
  assert.equal(publicApi.applyModelBaseUrlOverride, applyModelBaseUrlOverride);
  assert.equal(publicApi.createReplEventHandler, createReplEventHandler);
  assert.equal(publicApi.main, main);
  assert.equal(publicApi.DEFAULT_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT);
  assert.equal(publicApi.PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT, PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT);
  assert.equal(publicApi.PAPER_WRITING_WORKER_SYSTEM_PROMPT, PAPER_WRITING_WORKER_SYSTEM_PROMPT);
  assert.equal(publicApi.WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT, WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT);
  assert.equal(publicApi.DESIGN_AGENT_SYSTEM_PROMPT, DESIGN_AGENT_SYSTEM_PROMPT);
  assert.equal(publicApi.DESIGN_SUBAGENT_SYSTEM_PROMPT, DESIGN_SUBAGENT_SYSTEM_PROMPT);
  assert.equal(publicApi.DESIGN_SUBAGENT_SYSTEM_PROMPT, publicApi.DESIGN_AGENT_SYSTEM_PROMPT);
  assert.equal(DESIGN_SUBAGENT_SYSTEM_PROMPT, DESIGN_AGENT_SYSTEM_PROMPT);
  assert.equal(publicApi.parsePaperWritingWorkerCommand, parsePaperWritingWorkerCommand);
  assert.equal(publicApi.routeChatPromptToWorker, routeChatPromptToWorker);
  assert.equal(publicApi.runSessionPrompt, runSessionPrompt);
  assert.equal(publicApi.resolveInitialModel, resolveInitialModel);
  assert.equal(publicApi.createTools, createTools);
  assert.equal(typeof publicApi.createPaperBrowserManagerClient, "function");
  assert.equal(typeof publicApi.discoverPaperBrowserManagerMetadata, "function");
  assert.equal(typeof publicApi.readPaperBrowserManagerMetadata, "function");
  assert.equal(typeof publicApi.writePaperBrowserManagerMetadata, "function");
  assert.equal(typeof publicApi.clearPaperBrowserManagerMetadata, "function");
  assert.equal(typeof publicApi.isPaperBrowserManagerMetadataStale, "function");
  assert.equal(typeof publicApi.createPaperBrowserManagerServer, "function");
  assert.equal(typeof publicApi.startPaperBrowserManagerHttpServer, "function");
  assert.equal(typeof publicApi.parsePaper, "function");
  assert.equal(typeof publicApi.inspectPaper, "function");
  assert.equal(typeof publicApi.readPaperSection, "function");
  assert.equal(typeof publicApi.searchPaperText, "function");
  assert.equal(typeof publicApi.evaluateParseQuality, "function");
  assert.equal(typeof publicApi.writePaperWikiSource, "function");
  assert.equal(typeof publicApi.searchPaperWiki, "function");
  assert.equal(typeof publicApi.generatePaperWikiSummary, "function");
  assert.equal(typeof publicApi.paperWikiRelations, "function");
  assert.equal(typeof publicApi.ensurePaperWikiScaffold, "function");
});

test("package.json exposes the library root export for publishing", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    private?: boolean;
    main?: string;
    types?: string;
    files?: string[];
    exports?: {
      "."
        ?: {
            import?: string;
            types?: string;
          };
    };
  };

  assert.equal(packageJson.private, false);
  assert.equal(packageJson.main, "./dist/src/index.js");
  assert.equal(packageJson.types, "./dist/src/index.d.ts");
  assert.deepEqual(packageJson.files, ["dist/src", "README.md"]);
  assert.deepEqual(packageJson.exports?.["."], {
    import: "./dist/src/index.js",
    types: "./dist/src/index.d.ts"
  });
});
