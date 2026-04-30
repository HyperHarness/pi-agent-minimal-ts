import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRpcClientOptions {
  command: string;
  commandArgs?: string[];
  useSession: boolean;
  sessionDir?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface PiRpcClientDependencies {
  spawnFn?: typeof spawn;
  startupTimeoutMs?: number;
  requireReadyEvent?: boolean;
}

const OPENAI_COMPAT_PROVIDER = 'openai-compatible';
const MAX_STDERR_HISTORY = 10;

export interface PiAssistantMessageEvent {
  type?: string;
  delta?: string;
  text?: string;
  content?: unknown;
  message?: {
    content?: unknown;
    errorMessage?: string;
    stopReason?: string;
  };
  errorMessage?: string;
  stopReason?: string;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object' && 'text' in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function extractPiErrorMessage(event: PiEvent): string | null {
  const candidates: unknown[] = [];
  const direct = event as { error?: unknown; errorMessage?: unknown; message?: { errorMessage?: unknown; stopReason?: unknown } };
  candidates.push(direct.errorMessage, direct.error, direct.message?.errorMessage);

  const assistantMessageEvent = (event as { assistantMessageEvent?: PiAssistantMessageEvent }).assistantMessageEvent;
  candidates.push(assistantMessageEvent?.errorMessage, assistantMessageEvent?.message?.errorMessage);

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function isPiErrorEvent(event: PiEvent): boolean {
  const direct = event as { stopReason?: unknown; message?: { stopReason?: unknown } };
  const assistantMessageEvent = (event as { assistantMessageEvent?: PiAssistantMessageEvent }).assistantMessageEvent;
  const stopReason = direct.stopReason ?? direct.message?.stopReason ?? assistantMessageEvent?.stopReason ?? assistantMessageEvent?.message?.stopReason;
  return event.type === 'error' || stopReason === 'error' || Boolean(extractPiErrorMessage(event));
}

function getEffectiveProvider(options: PiRpcClientOptions): string | undefined {
  if (options.provider) {
    return options.provider;
  }
  if (options.baseUrl) {
    return OPENAI_COMPAT_PROVIDER;
  }
  return undefined;
}

function buildPiChildEnv(options: PiRpcClientOptions): NodeJS.ProcessEnv | undefined {
  if (!options.baseUrl && !options.apiKey) {
    return undefined;
  }

  return {
    ...process.env,
    ...(options.baseUrl ? { PI_BASE_URL: options.baseUrl } : {}),
    ...(options.baseUrl ? { OPENAI_BASE_URL: options.baseUrl } : {}),
    ...(options.apiKey ? { OPENAI_API_KEY: options.apiKey } : {}),
  };
}

export class PiRpcClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private commandId = 0;
  private readonly pendingResponses = new Map<string, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>();
  private isReady = false;
  private currentResponse = '';
  private responseCallback: ((text: string) => void) | null = null;
  private responseReject: ((reason?: unknown) => void) | null = null;
  private stderrHistory: string[] = [];

  constructor(
    private readonly options: PiRpcClientOptions,
    private readonly dependencies: PiRpcClientDependencies = {},
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.process) {
      return;
    }

    const args = [...(this.options.commandArgs ?? []), '--mode', 'rpc'];
    if (!this.options.useSession) {
      args.push('--no-session');
    }
    if (this.options.sessionDir) {
      args.push('--session-dir', this.options.sessionDir);
    }
    const effectiveProvider = getEffectiveProvider(this.options);
    if (effectiveProvider) {
      args.push('--provider', effectiveProvider);
    }
    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    const spawnFn = this.dependencies.spawnFn || spawn;
    this.process = spawnFn(this.options.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: buildPiChildEnv(this.options),
    });

    this.process.stdout?.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const stderrText = chunk.toString();
      this.pushStderr(stderrText);
      this.emit('stderr', stderrText);
    });

    this.process.on('exit', (code) => {
      this.isReady = false;
      this.process = null;
      this.rejectPendingWork(new Error(`PI 进程已退出: ${code ?? 'unknown'}`));
      this.emit('exit', code);
    });

    this.process.on('error', (error) => {
      this.isReady = false;
      this.rejectPendingWork(error instanceof Error ? error : new Error(String(error)));
      this.emit('error', error);
    });

    await new Promise<void>((resolve, reject) => {
      const startupTimeoutMs = this.dependencies.startupTimeoutMs ?? 5000;
      const requireReadyEvent = this.dependencies.requireReadyEvent ?? false;
      const cleanup = (): void => {
        clearTimeout(timeout);
        this.off('event', onReady);
        this.off('error', onError);
      };
      const onReady = (): void => {
        cleanup();
        this.isReady = true;
        resolve();
      };
      const onError = (error: unknown): void => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const timeout = setTimeout(() => {
        cleanup();
        if (requireReadyEvent) {
          reject(new Error(`PI RPC 启动超时（${startupTimeoutMs}ms）`));
          return;
        }
        if (this.process) {
          this.isReady = true;
          resolve();
          return;
        }
        reject(new Error(`PI RPC 启动失败（进程未存活，${startupTimeoutMs}ms）`));
      }, startupTimeoutMs);

      this.once('event', onReady);
      this.once('error', onError);
    });
  }

  isProcessReady(): boolean {
    return this.isReady && this.process !== null;
  }

  getRecentStderrSummary(): string {
    return this.stderrHistory.join(' | ');
  }

  stop(): void {
    this.rejectPendingWork(new Error('PI 进程已停止'));
    if (this.process) {
      this.process.kill();
      this.process = null;
      this.isReady = false;
    }
  }

  async prompt(message: string): Promise<string> {
    if (this.responseCallback || this.responseReject) {
      throw new Error('已有进行中的 prompt，请等待当前请求完成');
    }

    this.currentResponse = '';
    return new Promise(async (resolve, reject) => {
      this.responseCallback = (text: string) => {
        this.responseCallback = null;
        this.responseReject = null;
        resolve(text);
      };
      this.responseReject = (reason?: unknown) => {
        this.responseCallback = null;
        this.responseReject = null;
        reject(reason);
      };

      try {
        await this.sendCommand({
          type: 'prompt',
          message,
          streamingBehavior: 'followUp',
        });
      } catch (error) {
        this.responseCallback = null;
        this.responseReject = null;
        reject(error);
      }
    });
  }

  private async sendCommand(command: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('pi 进程未启动'));
        return;
      }

      const id = `cmd-${++this.commandId}`;
      this.pendingResponses.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error) {
          this.pendingResponses.delete(id);
          reject(error);
        }
      });
    });
  }

  private rejectPendingWork(error: Error): void {
    for (const pending of this.pendingResponses.values()) {
      pending.reject(error);
    }
    this.pendingResponses.clear();

    if (this.responseReject) {
      this.responseReject(error);
    }

    this.currentResponse = '';
  }

  private pushStderr(stderrText: string): void {
    const lines = stderrText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return;
    }

    this.stderrHistory.push(...lines);
    if (this.stderrHistory.length > MAX_STDERR_HISTORY) {
      this.stderrHistory = this.stderrHistory.slice(-MAX_STDERR_HISTORY);
    }
  }

  private handleData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    try {
      const data = JSON.parse(line) as PiEvent & { id?: string; success?: boolean; error?: string };

      if (data.type === 'response') {
        const pending = data.id ? this.pendingResponses.get(data.id) : undefined;
        if (!pending || !data.id) {
          return;
        }
        this.pendingResponses.delete(data.id);
        if (data.success) {
          pending.resolve(data);
        } else {
          pending.reject(new Error(data.error || 'Command failed'));
        }
        return;
      }

      this.handleEvent(data);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleEvent(event: PiEvent): void {
    this.emit('event', event);

    if (isPiErrorEvent(event)) {
      const errorMessage = extractPiErrorMessage(event) || 'PI agent returned an error';
      if (this.responseReject) {
        this.responseReject(new Error(errorMessage));
      }
      this.currentResponse = '';
      return;
    }

    if (event.type === 'message_update') {
      const assistantMessageEvent = (event as { assistantMessageEvent?: PiAssistantMessageEvent }).assistantMessageEvent;
      if (assistantMessageEvent?.type === 'text_delta' && assistantMessageEvent.delta) {
        this.currentResponse += assistantMessageEvent.delta;
        this.emit('text_delta', assistantMessageEvent.delta);
      }
      if (assistantMessageEvent?.type === 'message' || assistantMessageEvent?.type === 'text') {
        const text = assistantMessageEvent.text || extractTextFromContent(assistantMessageEvent.content || assistantMessageEvent.message?.content);
        if (text) {
          this.currentResponse += text;
          this.emit('text_delta', text);
        }
      }
      if (assistantMessageEvent?.type === 'thinking_start') {
        this.emit('thinking_start');
      }
      if (assistantMessageEvent?.type === 'thinking_end') {
        this.emit('thinking_end');
      }
      if (assistantMessageEvent?.type === 'thinking_delta' && assistantMessageEvent.delta) {
        this.emit('thinking_delta', assistantMessageEvent.delta);
      }
    }

    if (event.type === 'agent_end') {
      if (this.responseCallback) {
        this.responseCallback(this.currentResponse);
      }
      this.currentResponse = '';
    }
  }
}
