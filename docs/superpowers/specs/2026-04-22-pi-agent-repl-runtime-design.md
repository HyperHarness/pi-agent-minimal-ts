# Pi Agent REPL Runtime Refactor Design

**Date:** 2026-04-22

## Goal

Make the current terminal REPL easier to develop, automate, and test without turning it into a Codex-dependent tool.

The refactor must:
- keep `npm run agent` as a standalone local agent entrypoint
- preserve the current provider/model selection behavior
- allow the conversation loop to be driven without a live terminal
- handle interactive exit and stdin EOF cleanly

## Chosen Approach

Split the current `pi-agent.ts` responsibilities into a small runtime layer and a thin CLI shell.

The runtime layer will own:
- model execution for one turn
- session context and message accumulation
- prompt processing independent of `readline`

The CLI shell will own:
- argument parsing
- startup model resolution
- choosing interactive or non-interactive input mode
- writing terminal-oriented output

This keeps the agent independently runnable while making the prompt loop directly testable.

## Architecture

### Runtime

Add a small session-oriented API on top of `runAgentTurn`.

Responsibilities:
- hold `AgentContext`
- accept prompts one at a time
- skip empty prompts
- stop on `exit` or `quit`
- return a status that tells the caller whether to continue or stop

The runtime must not depend on `process.stdin`, `process.stdout`, or `readline`.

### Prompt Sources

Support two prompt sources:
- interactive REPL input from `readline.question("> ")`
- non-interactive line input from `stdin`

Non-interactive mode is selected when stdin is not a TTY. Each non-empty input line is treated as one prompt. EOF ends the session without error.

### CLI Shell

`main()` becomes an orchestration layer:
1. parse CLI arguments
2. resolve the runtime model
3. create session context
4. choose prompt source based on stdin TTY state
5. pass prompts to the runtime
6. render assistant and tool events

## Behavior

### Interactive Mode

- Startup still prints the selected model
- Prompt stays `> `
- `exit` and `quit` end the session normally
- closing stdin or receiving a closed-readline condition exits quietly instead of throwing `ERR_USE_AFTER_CLOSE`

### Non-Interactive Mode

- the agent reads prompts line-by-line from stdin
- each non-empty line runs one turn
- tool and assistant output continue to stream to stdout
- EOF ends the process with exit code 0 unless a real error occurred

## Testing Strategy

Extend `test/agent/pi-agent.test.ts` to cover the new boundaries without requiring a spawned terminal process.

Tests should verify:
1. a session controller treats `exit` and `quit` as stop commands
2. empty prompts do not trigger model execution
3. stdin-closure handling exits normally instead of surfacing `ERR_USE_AFTER_CLOSE`
4. non-interactive prompt consumption can process multiple lines through the same session context

Existing faux-provider tests for `runAgentTurn` remain the integration check for model/tool execution.

## File Layout

- `src/pi-agent.ts`: exported runtime helpers plus CLI shell
- `test/agent/pi-agent.test.ts`: session and prompt-loop tests

No new package dependencies are required.

## Non-Goals

- no new tool types
- no persistent chat history
- no batch file format or JSON protocol
- no TUI or command palette
- no provider-specific behavior changes
