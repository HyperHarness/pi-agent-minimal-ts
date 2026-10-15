// Abort-aware timeout helper for the benchmark runner.
//
// `runAgentTurn` and `callLlm` accept an AbortSignal, so a timed-out item is really
// cancelled instead of being abandoned in the background. The runner waits for the
// aborted turn to settle before it reuses or cleans the tools that are shared across
// items, and stops the whole benchmark when an aborted turn refuses to settle.
export const DEFAULT_SETTLE_GRACE_MS = 30_000;

const TIMED_OUT = Symbol("timed out");
const UNSETTLED = Symbol("unsettled");

export class AbandonedTurnError extends Error {
  constructor(message) {
    super(message);
    this.name = "AbandonedTurnError";
  }
}

export function waitForAbort(signal) {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// Runs `run(signal)` under a hard timeout. On timeout the signal is aborted and the
// turn is then awaited (up to settleGraceMs) so the caller never reuses shared tool
// state while the aborted turn is still running. A turn that still cannot settle
// raises AbandonedTurnError: the caller must stop rather than start the next item
// against shared live tools.
export async function runWithTimeout(run, timeoutMs, options = {}) {
  const settleGraceMs = options.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const controller = new AbortController();
  const timeoutError = new Error(`timed out after ${timeoutMs} ms`);
  let graceTimer;
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  // Attach handlers immediately so a late rejection is never an unhandled rejection.
  const settled = Promise.resolve()
    .then(() => run(controller.signal))
    .then(
      (value) => ({ status: "fulfilled", value }),
      (error) => ({ status: "rejected", error })
    );

  try {
    const outcome = await Promise.race([
      settled,
      waitForAbort(controller.signal).then(() => TIMED_OUT)
    ]);

    if (outcome !== TIMED_OUT) {
      if (outcome.status === "rejected") {
        throw outcome.error;
      }
      return outcome.value;
    }

    clearTimeout(timer);
    const settlement = await Promise.race([settled, new Promise(resolve => { graceTimer = setTimeout(() => resolve(UNSETTLED), settleGraceMs); })]);
    if (settlement === UNSETTLED) {
      throw new AbandonedTurnError(
        `turn did not settle within ${settleGraceMs} ms after aborting at ${timeoutMs} ms; ` +
          "stopping the benchmark before reusing shared live tools"
      );
    }

    throw timeoutError;
  } finally {
    clearTimeout(graceTimer);
    clearTimeout(timer);
  }
}
