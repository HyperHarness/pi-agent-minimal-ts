import type { Api, KnownProvider, Model } from "@mariozechner/pi-ai";

type ModelIdentity = Pick<Model<Api>, "provider" | "id">;

export interface ModelResolverOptions<TModel extends ModelIdentity = Model<Api>> {
  cliProvider?: string;
  cliModel?: string;
  envProvider?: string;
  envModel?: string;
  availableModels: TModel[];
  hasConfiguredAuth: (provider: string) => boolean;
}

export interface ResolvedModelSelection<TModel extends ModelIdentity = Model<Api>> {
  provider: string;
  model: TModel;
}

const DEFAULT_MODELS: ReadonlyArray<readonly [KnownProvider, string]> = [
  ["anthropic", "claude-opus-4-6"],
  ["openai", "gpt-5.4"],
  ["google", "gemini-2.5-pro"],
  ["openrouter", "openai/gpt-5.1-codex"],
  ["xai", "grok-4-fast-non-reasoning"],
  ["groq", "openai/gpt-oss-120b"],
  ["mistral", "devstral-medium-latest"]
];

function findExactModel<TModel extends ModelIdentity>(
  availableModels: TModel[],
  provider: string,
  modelId: string
): TModel | undefined {
  return availableModels.find((model) => model.provider === provider && model.id === modelId);
}

function createCustomModelFromProviderTemplate<TModel extends ModelIdentity>(
  availableModels: TModel[],
  provider: string,
  modelId: string
): TModel | undefined {
  const defaultModel = DEFAULT_MODELS.find(([defaultProvider]) => defaultProvider === provider);
  const template =
    defaultModel === undefined
      ? availableModels.find((model) => model.provider === provider)
      : findExactModel(availableModels, provider, defaultModel[1]) ??
        availableModels.find((model) => model.provider === provider);

  if (!template) {
    return undefined;
  }

  return {
    ...template,
    id: modelId,
    name: modelId
  };
}

function getExplicitRequest(options: ModelResolverOptions<ModelIdentity>) {
  if (options.cliProvider && options.cliModel) {
    return { provider: options.cliProvider, modelId: options.cliModel };
  }

  if (options.envProvider && options.envModel) {
    return { provider: options.envProvider, modelId: options.envModel };
  }

  return undefined;
}

export function resolveInitialModel<TModel extends ModelIdentity>(
  options: ModelResolverOptions<TModel>
): ResolvedModelSelection<TModel> {
  const explicitRequest = getExplicitRequest(options);

  if (explicitRequest) {
    const model = findExactModel(
      options.availableModels,
      explicitRequest.provider,
      explicitRequest.modelId
    );
    const resolvedModel =
      model ??
      createCustomModelFromProviderTemplate(
        options.availableModels,
        explicitRequest.provider,
        explicitRequest.modelId
      );

    if (!resolvedModel) {
      throw new Error(
        `Requested model not found: ${explicitRequest.provider}/${explicitRequest.modelId}`
      );
    }

    return {
      provider: explicitRequest.provider,
      model: resolvedModel
    };
  }

  const authenticatedModels = options.availableModels.filter((model) =>
    options.hasConfiguredAuth(model.provider)
  );

  if (authenticatedModels.length === 0) {
    throw new Error("No usable model found with configured authentication.");
  }

  for (const [provider, modelId] of DEFAULT_MODELS) {
    const model = findExactModel(authenticatedModels, provider, modelId);
    if (model) {
      return { provider, model };
    }
  }

  const fallbackModel = authenticatedModels[0];
  return {
    provider: fallbackModel.provider,
    model: fallbackModel
  };
}
