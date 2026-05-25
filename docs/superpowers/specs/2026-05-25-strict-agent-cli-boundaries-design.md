# Strict Wiki-Agent And Design-Agent CLI Boundaries

## Context

The project currently exposes a general `npm run agent` entrypoint that routes prompts to worker boundaries by explicit prefixes or high-confidence intent detection. That router is useful for compatibility, but it makes the public boundary between wiki work and design/code work too implicit. Design tasks such as dependency declaration, `uv` environment sync, layout-code edits, and verification should be entered through a dedicated design agent instead of inferred from natural language in the main wiki flow.

The target architecture is two strict CLI products in the same repository:

- `wiki-agent`: the Feishu-facing and user-facing knowledge workflow for wiki and paper work.
- `design-agent`: the engineering workflow for chip-design code, dependencies, scripts, verification, and design artifacts.

## Goals

- Remove the ambiguous `npm run agent` public entrypoint.
- Provide explicit CLI and RPC entrypoints for `wiki-agent` and `design-agent`.
- Make the Feishu bridge connect only to `wiki-agent`.
- Keep `wiki-agent` focused on wiki and paper workflows.
- Keep `design-agent` focused on design, code, dependency, layout, and verification workflows.
- Allow `design-agent` to retrieve wiki and paper evidence without allowing it to update wiki pages.
- Let `wiki-agent` update wiki pages and the knowledge base by reading design-agent outputs, not by running design code or managing design dependencies.
- Preserve shared runtime infrastructure where practical so the split does not duplicate model, RPC, event, or config plumbing.

## Non-Goals

- Do not split the repository into multiple npm packages.
- Do not create a separate Feishu bridge for `design-agent`.
- Do not allow `wiki-agent` to install design dependencies, edit layout-code packages, or run design scripts.
- Do not allow `design-agent` to write wiki pages, source summaries, aliases, or paper acquisition records.
- Do not add arbitrary shell access to either agent.
- Do not remove the underlying reusable tool-boundary APIs; tests and internal callers can still use role-specific boundary constructors.

## CLI Contract

The public npm scripts should be:

- `npm run wiki-agent`: interactive/stdin wiki-agent CLI.
- `npm run wiki-agent:rpc`: JSONL RPC wiki-agent CLI for bridge integration.
- `npm run design-agent`: interactive/stdin design-agent CLI.
- `npm run design-agent:rpc`: JSONL RPC design-agent CLI for local testing or future direct integrations.

The old public scripts should be removed:

- `npm run agent`
- `npm run agent:rpc`

If users need compatibility guidance, documentation should point to `wiki-agent` for paper/wiki work and `design-agent` for design/code work.

## Runtime Semantics

`wiki-agent` starts in a wiki/paper system prompt and uses a wiki/paper tool surface. It does not run the generic worker router for design tasks. A design-looking request should be handled as out of scope with a clear instruction to use `design-agent`.

`design-agent` starts directly in `DESIGN_AGENT_SYSTEM_PROMPT` and uses the design-agent tool boundary. It does not enter the generic router and does not receive wiki write tools. It may use read-only retrieval tools for local wiki and paper evidence.

Shared CLI code should handle argument parsing, provider/model resolution, interactive vs stdin mode, RPC framing, session behavior, lifecycle events, and cleanup. The selected entrypoint supplies the fixed agent role and tool surface.

## Feishu Bridge Contract

The Feishu bridge should default to `wiki-agent:rpc`. Bridge configuration examples should no longer point at `npm run agent:rpc`.

Feishu users interact with the durable knowledge workflow. If a Feishu user asks for a design-code action, `wiki-agent` should explain that the task belongs in `design-agent` instead of attempting a design handoff inside the bridge.

## Tool Boundary Contract

`wiki-agent` may expose:

- wiki retrieval, page construction, aliases, health, lint, structure planning, and structure application tools.
- paper search/download/parsing/evidence tools that are already part of the wiki/paper workflow.
- read-only file access needed to inspect design-agent outputs under controlled knowledge-base paths.

`wiki-agent` must not expose:

- `update_design_dependency`
- `sync_design_environment`
- `verify_design_python_import`
- `run_design_script`
- `write_design_code_file`
- `replace_design_code_file_text`

`design-agent` may expose:

- read-only `list_files` and `read_file` access for inspecting design-code and design outputs.
- read-only local wiki and paper retrieval tools such as `answer_paper_wiki_question`, `search_paper_wiki`, `search_local_papers`, and `list_local_papers`.
- design dependency and environment tools.
- scoped design-code file write/replace tools.
- bounded design script execution tools that run only `knowledge-base/design-code/` scripts in a `bwrap` sandbox with an isolated temporary design-code copy and copy back declared design-code outputs.
- design artifact and design record writing tools.

`design-agent` must not expose:

- `build_wiki_page`
- `merge_wiki_aliases`
- `wiki_apply_structure_plan`
- `download_paper`
- `write_paper_wiki_source`
- `generate_paper_wiki_summary`
- arbitrary workspace file writes.

## Collaboration Flow

The agents collaborate through durable files, not implicit runtime routing.

1. `design-agent` reads wiki/paper evidence when it needs design context.
2. `design-agent` updates code under `knowledge-base/design-code/`, manages dependencies through the design `pyproject.toml`, syncs the root `.venv`, runs bounded verification, and writes design records or artifacts.
3. `wiki-agent` later reads those design records/artifacts and decides how to update wiki pages, source manifests, indexes, and knowledge-base summaries.

This keeps design execution auditable and keeps wiki curation under the wiki-agent boundary.

## Error Handling

- Unknown or removed `npm run agent` usage should fail through npm's normal missing-script error; documentation should make the replacement scripts clear.
- `wiki-agent` should decline design/code/dependency execution requests with a short boundary explanation.
- `design-agent` should decline wiki-page update and paper-download requests with a short boundary explanation.
- `design-agent` Python execution should continue to require the repository root `.venv`; missing interpreter errors should direct the agent to `sync_design_environment`.

## Testing

Implementation should include tests that verify:

- `package.json` exposes the new scripts and no longer exposes `agent` or `agent:rpc`.
- Feishu bridge default command points to `wiki-agent:rpc`.
- `wiki-agent` startup does not auto-route design prompts into `design-agent`.
- `wiki-agent` tool surface lacks design dependency, environment, script, and design-code write tools.
- `design-agent` tool surface lacks wiki page write, alias, structure-apply, paper download, and source-summary write tools.
- `design-agent` retains read-only wiki/paper retrieval tools.
- RPC mode still forwards lifecycle events for the Feishu bridge.
- Documentation no longer tells users to run `npm run agent`.

## Migration Notes

Existing internal compatibility aliases such as `design-subagent` can remain for lower-level tests or bridge records where they are already normalized, but they should not be the documented public entrypoint. Public docs should use `design-agent`.

The existing 17 local commits that introduced the standalone design-agent foundation remain valid prerequisites for this split. This spec only changes how users enter the agents and how strict the runtime identity is once the agent starts.
