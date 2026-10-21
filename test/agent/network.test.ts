import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonResponse, readResponseBytes } from "../../src/agent/network.js";

test("bounded reads cancel an oversized declared response before pulling bytes", async () => {
  let pulled = false;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() { pulled = true; }, cancel() { canceled = true; }
  }, { highWaterMark: 0 });
  await assert.rejects(readResponseBytes(new Response(body, { headers: { "content-length": "100" } }), 4), /byte limit/);
  assert.equal(pulled, false);
  assert.equal(canceled, true);
});

for (const length of [undefined, "1"]) {
  test(`bounded reads enforce streamed bytes with content-length ${length ?? "absent"}`, async () => {
    let pulled = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new Uint8Array(3)); },
      cancel() { canceled = true; }
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: length ? { "content-length": length } : {} });
    await assert.rejects(readResponseBytes(response, 4), /byte limit/);
    assert.equal(pulled, 2);
    assert.equal(canceled, true);
    assert.equal(body.locked, false);
  });
}

test("bounded reads accept exact limits and release the reader", async () => {
  const response = new Response("abcd");
  assert.equal(new TextDecoder().decode(await readResponseBytes(response, 4)), "abcd");
  assert.equal(response.body?.locked, false);
});

test("non-JSON responses cancel the body before reporting a content-type failure", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/plain" } });
  await assert.rejects(parseJsonResponse(response), /JSON content-type/);
  assert.equal(canceled, true);
});
