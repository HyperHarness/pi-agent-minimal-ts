import fs from 'node:fs';
import path from 'node:path';
import type { ChatMemoryFile, ChatTurn } from '../types.js';

const FILE_NAME = 'chats.json';

function isChatTurn(value: unknown): value is ChatTurn {
  return typeof value === 'object' && value !== null
    && ((value as ChatTurn).role === 'user' || (value as ChatTurn).role === 'assistant')
    && typeof (value as ChatTurn).text === 'string'
    && typeof (value as ChatTurn).timestamp === 'string';
}

function isChatMemoryFile(value: unknown): value is ChatMemoryFile {
  if (typeof value !== 'object' || value === null || typeof (value as ChatMemoryFile).chats !== 'object' || (value as ChatMemoryFile).chats === null || Array.isArray((value as ChatMemoryFile).chats)) {
    return false;
  }

  return Object.values((value as ChatMemoryFile).chats).every((turns) => Array.isArray(turns) && turns.every(isChatTurn));
}

export class ChatMemoryStore {
  private readonly filePath: string;
  private cache: ChatMemoryFile;

  constructor(baseDir: string, private readonly maxTurns: number) {
    this.filePath = path.join(baseDir, FILE_NAME);
    this.cache = this.load();
  }

  appendTurn(chatId: string, turn: ChatTurn): void {
    const turns = this.cache.chats[chatId] ?? [];
    turns.push(turn);
    this.cache.chats[chatId] = turns.slice(-this.maxTurns);
    this.save();
  }

  getTurns(chatId: string): ChatTurn[] {
    return [...(this.cache.chats[chatId] ?? [])];
  }

  renderHistory(chatId: string, options: { includeAgentMessages?: boolean } = {}): string {
    const turns = this.getTurns(chatId)
      .filter((turn) => options.includeAgentMessages === true || turn.role !== 'assistant');
    if (turns.length === 0) {
      return '(无历史上下文)';
    }

    return turns
      .map((turn) => {
        if (turn.role === 'assistant') {
          return `助手: ${turn.text}`;
        }
        return `${turn.senderName || '用户'}: ${turn.text}`;
      })
      .join('\n');
  }

  private load(): ChatMemoryFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
        if (isChatMemoryFile(parsed)) {
          return parsed;
        }
      }
    } catch {
      // fall back to empty cache
    }

    return { chats: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
