# Agent Code Structure Refactor Design

> Historical note: this document predates the strict CLI split. Current public entrypoints are `npm run wiki-agent`, `npm run wiki-agent:rpc`, `npm run design-agent`, and `npm run design-agent:rpc`; `npm run agent` and `npm run agent:rpc` are intentionally absent.

## Purpose

Refactor the local agent runtime code with behavior-preserving structural changes. The current implementation has two large coordination files:

- `src/pi-agent.ts` owns prompts, CLI parsing, RPC mode, REPL output formatting, session control, worker routing, tool-loop limiting, transient retry, runtime tool creation, and public exports.
- `src/agent/tools.ts` owns tool schemas, workspace file helpers, paper download/read/wiki/research/design tool construction, profile selection, and worker boundary filtering.

The immediate goal is to reduce cognitive load and make future agent changes safer without changing user-visible behavior.

## Non-Goals

This refactor will not:

- Remove or rename tools.
- Change the `default` and `full` tool profile model.
- Change default agent capabilities.
- Change worker routing intent rules.
- Change CLI text output, RPC JSON events, or Feishu bridge protocol.
- Rewrite the tool implementations inside `createTools`.
- Move private knowledge-base or paper-project artifacts into git.

## Design Principles

1. Preserve behavior first. Public exports, tool names, tool ordering, CLI output, RPC event shapes, worker handoff JSON, and test-visible details remain compatible.
2. Split by runtime responsibility, not by arbitrary line count.
3. Keep `src/pi-agent.ts` as a compatibility facade and executable entrypoint.
4. Extract the lowest-risk parts of `src/agent/tools.ts` first. Tool implementation bodies stay in place until the runtime split is verified.
5. Use tests as the contract. Every extraction should have targeted tests that fail if import/export compatibility, routing, formatting, or boundary ordering changes.

## Target Module Layout

### `src/pi-agent.ts`

This remains the public entrypoint. It should:

- Re-export existing public runtime APIs used by tests and downstream code.
- Call `main()` when executed directly.
- Contain minimal glue only.

Expected retained exports include the current prompt constants, routing helpers, session functions, REPL formatter, stats helpers, model override helper, and `main`.

### `src/agent/agent-prompts.ts`

Owns system prompt constants:

- `DEFAULT_SYSTEM_PROMPT`
- `PAPER_WRITING_WORKER_SYSTEM_PROMPT`
- `WIKI_EVIDENCE_WORKER_SYSTEM_PROMPT`
- `PAPER_DOWNLOAD_SUBAGENT_SYSTEM_PROMPT`
- `DESIGN_SUBAGENT_SYSTEM_PROMPT`

No behavior should change. The prompt strings are moved verbatim unless TypeScript import paths require formatting-only changes.

### `src/agent/agent-routing.ts`

Owns worker routing and handoff types:

- `RoutedWorkerRole`
- `RoutedWorkerPrompt`
- `WorkerHandoff`
- `parsePaperWritingWorkerCommand`
- `routeChatPromptToWorker`
- worker prompt lookup
- worker handoff path extraction helpers
- worker handoff message creation

The module should not own model calls or tool execution. It should expose pure routing and handoff construction functions so tests can cover it without starting an agent loop.

### `src/agent/agent-runtime.ts`

Owns agent-turn execution:

- LLM message conversion helpers
- transient model retry policy
- tool-loop limiter
- delayed event flushing
- routed worker turn execution
- clean-context wiki evidence worker creation
- runtime tool creation
- `runAgentTurn`
- `runSessionPrompt`

This module may depend on prompts, routing, and tools. It should not parse CLI args or write directly to stdout.

### `src/agent/agent-cli.ts`

Owns process-facing runtime behavior:

- `CliArgs`
- `parseCliArgs`
- `applyModelBaseUrlOverride`
- RPC command parsing and `runRpcMode`
- REPL event formatting
- interactive prompt reading
- stdin line consumption
- chat session stats
- `main`

This module may write to provided streams or `process.stdout` inside `main`, but reusable functions should accept stream parameters as they do today.

### `src/agent/tool-boundaries.ts`

Owns the small, low-risk tool profile and boundary definitions:

- `ToolProfile`
- `ToolBoundaryRole`
- tool-name union or equivalent internal type
- `TOOL_BOUNDARY_NAMES`
- `getToolBoundaryToolNames`

`src/agent/tools.ts` continues to own `createTools` and `createToolsForBoundary`, importing the boundary metadata from this module.

## Data and Control Flow

1. CLI entry calls `main()` from `agent-cli`.
2. `main()` resolves the model, creates context, creates REPL/RPC handlers, and delegates prompts to `runSessionPrompt`.
3. `runSessionPrompt` handles empty/exit prompts, routes high-confidence worker prompts, or delegates to `runAgentTurn`.
4. `runAgentTurn` creates or reuses runtime tools, applies retry/tool-loop policies, and persists only successful turns.
5. Worker turns use `createToolsForBoundary`, run in a clean context, and return a compact handoff message to the main context.
6. Tool boundary names are resolved from `tool-boundaries`, while actual tool construction stays in `tools.ts`.

## Compatibility Requirements

The refactor must preserve:

- `npm run agent` behavior.
- `npm run agent:rpc` behavior.
- Public exports currently asserted by `test/index.test.ts` and `test/agent/pi-agent.test.ts`.
- The exact two-profile model: `default` and `full`.
- The default tool set and full tool set contents and ordering.
- `createToolsForBoundary(...).map(tool => tool.name)` matching `getToolBoundaryToolNames(role)`.
- Worker routing decisions for explicit and intent-based prompts.
- Worker handoff JSON fields and path extraction behavior.
- REPL output formatting, including `[tool:start]` path details and terse `[tool:end]` lines.
- Session stats summary format.

## Testing Plan

The implementation should follow red-green-refactor:

1. Add or adjust tests that assert `src/pi-agent.ts` remains a compatibility facade for public exports after extraction.
2. Add targeted routing tests if current coverage is not isolated enough for `agent-routing`.
3. Add targeted boundary tests if moving profile metadata changes import ownership.
4. Run focused tests after each extraction:
   - `rtk npm test -- --test-name-pattern "runSessionPrompt|routeChatPromptToWorker|createReplEventHandler|createTools exposes|createToolsForBoundary"`
5. Run full verification:
   - `rtk npm test`

If the full suite fails due to a sandbox-only localhost binding restriction, report the exact failure and run the affected focused suites that do not require blocked network binding.

## Implementation Sequence

1. Strengthen tests around facade exports and tool boundary exports.
2. Extract prompt constants into `agent-prompts.ts`; re-export from `pi-agent.ts`.
3. Extract pure routing and handoff helpers into `agent-routing.ts`; re-export compatibility APIs.
4. Extract tool boundary metadata into `tool-boundaries.ts`; keep `createTools` in `tools.ts`.
5. Extract runtime loop/session logic into `agent-runtime.ts`.
6. Extract CLI/RPC/REPL/stats logic into `agent-cli.ts`.
7. Reduce `src/pi-agent.ts` to imports, exports, and direct-execution glue.
8. Run full verification and inspect git diff for accidental behavior changes.

## Risks and Mitigations

- Circular imports between CLI, runtime, routing, and prompts.
  - Mitigation: keep dependencies one-directional: CLI -> runtime -> routing/prompts/tools.
- Breaking public imports from `src/pi-agent.ts`.
  - Mitigation: facade re-exports plus explicit tests.
- Subtle worker handoff changes.
  - Mitigation: keep handoff JSON construction tested through existing `runSessionPrompt` coverage and add pure helper tests where useful.
- Tool ordering drift.
  - Mitigation: keep boundary and profile order assertions.
- Large mechanical diff hiding behavior changes.
  - Mitigation: move one responsibility at a time and run focused tests between moves.

## Acceptance Criteria

The refactor is complete when:

- `src/pi-agent.ts` is a thin entrypoint/facade instead of a multi-responsibility runtime file.
- `src/agent/tools.ts` imports tool boundary/profile metadata from a dedicated module.
- No agent feature, tool name, profile, route, CLI output, or RPC event shape intentionally changes.
- Targeted tests pass.
- `rtk npm test` passes, or any environment-only blocker is documented with focused passing evidence.
