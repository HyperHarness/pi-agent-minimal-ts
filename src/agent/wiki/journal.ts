import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  getPaperWikiOperationJournalPath,
  relativeToWorkspace
} from "./store.js";

export type WikiOperationIntent =
  | "write_source_summary"
  | "write_synthesis_page"
  | "delete_synthesis_page"
  | "merge_aliases"
  | "apply_structure_plan"
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

function isWikiOperationIntent(value: unknown): value is WikiOperationIntent {
  return value === "write_source_summary" ||
    value === "write_synthesis_page" ||
    value === "delete_synthesis_page" ||
    value === "merge_aliases" ||
    value === "apply_structure_plan" ||
    value === "rebuild_index" ||
    value === "repair";
}

function isWikiOperationOwner(value: unknown): value is WikiOperationOwner {
  return value === "wiki-agent" ||
    value === "wiki-evidence-worker" ||
    value === "paper-download-subagent";
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function normalizeWikiOperationEvent(value: unknown): WikiOperationEvent | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.operationId !== "string") {
    return undefined;
  }
  if (record.phase === "begin") {
    const plannedFiles = stringArray(record.plannedFiles);
    if (
      !isWikiOperationIntent(record.intent) ||
      !isWikiOperationOwner(record.owner) ||
      typeof record.startedAt !== "string" ||
      !plannedFiles
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      operationId: record.operationId,
      phase: "begin",
      intent: record.intent,
      owner: record.owner,
      startedAt: record.startedAt,
      plannedFiles,
      ...(record.inputs !== undefined ? { inputs: record.inputs } : {})
    };
  }
  if (record.phase === "complete") {
    const writtenFiles = stringArray(record.writtenFiles);
    if (typeof record.completedAt !== "string" || !writtenFiles) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      operationId: record.operationId,
      phase: "complete",
      completedAt: record.completedAt,
      writtenFiles
    };
  }
  return undefined;
}

export async function readWikiOperationEvents(workspaceDir: string): Promise<WikiOperationEvent[]> {
  const journalPath = getPaperWikiOperationJournalPath(workspaceDir);
  const raw = await readFile(journalPath, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const events: WikiOperationEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = normalizeWikiOperationEvent(JSON.parse(trimmed));
      if (parsed) {
        events.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return events;
}
