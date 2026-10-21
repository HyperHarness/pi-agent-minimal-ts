import test from "node:test";
import assert from "node:assert/strict";
import { registerApiProvider, unregisterApiProviders, createAssistantMessageEventStream, fauxAssistantMessage, fauxText } from "@mariozechner/pi-ai";
import { callLlm } from "../../benchmark/lib.mjs";
import {
  AbandonedTurnError,
  DEFAULT_SETTLE_GRACE_MS,
  runWithTimeout,
  waitForAbort
} from "../../benchmark/timeout.mjs";

// ISSUE #8: timing out an item must cancel the turn and wait for it to settle before
// the runner reuses the tools shared across items. These tests drive the helper that
// benchmark/run.mjs uses for both agent and baseline items.

test("runWithTimeout resolves when the turn settles before the timeout", async () => {
  const result = await runWithTimeout(async () => "answer", 1000);

  assert.equal(result, "answer");
});

test("runWithTimeout hands the turn a live AbortSignal", async () => {
  const signals = [];
  const result = await runWithTimeout(async (signal) => {
    signals.push(signal);
    assert.equal(signal instanceof AbortSignal, true);
    assert.equal(signal.aborted, false);
    return 7;
  }, 1000);

  assert.equal(result, 7);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
});

test("runWithTimeout aborts the turn on timeout and waits for it to settle", async () => {
  const events = [];

  await assert.rejects(
    runWithTimeout(
      async (signal) => {
        events.push("started");
        await waitForAbort(signal);
        events.push("aborted");
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("settled");
        return "late answer";
      },
      10,
      { settleGraceMs: 1000 }
    ),
    /timed out after 10 ms/
  );

  // "settled" proves the helper waited for the aborted turn instead of advancing
  // while it was still running against shared state.
  assert.deepEqual(events, ["started", "aborted", "settled"]);
});

test("runWithTimeout reports the timeout even when the aborted turn fails", async () => {
  await assert.rejects(
    runWithTimeout(
      async (signal) => {
        await waitForAbort(signal);
        throw new Error("turn failed while aborting");
      },
      10,
      { settleGraceMs: 1000 }
    ),
    (error) => {
      assert.equal(error.message, "timed out after 10 ms");
      return true;
    }
  );
});

test("runWithTimeout never leaks the aborted turn rejection as unhandled", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    await assert.rejects(
      runWithTimeout(
        async (signal) => {
          await waitForAbort(signal);
          throw new Error("turn failed after the abort");
        },
        10,
        { settleGraceMs: 1000 }
      ),
      /timed out after 10 ms/
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  assert.deepEqual(unhandled, []);
});

test("runWithTimeout stops with AbandonedTurnError when the turn never settles", async () => {
  const neverSettles = new Promise(() => {});

  await assert.rejects(
    runWithTimeout(() => neverSettles, 10, { settleGraceMs: 30 }),
    (error) => {
      assert.equal(error instanceof AbandonedTurnError, true);
      assert.equal(error.name, "AbandonedTurnError");
      assert.match(error.message, /did not settle within 30 ms/);
      return true;
    }
  );
});

test("the default settle grace is a positive duration", () => {
  assert.equal(Number.isInteger(DEFAULT_SETTLE_GRACE_MS), true);
  assert.ok(DEFAULT_SETTLE_GRACE_MS > 0);
});

test("runWithTimeout surfaces a turn failure that happens before the timeout", async () => {
  await assert.rejects(
    runWithTimeout(async () => {
      throw new Error("turn failed immediately");
    }, 1000),
    /turn failed immediately/
  );
});

test("baseline cancellation waits for the provider request to finish aborting", async () => {
  const events = [];
  const api = "benchmark-abort-regression";
  const stream = (_model, _context, options) => {
    const result = createAssistantMessageEventStream();
    options.signal.addEventListener("abort", () => {
      events.push("abort");
      setTimeout(() => {
        events.push("provider settled");
        result.end(fauxAssistantMessage([fauxText("")], { stopReason: "aborted" }));
      }, 20);
    }, { once: true });
    return result;
  };
  registerApiProvider({ api, stream, streamSimple: stream }, api);
  try {
    await assert.rejects(runWithTimeout(signal => callLlm({ api, provider: api }, {
      user: "test", signal, attempts: 1,
    }), 10, { settleGraceMs: 1000 }), /timed out/);
    assert.deepEqual(events, ["abort", "provider settled"]);
  } finally { unregisterApiProviders(api); }
});
