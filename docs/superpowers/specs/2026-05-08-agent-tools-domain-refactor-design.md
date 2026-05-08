# Agent Tools Domain Refactor Design

## Purpose

Continue the agent code simplification by splitting `src/agent/tools.ts` into smaller tool-domain modules while preserving behavior. The previous refactor moved prompts, routing, runtime, CLI code, and tool boundary metadata out of the public entrypoint. `tools.ts` is now the largest remaining coordination file, with about four thousand lines covering schemas, workspace file helpers, paper acquisition tools, reading tools, wiki tools, research workflow tools, local-library tools, health tools, and final tool assembly.

The goal of this pass is to reduce the size and mixed responsibility of `tools.ts` without changing tool names, profiles, boundary behavior, dependency injection, or user-visible output.

## Non-Goals

This refactor will not:

- Rename, remove, or reorder tools.
- Change `default` or `full` profile membership.
- Change worker boundary tool lists.
- Change paper download, parsing, wiki, research, or health behavior.
- Refactor `paper-manager.ts`, `paper-store.ts`, or publisher-specific download logic.
- Change CLI/RPC formatting, tool progress events, or public exports from `src/pi-agent.ts`.

## Design Principles

1. Preserve contracts first. `createTools()` and `createToolsForBoundary()` remain the public construction APIs.
2. Split by tool domain, not by arbitrary line count.
3. Keep tool implementations close to the schemas and dependency types they use.
4. Keep shared helper extraction conservative. If a helper is only used by one domain, it should stay in that domain module.
5. Move one domain at a time with focused tests after each move.

## Target Module Layout

### `src/agent/tools.ts`

This remains the compatibility assembly module. It should:

- Export `createTools`, `createToolsForBoundary`, `getToolBoundaryToolNames`, `TOOL_BOUNDARY_NAMES`, `ToolBoundaryRole`, and `ToolProfile`.
- Own only cross-domain dependency typing, profile assembly, boundary filtering, and compatibility re-exports.
- Import domain tool factory functions and concatenate their returned tools in the existing order.

### `src/agent/tool-types.ts`

Owns shared tool construction types that multiple domains need:

- `CreateToolsDependencies`
- common tool result or progress callback aliases if they are currently local to `tools.ts`
- shared factory input types needed by domain modules

This module should not construct tools.

### `src/agent/file-tools.ts`

Owns workspace and manuscript file tools:

- `get_time`
- `load_paper_writing_skill`
- `read_file`
- `list_files`
- `write_file`
- `replace_file_text`
- `delete_file`
- `compile_latex`
- related path safety and subprocess helpers

These are relatively self-contained and are a low-risk first extraction.

### `src/agent/web-tools.ts`

Owns general web access tools:

- `web_search`
- `fetch_url`
- `fetch_paper_webpage`

Paper webpage fetching stays here because it is a fetch/read capability exposed as a tool, not the paper download manager itself.

### `src/agent/paper-tools.ts`

Owns acquisition and reading tools:

- `search_papers`
- `download_paper`
- `block_paper_download`
- `register_manual_paper_download`
- `open_paper_page_for_login`
- `parse_paper`
- `inspect_paper`
- `read_paper_section`
- `search_paper_text`

This module delegates to existing paper manager, reader, browser, and store modules. It does not move manager logic.

### `src/agent/wiki-tools.ts`

Owns paper wiki and research synthesis tools:

- `write_paper_wiki_source`
- `generate_paper_wiki_summary`
- `paper_wiki_relations`
- `search_paper_wiki`
- `answer_paper_wiki_question`
- `answer_research_question`
- `bootstrap_wiki_page_evidence`
- `build_wiki_page`
- `merge_wiki_aliases`
- `clarify_research_topic`
- `research_topic_bootstrap`
- `expand_research_topic`
- `wiki_lint`

This is the largest logical domain and should be moved after smaller domains are green.

### `src/agent/library-health-tools.ts`

Owns local library and maintenance tools:

- `list_local_papers`
- `search_local_papers`
- `wiki_health`
- `wiki_health_fix`

These depend on local library, wiki health, download worker, and summary worker APIs, but they are operational maintenance tools rather than synthesis tools.

### `src/agent/design-tools.ts`

Owns design artifact writing:

- `write_design_artifact`

This keeps the non-paper design record capability separate from paper/wiki domains.

## Data and Control Flow

1. `createTools(workspaceDir, dependencies)` in `tools.ts` normalizes dependencies and asks each domain module to create its own tools.
2. Domain factories receive the same workspace directory and dependency object shape as today.
3. `tools.ts` concatenates domain arrays in the current order and applies the existing non-enumerable metadata properties.
4. Profile filtering remains in `tools.ts`.
5. `createToolsForBoundary()` continues to build the full base tool list and filter by `TOOL_BOUNDARY_NAMES`.

## Compatibility Requirements

The refactor must preserve:

- Every tool name and description unless a moved string requires formatting-only changes.
- Tool parameter schemas and defaults.
- Tool array ordering from `createTools()` for both `default` and `full` profiles.
- `createToolsForBoundary(...).map(tool => tool.name)` for each boundary role.
- Optional dependency behavior for paper summary worker, wiki page worker, download worker, extension bridge, browser manager, and browser session factory.
- Existing public imports from `src/agent/tools.ts` and `src/pi-agent.ts`.
- Existing tests that inspect tool metadata, profiles, and boundary names.

## Testing Plan

Use the existing tests as the behavior contract and add targeted checks only where the split creates a new risk:

1. Add or strengthen tests that snapshot the ordered tool names for `default` and `full`.
2. Add or strengthen tests that each boundary role has the same ordered tool names as `getToolBoundaryToolNames(role)`.
3. After each domain move, run:
   - `rtk npm test -- --test-name-pattern "createTools exposes|createToolsForBoundary|public entrypoint re-exports"`
4. After all moves, run:
   - `rtk npm test`
   - `git diff --check`

## Implementation Sequence

1. Strengthen tool-order and boundary tests before moving code.
2. Extract shared dependency and factory types into `tool-types.ts`.
3. Extract file/workspace tools into `file-tools.ts`.
4. Extract web tools into `web-tools.ts`.
5. Extract paper acquisition and reading tools into `paper-tools.ts`.
6. Extract design artifact tool into `design-tools.ts`.
7. Extract local library and wiki health tools into `library-health-tools.ts`.
8. Extract wiki and research tools into `wiki-tools.ts`.
9. Reduce `tools.ts` to assembly, profile selection, boundary filtering, and compatibility exports.
10. Run full verification and inspect the diff for accidental behavior changes.

## Risks and Mitigations

- Circular imports between domain modules and `tools.ts`.
  - Mitigation: shared types live in `tool-types.ts`; domain modules do not import `tools.ts`.
- Tool ordering drift.
  - Mitigation: add ordered tool-name tests before extraction.
- Dependency injection drift.
  - Mitigation: keep a single shared dependency type and pass it unchanged to each domain.
- Large wiki/research move hiding behavior changes.
  - Mitigation: move wiki/research last, after smaller domains prove the pattern.
- Accidental public API expansion or shrinkage.
  - Mitigation: keep exports explicit and run public entrypoint tests.

## Acceptance Criteria

This refactor is complete when:

- `src/agent/tools.ts` is an assembly facade rather than the owner of every tool implementation.
- Tool domain modules own their own schemas and execution bodies.
- Public construction APIs and boundary/profile behavior are unchanged.
- Focused tool tests pass after each extraction.
- Full `rtk npm test` and `git diff --check` pass before merge or push.
