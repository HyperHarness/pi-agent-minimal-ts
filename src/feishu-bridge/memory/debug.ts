import type { ChatTurn, ParsedIncomingMessage } from '../types.js';

export interface MemoryDebugPayload {
  message: ParsedIncomingMessage;
  sessionDir?: string;
  history: ChatTurn[];
  userMemoryText: string;
  groupMemoryText: string;
  keyMemoryText: string;
  webContext: string;
}

function normalizeMemoryItems(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed === '(无)' || trimmed === '(无联网结果)' || trimmed === '(无历史上下文)') {
    return [];
  }

  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('：'))
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

export function buildMemoryDebugLines(payload: MemoryDebugPayload): string[] {
  const userItems = normalizeMemoryItems(payload.userMemoryText);
  const groupItems = normalizeMemoryItems(payload.groupMemoryText);
  const keyItems = normalizeMemoryItems(payload.keyMemoryText);
  const webItems = normalizeMemoryItems(payload.webContext);
  const historyPreview = payload.history
    .slice(-3)
    .map((turn) => `${turn.role}:${turn.text}`)
    .join(' | ') || '(empty)';

  return [
    `chat=${payload.message.chatId} sender=${payload.message.senderName} session_dir=${payload.sessionDir || 'stateless'}`,
    `history_turns=${payload.history.length} history_preview=${historyPreview}`,
    `user_memory_hits=${userItems.length} ${userItems.join(' | ') || '(none)'}`,
    `group_memory_hits=${groupItems.length} ${groupItems.join(' | ') || '(none)'}`,
    `key_memory_hits=${keyItems.length} ${keyItems.join(' | ') || '(none)'}`,
    `web_hits=${webItems.length} ${webItems.join(' | ') || '(none)'}`,
  ];
}
