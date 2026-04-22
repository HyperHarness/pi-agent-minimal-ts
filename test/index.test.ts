import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as publicApi from "../src/index.js";
import {
  applyModelBaseUrlOverride,
  createReplEventHandler,
  main,
  parseCliArgs,
  runAgentTurn
} from "../src/pi-agent.js";
import { resolveInitialModel } from "../src/agent/model-resolver.js";
import { createTools } from "../src/agent/tools.js";

test("public entrypoint re-exports the reusable library APIs", () => {
  assert.equal(publicApi.runAgentTurn, runAgentTurn);
  assert.equal(publicApi.parseCliArgs, parseCliArgs);
  assert.equal(publicApi.applyModelBaseUrlOverride, applyModelBaseUrlOverride);
  assert.equal(publicApi.createReplEventHandler, createReplEventHandler);
  assert.equal(publicApi.main, main);
  assert.equal(publicApi.resolveInitialModel, resolveInitialModel);
  assert.equal(publicApi.createTools, createTools);
});

test("package.json exposes the library root export for publishing", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    private?: boolean;
    main?: string;
    types?: string;
    files?: string[];
    exports?: {
      "."
        ?: {
            import?: string;
            types?: string;
          };
    };
  };

  assert.equal(packageJson.private, false);
  assert.equal(packageJson.main, "./dist/src/index.js");
  assert.equal(packageJson.types, "./dist/src/index.d.ts");
  assert.deepEqual(packageJson.files, ["dist/src", "README.md"]);
  assert.deepEqual(packageJson.exports?.["."], {
    import: "./dist/src/index.js",
    types: "./dist/src/index.d.ts"
  });
});
