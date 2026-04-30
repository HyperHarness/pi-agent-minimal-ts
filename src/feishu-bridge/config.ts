import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface Config {
  feishu: {
    appId: string;
    appSecret: string;
    encryptKey?: string;
    botOpenId?: string;
    botAliases: string[];
    requireMentionInGroups: boolean;
    allowedChatIds: string[];
    streamUpdates: boolean;
    streamUpdateIntervalMs: number;
    placeholderText: string;
    maxReplyChars: number;
    streamMode: 'card' | 'text' | 'card_to_text';
    replyToMessage: boolean;
    replyInThread: boolean;
  };
  pi: {
    command: string;
    commandArgs?: string[];
    useSession: boolean;
    sessionDir?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
  };
  memory: {
    dir: string;
    historyLimit: number;
    longTermEnabled: boolean;
    learnFromAllGroupMessages: boolean;
  };
  bridge: {
    promptInstruction?: string;
  };
  web: {
    enabled: boolean;
    maxResults: number;
  };
}

function readEnvFile(cwd: string): void {
  const envPath = path.join(cwd, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value.replace(/^['"]|['"]$/g, '');
    }
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStreamMode(value: string | undefined): 'card' | 'text' | 'card_to_text' {
  if (value === 'text') {
    return 'text';
  }
  if (value === 'card_to_text') {
    return 'card_to_text';
  }
  return 'card';
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function decodeWindowsEnvOutput(output: Buffer): string {
  const encoding = output.includes(0) ? 'utf16le' : 'utf8';
  return output.toString(encoding).replace(/\0/g, '').trim();
}

function readWindowsUserEnvVar(name: string): string | undefined {
  if (process.platform !== 'linux') {
    return undefined;
  }

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `[Console]::OutputEncoding=[Text.UTF8Encoding]::UTF8; [Environment]::GetEnvironmentVariable('${name.replace(/'/g, "''")}', 'User')`,
      ],
      { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const value = decodeWindowsEnvOutput(output);
    return value || undefined;
  } catch {
    return undefined;
  }
}

function getEnvVar(name: string): string | undefined {
  return process.env[name] || readWindowsUserEnvVar(name);
}

function getPiBaseUrl(): string | undefined {
  return getEnvVar('PI_BASE_URL') || getEnvVar('OPENAI_BASE_URL');
}

function validateUrl(value: string | undefined, name: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return value;
  } catch {
    throw new Error(`${name} 必须是有效的 http(s) URL，当前值：${value}`);
  }
}

function validateHeaderValue(value: string | undefined, name: string): string | undefined {
  if (!value) {
    return undefined;
  }

  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) {
      throw new Error(`${name} 包含非 ASCII 字符，请检查 Windows/WSL 环境变量编码或重新设置该变量`);
    }
  }
  return value;
}

function getPiProvider(): string | undefined {
  const configuredProvider = process.env.PI_PROVIDER;
  if (configuredProvider) {
    return configuredProvider;
  }
  if (getPiBaseUrl()) {
    return 'openai-compatible';
  }
  return undefined;
}

function getDefaultAgentEntry(cwd: string): string {
  return process.env.PI_AGENT_ENTRY || path.join(cwd, 'dist', 'src', 'pi-agent.js');
}

export function loadConfig(cwd: string = process.cwd()): Config {
  readEnvFile(cwd);

  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  }
  const piBaseUrl = validateUrl(getPiBaseUrl(), 'PI_BASE_URL/OPENAI_BASE_URL');
  const openAiApiKey = validateHeaderValue(getEnvVar('OPENAI_API_KEY'), 'OPENAI_API_KEY');

  return {
    feishu: {
      appId,
      appSecret,
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      botOpenId: process.env.FEISHU_BOT_OPEN_ID,
      botAliases: parseList(process.env.FEISHU_BOT_ALIASES),
      requireMentionInGroups: parseBoolean(process.env.FEISHU_REQUIRE_MENTION_IN_GROUPS, true),
      allowedChatIds: parseList(process.env.FEISHU_ALLOWED_CHAT_IDS),
      streamUpdates: parseBoolean(process.env.FEISHU_STREAM_UPDATES, true),
      streamUpdateIntervalMs: parseNumber(process.env.FEISHU_STREAM_UPDATE_INTERVAL_MS, 800),
      placeholderText: process.env.FEISHU_PLACEHOLDER_TEXT || '🤔 正在思考…',
      maxReplyChars: parseNumber(process.env.FEISHU_MAX_REPLY_CHARS, 4000),
      streamMode: parseStreamMode(process.env.FEISHU_STREAM_MODE),
      replyToMessage: parseBoolean(process.env.FEISHU_REPLY_TO_MESSAGE, true),
      replyInThread: parseBoolean(process.env.FEISHU_REPLY_IN_THREAD, false),
    },
    pi: {
      command: process.env.PI_COMMAND || process.execPath,
      commandArgs: process.env.PI_COMMAND ? [] : [getDefaultAgentEntry(cwd)],
      useSession: parseBoolean(process.env.PI_USE_SESSION, true),
      sessionDir: process.env.PI_SESSION_DIR,
      provider: getPiProvider(),
      model: getEnvVar('PI_MODEL'),
      baseUrl: piBaseUrl,
      apiKey: openAiApiKey,
    },
    memory: {
      dir: process.env.BRIDGE_MEMORY_DIR || path.join(cwd, '.memory'),
      historyLimit: parseNumber(process.env.BRIDGE_HISTORY_LIMIT, 12),
      longTermEnabled: parseBoolean(process.env.BRIDGE_LONG_TERM_MEMORY_ENABLED, true),
      learnFromAllGroupMessages: parseBoolean(process.env.BRIDGE_LEARN_FROM_ALL_GROUP_MESSAGES, true),
    },
    bridge: {
      promptInstruction: process.env.BRIDGE_PROMPT_INSTRUCTION,
    },
    web: {
      enabled: parseBoolean(process.env.BRIDGE_WEB_SEARCH_ENABLED, true),
      maxResults: parseNumber(process.env.BRIDGE_WEB_SEARCH_MAX_RESULTS, 5),
    },
  };
}
