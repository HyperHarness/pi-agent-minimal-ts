import fs from 'node:fs';
import path from 'node:path';

export type LongTermMemoryKind = 'fact' | 'preference';

export interface LongTermMemoryEntry {
  text: string;
  kind: LongTermMemoryKind;
  updatedAt: string;
}

interface LongTermMemoryFile {
  users: Record<string, LongTermMemoryEntry[]>;
  groups: Record<string, LongTermMemoryEntry[]>;
}

const FILE_NAME = 'long-term.json';

function isLongTermEntry(value: unknown): value is LongTermMemoryEntry {
  return typeof value === 'object' && value !== null
    && typeof (value as LongTermMemoryEntry).text === 'string'
    && ((value as LongTermMemoryEntry).kind === 'fact' || (value as LongTermMemoryEntry).kind === 'preference')
    && typeof (value as LongTermMemoryEntry).updatedAt === 'string';
}

function isLongTermMemoryFile(value: unknown): value is LongTermMemoryFile {
  const candidate = value as LongTermMemoryFile;
  if (typeof value !== 'object' || value === null || typeof candidate.users !== 'object' || candidate.users === null || Array.isArray(candidate.users) || typeof candidate.groups !== 'object' || candidate.groups === null || Array.isArray(candidate.groups)) {
    return false;
  }

  return [...Object.values(candidate.users), ...Object.values(candidate.groups)].every((entries) => Array.isArray(entries) && entries.every(isLongTermEntry));
}

export class LongTermMemoryStore {
  private readonly filePath: string;
  private cache: LongTermMemoryFile;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, FILE_NAME);
    this.cache = this.load();
  }

  upsertUserFact(userId: string, text: string, kind: LongTermMemoryKind): void {
    this.cache.users[userId] = this.upsert(this.cache.users[userId] ?? [], text, kind);
    this.save();
  }

  upsertGroupFact(chatId: string, text: string, kind: LongTermMemoryKind): void {
    this.cache.groups[chatId] = this.upsert(this.cache.groups[chatId] ?? [], text, kind);
    this.save();
  }

  getUserEntries(userId: string): LongTermMemoryEntry[] {
    return [...(this.cache.users[userId] ?? [])];
  }

  getGroupEntries(chatId: string): LongTermMemoryEntry[] {
    return [...(this.cache.groups[chatId] ?? [])];
  }

  renderUserMemory(userId: string): string {
    return this.renderEntries(this.getUserEntries(userId), '用户长期记忆');
  }

  renderGroupMemory(chatId: string): string {
    return this.renderEntries(this.getGroupEntries(chatId), '群长期记忆');
  }

  private upsert(entries: LongTermMemoryEntry[], text: string, kind: LongTermMemoryKind): LongTermMemoryEntry[] {
    const normalized = text.trim();
    if (!normalized) {
      return [...entries];
    }
    const now = new Date().toISOString();
    const existing = entries.find((entry) => entry.text === normalized && entry.kind === kind);
    if (existing) {
      existing.updatedAt = now;
      return [...entries];
    }
    return [...entries, { text: normalized, kind, updatedAt: now }];
  }

  private renderEntries(entries: LongTermMemoryEntry[], title: string): string {
    if (entries.length === 0) {
      return '(无)';
    }
    const lines = entries.map((entry) => `- ${entry.text}`);
    return `${title}：\n${lines.join('\n')}`;
  }

  private load(): LongTermMemoryFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
        if (isLongTermMemoryFile(parsed)) {
          return parsed;
        }
      }
    } catch {
      // ignore broken file and start fresh
    }
    return { users: {}, groups: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
