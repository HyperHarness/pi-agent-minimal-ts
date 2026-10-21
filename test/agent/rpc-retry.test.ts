import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  Type, fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider,
  type AssistantMessage
} from "@mariozechner/pi-ai";
import { runRpcMode } from "../../src/agent/agent-cli.js";
import { PiRpcClient } from "../../src/feishu-bridge/pi-client.js";

async function runRpcFixture(responses: AssistantMessage[], check: (
  client: PiRpcClient, events: Array<Record<string, unknown>>, resets: string[]
) => Promise<void>): Promise<void> {
  const provider = registerFauxProvider();
  provider.setResponses(responses);
  const input = new PassThrough();
  const output = new PassThrough();
  const events: Array<Record<string, unknown>> = [];
  const resets: string[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) events.push(JSON.parse(line));
  });
  const child = Object.assign(new EventEmitter(), {
    stdout: output,
    stderr: new PassThrough(),
    stdin: {
      write(data: string, callback?: (error?: Error | null) => void) {
        input.end(data);
        callback?.();
        return true;
      }
    },
    kill: () => true
  });
  const server = runRpcMode({
    model: provider.getModel(), workspaceDir: process.cwd(), useSession: false,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    entrypointProfile: {
      systemPrompt: "Test", workerRouting: "none", toolNames: ["checkpoint"],
      createTools: () => Object.assign([{
        name: "checkpoint", label: "Checkpoint", description: "Test checkpoint",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "saved" }], details: {} })
      }], { workspaceDir: process.cwd(), cleanup: async () => {} })
    }
  });
  const client = new PiRpcClient({ command: "fixture", useSession: false }, {
    spawnFn: () => child as never, startupTimeoutMs: 1
  });
  client.on("text_reset", (text: string) => resets.push(text));
  try {
    await client.start();
    await check(client, events, resets);
    await server;
  } finally {
    input.end();
    client.stop();
    await server;
    provider.unregister();
  }
}

test("RPC retries close failed attempts and discard only their partial text", async () => {
  await runRpcFixture([
    fauxAssistantMessage([fauxText("Saved work. "), fauxToolCall("checkpoint", {})], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Discard this partial answer")], { stopReason: "error", errorMessage: "overloaded" }),
    fauxAssistantMessage([fauxText("Final answer.")])
  ], async (client, events, resets) => {
    assert.equal(await client.prompt("Continue"), "Saved work. Final answer.");
    assert.deepEqual(resets, ["Saved work. "]);
    const failedEnd = events.findIndex((event) => event.type === "message_end" && event.willRetry === true);
    assert.ok(failedEnd >= 0);
    assert.equal((events[failedEnd].message as AssistantMessage).stopReason, "error");
    assert.ok(events.slice(failedEnd + 1).some((event) => event.type === "message_start"));
  });
});

test("RPC terminal failures reject the prompt without being treated as retries", async () => {
  await runRpcFixture([
    fauxAssistantMessage([fauxText("Failed partial")], { stopReason: "error", errorMessage: "Invalid request" })
  ], async (client, events, resets) => {
    await assert.rejects(client.prompt("Fail"), /Invalid request/);
    assert.deepEqual(resets, []);
    const failedEnd = events.find((event) => event.type === "message_end");
    assert.ok(failedEnd);
    assert.equal(failedEnd.willRetry, undefined);
  });
});
