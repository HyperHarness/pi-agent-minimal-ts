import crypto from 'node:crypto';
import path from 'node:path';
import type { ParsedIncomingMessage } from './types.js';
import type { PiRpcClientOptions } from './pi-client.js';

function sanitizeSessionSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
  const collapsed = normalized.replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return collapsed || 'default';
}

function buildSessionSegment(value: string): string {
  const base = sanitizeSessionSegment(value);
  const suffix = crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
  return `${base}-${suffix}`;
}

export function resolvePiSessionDir(baseDir: string, message: ParsedIncomingMessage): string {
  return path.join(baseDir, buildSessionSegment(message.chatId));
}

export function buildPiClientOptionsForMessage(
  baseOptions: PiRpcClientOptions,
  message: ParsedIncomingMessage,
  fallbackSessionRoot: string,
): PiRpcClientOptions {
  if (!baseOptions.useSession) {
    return {
      command: baseOptions.command,
      commandArgs: baseOptions.commandArgs,
      useSession: false,
      provider: baseOptions.provider,
      model: baseOptions.model,
      baseUrl: baseOptions.baseUrl,
      apiKey: baseOptions.apiKey,
    };
  }

  const sessionRoot = baseOptions.sessionDir || fallbackSessionRoot;
  return {
    command: baseOptions.command,
    commandArgs: baseOptions.commandArgs,
    useSession: true,
    sessionDir: resolvePiSessionDir(sessionRoot, message),
    provider: baseOptions.provider,
    model: baseOptions.model,
    baseUrl: baseOptions.baseUrl,
    apiKey: baseOptions.apiKey,
  };
}

export function getPiClientKey(options: PiRpcClientOptions): string {
  if (!options.useSession || !options.sessionDir) {
    return 'stateless';
  }
  return options.sessionDir;
}
