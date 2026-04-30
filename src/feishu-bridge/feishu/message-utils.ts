import type { ChatTurn, ParsedIncomingMessage } from '../types.js';

export interface BridgeFilterConfig {
  allowedChatIds: string[];
  requireMentionInGroups: boolean;
  learnFromAllGroupMessages?: boolean;
}

export function extractTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === 'string') {
      return parsed.text.trim();
    }
  } catch {
    // ignore parse errors and fall back to raw content
  }

  return content.trim();
}

export function stripBotMention(text: string, aliases: string[]): string {
  let next = text;

  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^\\s*@${escaped}[\\s:：,，-]*`, 'i'),
      new RegExp(`^\\s*${escaped}[\\s:：,，-]+`, 'i'),
    ];

    for (const pattern of patterns) {
      next = next.replace(pattern, '');
    }
  }

  return next.trim();
}

export function shouldRespondToMessage(
  message: ParsedIncomingMessage,
  config: BridgeFilterConfig,
): boolean {
  if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(message.chatId)) {
    return false;
  }

  if (message.isDirectMessage) {
    return true;
  }

  if (config.requireMentionInGroups) {
    return message.mentionsBot;
  }

  return true;
}

export function shouldStoreAsPassiveMemory(
  message: ParsedIncomingMessage,
  config: BridgeFilterConfig,
): boolean {
  if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(message.chatId)) {
    return false;
  }

  if (!config.learnFromAllGroupMessages) {
    return false;
  }

  if (message.isDirectMessage) {
    return false;
  }

  if (message.mentionsBot) {
    return false;
  }

  return true;
}

export interface PromptMemoryContext {
  userMemory?: string;
  groupMemory?: string;
  keyMemory?: string;
  webContext?: string;
  maxRecentTurns?: number;
  includeAgentMessagesInHistory?: boolean;
}

export function buildAgentPrompt(
  message: ParsedIncomingMessage,
  history: ChatTurn[],
  instruction?: string,
  memoryContext?: PromptMemoryContext,
): string {
  const maxRecentTurns = memoryContext?.maxRecentTurns ?? 10;
  const includeAgentMessagesInHistory = memoryContext?.includeAgentMessagesInHistory ?? false;
  const promptHistory = includeAgentMessagesInHistory
    ? history
    : history.filter((turn) => turn.role !== 'assistant');
  const recentHistory = promptHistory.slice(-maxRecentTurns);
  const historyBlock = recentHistory.length
    ? recentHistory
        .map((turn) => {
          if (turn.role === 'assistant') {
            return `助手: ${turn.text}`;
          }
          return `${turn.senderName || '用户'}: ${turn.text}`;
        })
        .join('\n')
    : '(无历史上下文)';

  const instructionBlock = instruction?.trim() || '请用简洁、直接、适合飞书群聊的方式回答。';
  const userMemory = memoryContext?.userMemory?.trim() || '(无)';
  const groupMemory = memoryContext?.groupMemory?.trim() || '(无)';
  const keyMemory = memoryContext?.keyMemory?.trim() || '(无)';
  const webContext = memoryContext?.webContext?.trim() || '(无联网结果)';

  return [
    '你正在通过飞书桥接插件回复消息。',
    `当前发送者：${message.senderName} (${message.senderId})`,
    `当前会话：${message.chatId}`,
    '',
    `最近${maxRecentTurns}条群消息/对话：`,
    historyBlock,
    '',
    '用户长期记忆：',
    userMemory,
    '',
    '群长期记忆：',
    groupMemory,
    '',
    '关键信息记忆：',
    keyMemory,
    '',
    '联网搜索结果：',
    webContext,
    '',
    `附加要求：${instructionBlock}`,
    `当前用户消息：${message.text}`,
  ].join('\n');
}
