# Minimal Pi Agent Design

**Date:** 2026-04-21

## Goal

Build a minimal, runnable TypeScript agent script based on `pi-mono` using `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`.

The script must:
- run as a local Node.js program
- support multi-turn conversation in a single process
- support real tool calling
- work with mainstream LLM providers through `pi-ai`

## Chosen Approach

Use `@mariozechner/pi-agent-core` for the agent loop and tool execution workflow, and use `@mariozechner/pi-ai` for model/provider compatibility and authentication lookup.

The project will implement a thin resolver layer that mirrors the `pi` coding agent's selection behavior where practical:
- rely on `pi-ai` for provider compatibility, model catalog access, and environment-based API key lookup
- do not reimplement provider-specific API handling
- add only a small local resolver for initial provider/model selection

## Architecture

The implementation will stay intentionally small and centered around one executable script plus a few focused helpers.

Core flow:
1. Start the script.
2. Resolve the target model from CLI flags or environment variables.
3. Build agent state with system prompt, tools, selected model, and empty message history.
4. Enter a readline-based REPL.
5. For each user input, append a user message and run the agent.
6. Stream assistant text and tool lifecycle events to stdout.
7. Preserve conversation state in memory until the process exits.

## Provider And Model Resolution

`pi-ai` provides:
- the provider and model registry
- provider-specific compatibility behavior
- environment-based API key lookup during request execution

`pi-ai` does not expose a single public API that automatically chooses the initial provider and model for this script, so the project will add a thin resolver that follows the `pi` coding agent's semantics as closely as possible.

Resolution order:
1. Explicit CLI flags
2. Explicit environment variables for model selection
3. First available model with configured auth, preferring known provider defaults where possible

The resolver will fail clearly when no usable model can be selected.

## Tools

The minimal tool set will include:

### `get_time`

Purpose:
- prove real tool calling works across providers

Behavior:
- returns the current local time
- optionally accepts a timezone string

### `read_file`

Purpose:
- demonstrate a practical local tool

Behavior:
- accepts a relative file path
- resolves it against the current working directory
- rejects paths outside the working directory
- returns UTF-8 text content

## Session Behavior

Conversation state is in-memory only.

The script will:
- maintain prior user, assistant, and tool-result messages in the current process
- support repeated prompts in one session
- end the session on process exit

No persistence or resume support is included in this minimal version.

## Output Behavior

The script will print:
- streamed assistant text as it arrives
- compact tool execution start/end messages
- clear startup failures for model resolution or missing auth

The output will stay terminal-friendly and minimal.

## Error Handling

### Startup errors

Fail fast when:
- no provider/model can be resolved
- required provider credentials are missing
- an unsupported provider or model is requested

### Tool errors

Tool failures will throw normally and be handed back through `pi-agent-core` so the model can observe the tool error and recover if possible.

## File Layout

- `src/pi-agent.ts`: executable REPL script
- `src/agent/model-resolver.ts`: thin model selection helper
- `src/agent/tools.ts`: tool definitions
- `src/index.ts`: shared exports if needed
- `test/agent/model-resolver.test.ts`: resolver tests
- `test/agent/tools.test.ts`: tool safety tests
- `test/agent/pi-agent.test.ts`: faux-provider integration test for the agent loop

## Testing Strategy

Tests will cover:
- resolver behavior for explicit and fallback model selection
- `read_file` path safety and valid reads
- one complete agent loop using the faux provider from `pi-ai`

The faux-provider test will verify:
1. assistant emits a tool call
2. the tool executes
3. the tool result is appended
4. the assistant produces a final response

## Non-Goals

- no TUI
- no session persistence
- no write-file tool
- no sandbox or permission UI
- no plugin system
- no production-hardening beyond minimal safe path checks
