# Wiki Duplicate Page Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the wiki-agent identify duplicate concept pages, merge the redundant page into the canonical page, and delete the redundant page through reviewable structure tools.

**Architecture:** Extend `wiki_lint` so deterministic low-risk duplicates such as singular/plural concept pages are identified as targeted `near_duplicate_page` issues. Keep `wiki_structure_plan` as a translator from lint issues into `merge_duplicate_pages` actions with concrete `recommendedArgs`. Extend `wiki_apply_structure_plan` to dry-run and apply those actions by updating canonical aliases, rewriting inbound links, deleting the redundant page, rebuilding the index, logging the operation, and running existing verification.

**Tech Stack:** TypeScript, Node.js test runner, existing wiki maintenance modules, existing markdown/frontmatter helpers, `npm test`.

---

### Task 1: Planner Merge Actions

**Files:**
- Modify: `src/agent/wiki/structure-plan.ts`
- Test: `test/agent/wiki-maintenance.test.ts`

- [ ] Add a failing test where `surface-code.md` and `surface-codes.md` share source evidence and `wiki_lint` returns a low-risk targeted `near_duplicate_page` issue.
- [ ] Add a failing test where `wiki_structure_plan` maps the targeted lint issue to a low-risk `merge_duplicate_pages` action.
- [ ] Implement duplicate merge candidate selection inside `wiki_lint`, not inside `wiki_structure_plan`.
- [ ] Prefer the page with more source citations, longer body, then singular key as canonical.
- [ ] Include `recommendedArgs` with `canonical`, `redundant`, and alias note.

### Task 2: Apply Merge Actions

**Files:**
- Modify: `src/agent/wiki/structure-apply.ts`
- Test: `test/agent/wiki-maintenance.test.ts`

- [ ] Add a failing test where applying a merge action deletes the redundant page and rewrites inbound links.
- [ ] Implement dry-run preflight for safe wiki page targets.
- [ ] Update canonical frontmatter aliases without rewriting page prose.
- [ ] Rewrite markdown links from the redundant page to the canonical page.
- [ ] Delete the redundant page, rebuild index, and append a concise log entry.

### Task 3: Tool Docs

**Files:**
- Modify: `src/agent/wiki/tools.ts`
- Modify: `README.md`
- Test: existing tool adapter tests

- [ ] Update `wiki_apply_structure_plan` tool description to include safe duplicate-page merges.
- [ ] Update README maintenance tool documentation.
- [ ] Run focused tests, build, and full `npm test`.
