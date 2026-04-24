import test from "node:test";
import assert from "node:assert/strict";
import { resolveInitialModel } from "../../src/agent/model-resolver.js";

function createModel(provider: string, id: string) {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    baseUrl: "https://example.test/v1"
  };
}

test("resolveInitialModel prefers explicit provider and model", () => {
  const availableModels = [
    createModel("openai", "gpt-5.4"),
    createModel("anthropic", "claude-opus-4-6")
  ];

  const result = resolveInitialModel({
    cliProvider: "anthropic",
    cliModel: "claude-opus-4-6",
    envProvider: "openai",
    envModel: "gpt-5.4",
    availableModels,
    hasConfiguredAuth: () => true
  });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.model.id, "claude-opus-4-6");
});

test("resolveInitialModel throws when an explicit requested provider is not found", () => {
  const availableModels = [
    createModel("openai", "gpt-5.4"),
    createModel("anthropic", "claude-opus-4-6")
  ];

  assert.throws(() => {
    resolveInitialModel({
      cliProvider: "unknown-provider",
      cliModel: "unknown-model",
      envProvider: "openai",
      envModel: "gpt-5.4",
      availableModels,
      hasConfiguredAuth: () => true
    });
  }, /Requested model not found: unknown-provider\/unknown-model/i);
});

test("resolveInitialModel derives an explicit missing model from the provider template", () => {
  const availableModels = [
    createModel("openai", "gpt-5.4"),
    createModel("anthropic", "claude-opus-4-6")
  ];

  const result = resolveInitialModel({
    cliProvider: "openai",
    cliModel: "gpt-5.5",
    envProvider: undefined,
    envModel: undefined,
    availableModels,
    hasConfiguredAuth: () => true
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.model.id, "gpt-5.5");
  assert.equal(result.model.name, "gpt-5.5");
  assert.equal(result.model.api, "openai-completions");
  assert.equal(result.model.baseUrl, "https://example.test/v1");
});

test("resolveInitialModel ignores a partial CLI override and honors a complete env pair", () => {
  const availableModels = [
    createModel("openai", "gpt-5.4"),
    createModel("anthropic", "claude-opus-4-6")
  ];

  const result = resolveInitialModel({
    cliProvider: "anthropic",
    cliModel: undefined,
    envProvider: "openai",
    envModel: "gpt-5.4",
    availableModels,
    hasConfiguredAuth: () => true
  });

  assert.equal(result.provider, "openai");
  assert.equal(result.model.id, "gpt-5.4");
});

test("resolveInitialModel falls back to the preferred default model among authenticated providers", () => {
  const openai = createModel("openai", "gpt-5.4");
  const anthropic = createModel("anthropic", "claude-opus-4-6");

  const result = resolveInitialModel({
    cliProvider: undefined,
    cliModel: undefined,
    envProvider: undefined,
    envModel: undefined,
    availableModels: [openai, anthropic],
    hasConfiguredAuth: (provider: string) => provider === "openai" || provider === "anthropic"
  });

  assert.equal(result.provider, "anthropic");
  assert.equal(result.model.id, "claude-opus-4-6");
});

test("resolveInitialModel falls back to the first authenticated model when no preferred default matches", () => {
  const first = createModel("custom-provider", "custom-model-a");
  const second = createModel("other-provider", "custom-model-b");

  const result = resolveInitialModel({
    cliProvider: undefined,
    cliModel: undefined,
    envProvider: undefined,
    envModel: undefined,
    availableModels: [first, second],
    hasConfiguredAuth: (provider: string) =>
      provider === "custom-provider" || provider === "other-provider"
  });

  assert.equal(result.provider, "custom-provider");
  assert.equal(result.model.id, "custom-model-a");
});

test("resolveInitialModel throws when no authenticated model is available", () => {
  assert.throws(() => {
    resolveInitialModel({
      cliProvider: undefined,
      cliModel: undefined,
      envProvider: undefined,
      envModel: undefined,
      availableModels: [createModel("openai", "gpt-5.4")],
      hasConfiguredAuth: () => false
    });
  }, /No usable model/i);
});
