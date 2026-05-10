import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  resolveWikiWorkspaceContract,
  wikiPathForLifecycle,
  type WikiLifecycleKind
} from "../../src/agent/wiki/workspace-contract.js";

test("resolveWikiWorkspaceContract exposes stable lifecycle roots", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-contract-"));
  try {
    const contract = resolveWikiWorkspaceContract(workspace);
    assert.equal(contract.schemaVersion, 1);
    assert.equal(contract.workspaceDir, workspace);
    assert.equal(contract.rootRelativePath, "knowledge-base");
    assert.equal(contract.roots.rawInputs.relativePath, "knowledge-base/raw/pdfs");
    assert.equal(contract.roots.sourceRecords.relativePath, "knowledge-base/sources");
    assert.equal(contract.roots.parseArtifacts.relativePath, "knowledge-base/sources");
    assert.equal(contract.roots.sourceSummaries.relativePath, "knowledge-base/sources");
    assert.equal(contract.roots.synthesisPages.relativePath, "knowledge-base/pages");
    assert.equal(contract.roots.assets.relativePath, "knowledge-base/assets");
    assert.equal(contract.roots.manifests.relativePath, "knowledge-base/manifests");
    assert.equal(contract.roots.runtimeState.relativePath, "knowledge-base/state");
    assert.equal(contract.files.index.relativePath, "knowledge-base/index.md");
    assert.equal(contract.files.humanLog.relativePath, "knowledge-base/log.md");
    assert.equal(contract.files.operationJournal.relativePath, "knowledge-base/state/wiki-operations.jsonl");

    const lifecycle: WikiLifecycleKind = "manifests";
    assert.equal(
      wikiPathForLifecycle(contract, lifecycle, "arxiv-2601.00003.json").relativePath,
      "knowledge-base/manifests/arxiv-2601.00003.json"
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resolveWikiWorkspaceContract reports configured external knowledge-base roots", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "wiki-contract-workspace-"));
  const externalParent = await mkdtemp(path.join(tmpdir(), "wiki-contract-external-"));
  const externalKnowledgeBase = path.join(externalParent, "knowledge-base");
  const previousKnowledgeBaseDir = process.env.PI_KNOWLEDGE_BASE_DIR;

  try {
    process.env.PI_KNOWLEDGE_BASE_DIR = externalKnowledgeBase;
    const contract = resolveWikiWorkspaceContract(workspace);
    assert.equal(
      contract.rootRelativePath,
      path.relative(workspace, externalKnowledgeBase).split(path.sep).join("/")
    );
    assert.equal(
      path.relative(externalKnowledgeBase, contract.roots.sourceSummaries.absolutePath),
      "sources"
    );
  } finally {
    if (previousKnowledgeBaseDir === undefined) {
      delete process.env.PI_KNOWLEDGE_BASE_DIR;
    } else {
      process.env.PI_KNOWLEDGE_BASE_DIR = previousKnowledgeBaseDir;
    }
    await rm(workspace, { recursive: true, force: true });
    await rm(externalParent, { recursive: true, force: true });
  }
});
