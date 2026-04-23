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
  readPaperBrowserManagerMetadata,
  writePaperBrowserManagerMetadata
} from "./paper-browser-manager-discovery.js";

type FetchJson = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<unknown>;
type ReadMetadata = typeof readPaperBrowserManagerMetadata;
type WriteMetadata = typeof writePaperBrowserManagerMetadata;
type ClearMetadata = typeof clearPaperBrowserManagerMetadata;
type SpawnManager = () => Promise<PaperBrowserManagerMetadata>;

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
    throw new Error(text || `Request failed with status ${response.status}.`);
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
  const fetchJson = options.fetchJson ?? defaultFetchJson;
  const spawnManager = options.spawnManager;
  let resolvedEndpointPromise: Promise<string> | undefined;
  let resolvedMetadata: PaperBrowserManagerMetadata | undefined;
  let closePromise: Promise<void> | undefined;

  async function resolveEndpoint(): Promise<string> {
    const storedMetadata = await readMetadata({ workspaceDir: options.workspaceDir });

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
    await writeMetadata({ workspaceDir: options.workspaceDir, metadata: startedMetadata });
    resolvedMetadata = startedMetadata;
    return startedMetadata.endpoint;
  }

  async function ensureManagerEndpoint(): Promise<string> {
    resolvedEndpointPromise ??= resolveEndpoint();
    return resolvedEndpointPromise;
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

    closePromise = (async () => {
      resolvedEndpointPromise = undefined;
      resolvedMetadata = undefined;
      await options.disposeManager?.();
    })();

    await closePromise;
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
