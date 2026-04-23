import type {
  DownloadPdfRequest,
  DownloadPdfResponse,
  OpenArticleRequest,
  OpenArticleResponse,
  PaperBrowserManagerHealthResponse,
  PaperBrowserManagerMetadata
} from "./paper-browser-manager-types.js";
import {
  clearPaperBrowserManagerMetadata,
  discoverPaperBrowserManagerMetadata,
  isPaperBrowserManagerMetadataStale,
  readPaperBrowserManagerMetadata,
  writePaperBrowserManagerMetadata
} from "./paper-browser-manager-discovery.js";

type FetchJson = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<unknown>;
type ReadMetadata = typeof readPaperBrowserManagerMetadata;
type WriteMetadata = typeof writePaperBrowserManagerMetadata;
type ClearMetadata = typeof clearPaperBrowserManagerMetadata;
type IsMetadataStale = typeof isPaperBrowserManagerMetadataStale;
type SpawnManager = () => Promise<PaperBrowserManagerMetadata>;

class PaperBrowserManagerRemoteError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PaperBrowserManagerRemoteError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRemoteError(payload: unknown, fallbackMessage: string): Error {
  if (!isRecord(payload)) {
    return new Error(fallbackMessage);
  }

  const candidateError = isRecord(payload.error) ? payload.error : undefined;
  const code =
    typeof candidateError?.code === "string"
      ? candidateError.code
      : typeof payload.code === "string"
        ? payload.code
        : undefined;
  const message =
    typeof candidateError?.message === "string"
      ? candidateError.message
      : typeof payload.message === "string"
        ? payload.message
        : fallbackMessage;

  if (!code) {
    return new Error(message);
  }

  return new PaperBrowserManagerRemoteError(code, message);
}

export interface PaperBrowserManagerClient {
  ensureManagerEndpoint(): Promise<string>;
  openArticle(request: OpenArticleRequest): Promise<
    OpenArticleResponse & { profileDir?: string; executablePath?: string }
  >;
  downloadPaperPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse>;
  close(): Promise<void>;
}

export interface PaperBrowserManagerClientOptions {
  workspaceDir: string;
  readMetadata?: ReadMetadata;
  writeMetadata?: WriteMetadata;
  clearMetadata?: ClearMetadata;
  isMetadataStale?: IsMetadataStale;
  fetchJson?: FetchJson;
  spawnManager?: SpawnManager;
  disposeManager?: () => Promise<void>;
}

function isHealthyManagerResponse(value: unknown): value is PaperBrowserManagerHealthResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<PaperBrowserManagerHealthResponse>;
  return candidate.ok === true && candidate.browserConnected === true && typeof candidate.profileDir === "string";
}

async function defaultFetchJson(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<unknown> {
  const response = await fetch(url, {
    method: init?.method,
    body: init?.body,
    headers: init?.body
      ? {
          "content-type": "application/json",
          ...init?.headers
        }
      : init?.headers
  });

  const text = await response.text();
  if (!response.ok) {
    let payload: unknown;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    throw toRemoteError(payload, text || `Request failed with status ${response.status}.`);
  }

  return text ? JSON.parse(text) : undefined;
}

async function requestJson<T>(options: {
  fetchJson: FetchJson;
  endpoint: string;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T> {
  const response = await options.fetchJson(`${options.endpoint}${options.path}`, {
    method: options.method,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  return response as T;
}

export function createPaperBrowserManagerClient(
  options: PaperBrowserManagerClientOptions
): PaperBrowserManagerClient {
  const readMetadata = options.readMetadata ?? readPaperBrowserManagerMetadata;
  const writeMetadata = options.writeMetadata ?? writePaperBrowserManagerMetadata;
  const clearMetadata = options.clearMetadata ?? clearPaperBrowserManagerMetadata;
  const isMetadataStale = options.isMetadataStale ?? isPaperBrowserManagerMetadataStale;
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const spawnManager = options.spawnManager;
  let resolvedEndpointPromise: Promise<string> | undefined;
  let resolvedMetadata: PaperBrowserManagerMetadata | undefined;
  let closePromise: Promise<void> | undefined;

  async function disposeSpawnedManagerAfterFailedPersistence(error: unknown): Promise<never> {
    resolvedMetadata = undefined;

    try {
      await options.disposeManager?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Failed to persist paper browser manager metadata and clean up the spawned manager."
      );
    }

    throw error;
  }

  async function resolveEndpoint(): Promise<string> {
    const storedMetadata = await discoverPaperBrowserManagerMetadata({
      workspaceDir: options.workspaceDir,
      readMetadata,
      clearMetadata,
      isMetadataStale
    });

    if (storedMetadata) {
      try {
        const health = await fetchJson(`${storedMetadata.endpoint}/health`);
        if (isHealthyManagerResponse(health)) {
          resolvedMetadata = storedMetadata;
          return storedMetadata.endpoint;
        }
      } catch {
        // Treat unreadable or unreachable metadata as stale and replace it.
      }

      await clearMetadata({ workspaceDir: options.workspaceDir });
    }

    if (!spawnManager) {
      throw new Error("No paper browser manager is available.");
    }

    const startedMetadata = await spawnManager();

    try {
      await writeMetadata({ workspaceDir: options.workspaceDir, metadata: startedMetadata });
    } catch (error) {
      return disposeSpawnedManagerAfterFailedPersistence(error);
    }

    resolvedMetadata = startedMetadata;
    return startedMetadata.endpoint;
  }

  async function ensureManagerEndpoint(): Promise<string> {
    if (resolvedEndpointPromise !== undefined) {
      return resolvedEndpointPromise;
    }

    closePromise = undefined;
    let ensurePromise: Promise<string>;
    ensurePromise = resolveEndpoint().catch((error: unknown) => {
      if (resolvedEndpointPromise === ensurePromise) {
        resolvedEndpointPromise = undefined;
      }

      throw error;
    });
    resolvedEndpointPromise = ensurePromise;
    return ensurePromise;
  }

  async function ensureResolvedMetadata(): Promise<PaperBrowserManagerMetadata> {
    const endpoint = await ensureManagerEndpoint();
    if (resolvedMetadata?.endpoint === endpoint) {
      return resolvedMetadata;
    }

    const storedMetadata = await readMetadata({ workspaceDir: options.workspaceDir });
    if (!storedMetadata || storedMetadata.endpoint !== endpoint) {
      throw new Error("Paper browser manager metadata is unavailable.");
    }

    resolvedMetadata = storedMetadata;
    return storedMetadata;
  }

  async function close(): Promise<void> {
    if (closePromise) {
      await closePromise;
      return;
    }

    const closingPromise = (async () => {
      resolvedEndpointPromise = undefined;
      resolvedMetadata = undefined;
      await options.disposeManager?.();
    })();

    closePromise = closingPromise;
    await closingPromise;
  }

  return {
    ensureManagerEndpoint,

    async openArticle(request: OpenArticleRequest): Promise<
      OpenArticleResponse & { profileDir?: string; executablePath?: string }
    > {
      const metadata = await ensureResolvedMetadata();
      const endpoint = metadata.endpoint;
      const response = await requestJson<OpenArticleResponse>({
        fetchJson,
        endpoint,
        path: "/open-article",
        method: "POST",
        body: request
      });

      return {
        ...response,
        profileDir: metadata.profileDir
      };
    },

    async downloadPaperPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse> {
      const endpoint = await ensureManagerEndpoint();
      return requestJson<DownloadPdfResponse>({
        fetchJson,
        endpoint,
        path: "/download-pdf",
        method: "POST",
        body: request
      });
    },

    close
  };
}
