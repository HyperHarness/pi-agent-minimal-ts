import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type {
  DownloadPdfRequest,
  DownloadPdfResponse,
  OpenArticleRequest,
  OpenArticleResponse,
  PaperBrowserManagerHealthResponse
} from "./paper-browser-manager-types.js";

export interface PaperBrowserController {
  ensureBrowser(): Promise<void>;
  health(): Promise<{ browserConnected: boolean; profileDir: string }>;
  openArticle(request: OpenArticleRequest): Promise<OpenArticleResponse>;
  downloadPaperPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse>;
  close(): Promise<void>;
}

export interface PaperBrowserManagerErrorPayload {
  message: string;
  code?: string;
}

export interface PaperBrowserManagerErrorResponse {
  ok: false;
  error: PaperBrowserManagerErrorPayload;
}

function toManagerErrorResponse(error: unknown): PaperBrowserManagerErrorResponse {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;

  return {
    ok: false,
    error: {
      message,
      code
    }
  };
}

export function createPaperBrowserManagerServer(options: {
  workspaceDir: string;
  browserController: PaperBrowserController;
}) {
  return {
    async handleHealth(): Promise<PaperBrowserManagerHealthResponse> {
      await options.browserController.ensureBrowser();
      const health = await options.browserController.health();
      return { ok: true, ...health };
    },

    async handleOpenArticle(request: OpenArticleRequest): Promise<OpenArticleResponse> {
      await options.browserController.ensureBrowser();
      return options.browserController.openArticle(request);
    },

    async handleDownloadPdf(request: DownloadPdfRequest): Promise<DownloadPdfResponse> {
      await options.browserController.ensureBrowser();
      return options.browserController.downloadPaperPdf(request);
    },

    async close(): Promise<void> {
      await options.browserController.close();
    }
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonRequest<T>(request: IncomingMessage): Promise<T> {
  const body = await readRequestBody(request);
  return JSON.parse(body) as T;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

export async function startPaperBrowserManagerHttpServer(options: {
  workspaceDir: string;
  manager: ReturnType<typeof createPaperBrowserManagerServer>;
}): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, await options.manager.handleHealth());
        return;
      }

      if (request.method === "POST" && request.url === "/open-article") {
        writeJson(
          response,
          200,
          await options.manager.handleOpenArticle(await readJsonRequest<OpenArticleRequest>(request))
        );
        return;
      }

      if (request.method === "POST" && request.url === "/download-pdf") {
        writeJson(
          response,
          200,
          await options.manager.handleDownloadPdf(await readJsonRequest<DownloadPdfRequest>(request))
        );
        return;
      }

      writeJson(response, 404, {
        ok: false,
        error: "Not found."
      });
    } catch (error) {
      writeJson(response, 500, toManagerErrorResponse(error));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind paper browser manager.");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      await options.manager.close();
    }
  };
}
