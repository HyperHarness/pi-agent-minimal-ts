import fs from 'node:fs';
import path from 'node:path';

export interface KeyMemoryEntry {
  text: string;
  category: 'project' | 'deadline' | 'decision' | 'preference' | 'fact';
  priority: number;
  updatedAt: string;
}

interface KeyMemoryFile {
  chats: Record<string, KeyMemoryEntry[]>;
}

const FILE_NAME = 'key-memory.json';

function isKeyMemoryEntry(value: unknown): value is KeyMemoryEntry {
  return typeof value === 'object' && value !== null
    && typeof (value as KeyMemoryEntry).text === 'string'
    && ['project', 'deadline', 'decision', 'preference', 'fact'].includes((value as KeyMemoryEntry).category)
    && typeof (value as KeyMemoryEntry).priority === 'number'
    && typeof (value as KeyMemoryEntry).updatedAt === 'string';
}

function isKeyMemoryFile(value: unknown): value is KeyMemoryFile {
  const candidate = value as KeyMemoryFile;
  if (typeof value !== 'object' || value === null || typeof candidate.chats !== 'object' || candidate.chats === null || Array.isArray(candidate.chats)) {
    return false;
  }

  return Object.values(candidate.chats).every((entries) => Array.isArray(entries) && entries.every(isKeyMemoryEntry));
}

export function extractKeyMemoryCandidates(text: string): Array<Omit<KeyMemoryEntry, 'updatedAt'>> {
  const candidates: Array<Omit<KeyMemoryEntry, 'updatedAt'>> = [];
  const normalized = text.trim();
  if (!normalized) {
    return candidates;
  }

  const rules: Array<{ regex: RegExp; category: KeyMemoryEntry['category']; priority: number }> = [
    { regex: /(项目代号[^。！？\n]{1,120})/g, category: 'project', priority: 90 },
    { regex: /(默认使用[^。！？\n]{1,120})/g, category: 'decision', priority: 80 },
    { regex: /(统一走[^。！？\n]{1,120})/g, category: 'decision', priority: 80 },
    { regex: /(截止日期[^。！？\n]{1,120})/g, category: 'deadline', priority: 95 },
    { regex: /(截至[^。！？\n]{1,120})/g, category: 'deadline', priority: 90 },
    { regex: /(请用[^。！？\n]{1,120})/g, category: 'preference', priority: 75 },
    { regex: /(我喜欢[^。！？\n]{1,120})/g, category: 'preference', priority: 70 },
    { regex: /(我偏好[^。！？\n]{1,120})/g, category: 'preference', priority: 70 },
  ];

  for (const rule of rules) {
    for (const match of normalized.matchAll(rule.regex)) {
      const textMatch = match[1]?.trim();
      if (textMatch) {
        candidates.push({ text: textMatch, category: rule.category, priority: rule.priority });
      }
    }
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: Array<Omit<KeyMemoryEntry, 'updatedAt'>>): Array<Omit<KeyMemoryEntry, 'updatedAt'>> {
  const seen = new Set<string>();
  const result: Array<Omit<KeyMemoryEntry, 'updatedAt'>> = [];
  for (const item of candidates) {
    const key = `${item.category}:${item.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

export class KeyMemoryStore {
  private readonly filePath: string;
  private cache: KeyMemoryFile;

  constructor(baseDir: string, private readonly maxEntriesPerChat: number) {
    this.filePath = path.join(baseDir, FILE_NAME);
    this.cache = this.load();
  }

  upsert(chatId: string, entry: KeyMemoryEntry): void {
    const entries = this.cache.chats[chatId] ?? [];
    const existing = entries.find((item) => item.text === entry.text && item.category === entry.category);
    if (existing) {
      existing.priority = Math.max(existing.priority, entry.priority);
      existing.updatedAt = entry.updatedAt;
    } else {
      entries.push(entry);
    }
    this.cache.chats[chatId] = this.sort(entries).slice(0, this.maxEntriesPerChat);
    this.save();
  }

  getEntries(chatId: string): KeyMemoryEntry[] {
    return [...(this.cache.chats[chatId] ?? [])];
  }

  render(chatId: string): string {
    const entries = this.getEntries(chatId);
    if (entries.length === 0) {
      return '(无)';
    }
    return entries.map((entry) => `- ${entry.text}`).join('\n');
  }

  private sort(entries: KeyMemoryEntry[]): KeyMemoryEntry[] {
    return [...entries].sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }

  private load(): KeyMemoryFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
        if (isKeyMemoryFile(parsed)) {
          return parsed;
        }
      }
    } catch {
      // ignore and create empty store
    }
    return { chats: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8');
  }
}
