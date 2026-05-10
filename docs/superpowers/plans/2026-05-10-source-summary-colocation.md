# Source Summary Colocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store paper source summaries as `knowledge-base/sources/<paperKey>/summary.md` beside the paper's acquisition, source metadata, parse, and chunk artifacts.

**Architecture:** Make the existing wiki source-summary helper return the colocated path, then update scanners that infer `paperKey` from summary paths. Keep one canonical layout and do not support the old top-level `sources/<paperKey>.md` summary files.

**Tech Stack:** TypeScript, Node.js built-in test runner, existing paper wiki storage helpers.

---

### Task 1: Lock New Source Summary Path With Tests

**Files:**
- Modify: `test/agent/paper-reader.test.ts`
- Modify: `test/agent/local-paper-library.test.ts`

- [ ] Add a test that `writePaperWikiSource` returns and writes `knowledge-base/sources/<paperKey>/summary.md`.
- [ ] Add a test that local paper listing reads titles from `summary.md`.
- [ ] Run the focused compiled tests and confirm they fail because implementation still uses `sources/<paperKey>.md`.

### Task 2: Switch Source Summary Helpers And Scanners

**Files:**
- Modify: `src/agent/wiki/store.ts`
- Modify: `src/agent/wiki/content.ts`
- Modify: `src/agent/wiki/bootstrap.ts`
- Modify: `src/agent/wiki/maintenance.ts`
- Modify: `src/agent/paper/storage/local-paper-library.ts`

- [ ] Change `getPaperWikiSourcePath()` to return `sources/<paperKey>/summary.md`.
- [ ] Change `listPaperWikiSourceFiles()` to scan one directory level down for `summary.md`.
- [ ] Update source-summary paper key inference from `basename(file, ".md")` to parent directory basename.
- [ ] Run focused tests and confirm the new tests pass.

### Task 3: Update Documentation And Fixtures

**Files:**
- Modify: `README.md`
- Modify: docs and tests with canonical `knowledge-base/sources/<paperKey>/summary.md` expectations

- [ ] Replace canonical source-summary docs and test expectations with `knowledge-base/sources/<paperKey>/summary.md`.
- [ ] Keep acquisition and parse artifact paths unchanged.
- [ ] Run `rg "knowledge-base/sources/[^/[:space:]]+\\.md|sources/<paper-key>\\.md|sources/\\*\\.md"` and review remaining matches.

### Task 4: Migrate Local Ignored Knowledge Base Data

**Files:**
- Move ignored local files under `knowledge-base/sources/`

- [ ] Move every top-level source summary file to `knowledge-base/sources/<paperKey>/summary.md`.
- [ ] If the directory already exists, place the summary inside it; if not, create it.
- [ ] Confirm no top-level source summary markdown files remain.

### Task 5: Verify

**Commands:**
- `npm run build`
- Focused compiled tests for paper reader, local paper library, wiki maintenance, tools, and health.
- `npm test`
- `git diff --check`

- [ ] Run all verification commands and read outputs before reporting completion.
