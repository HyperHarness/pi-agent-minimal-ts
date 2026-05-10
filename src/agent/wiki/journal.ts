import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiOperationJournalPath,
  relativeToWorkspace
} from "./store.js";

export type WikiOperationIntent =
  | "write_source_summary"
  | "write_wiki_page"
  | "merge_aliases"
  | "rebuild_index"
  | "repair";

export type WikiOperationOwner =
  | "wiki-agent"
  | "wiki-evidence-worker"
  | "paper-download-subagent";

export interface WikiOperationBeginEvent {
  schemaVersion: 1;
  operationId: string;
  phase: "begin";
  intent: WikiOperationIntent;
  owner: WikiOperationOwner;
  startedAt: string;
  plannedFiles: string[];
  inputs?: unknown;
}

export interface WikiOperationCompleteEvent {
  schemaVersion: 1;
  operationId: string;
  phase: "complete";
  completedAt: string;
  writtenFiles: string[];
}

export type WikiOperationEvent = WikiOperationBeginEvent | WikiOperationCompleteEvent;

export interface WikiOperationHandle {
  operationId: string;
  journalPath: string;
}

function createOperationId(intent: string): string {
  return `${intent}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function appendJournalEvent(workspaceDir: string, event: WikiOperationEvent): Promise<string> {
  const journalPath = getPaperWikiOperationJournalPath(workspaceDir);
  await mkdir(path.dirname(journalPath), { recursive: true });
  await appendFile(journalPath, `${JSON.stringify(event)}\n`, "utf8");
  return relativeToWorkspace(workspaceDir, journalPath);
}

export async function beginWikiOperation(input: {
  workspaceDir: string;
  intent: WikiOperationIntent;
  owner: WikiOperationOwner;
  plannedFiles: string[];
  inputs?: unknown;
}): Promise<WikiOperationHandle> {
  const operationId = createOperationId(input.intent);
  const journalPath = await appendJournalEvent(input.workspaceDir, {
    schemaVersion: 1,
    operationId,
    phase: "begin",
    intent: input.intent,
    owner: input.owner,
    startedAt: new Date().toISOString(),
    plannedFiles: input.plannedFiles,
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {})
  });
  return { operationId, journalPath };
}

export async function completeWikiOperation(input: {
  workspaceDir: string;
  operationId: string;
  writtenFiles: string[];
}): Promise<void> {
  await appendJournalEvent(input.workspaceDir, {
    schemaVersion: 1,
    operationId: input.operationId,
    phase: "complete",
    completedAt: new Date().toISOString(),
    writtenFiles: input.writtenFiles
  });
}
