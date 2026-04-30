export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  senderId?: string;
  senderName?: string;
}

export interface ParsedIncomingMessage {
  chatId: string;
  chatType: 'p2p' | 'group' | string;
  isDirectMessage: boolean;
  mentionsBot: boolean;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  threadId?: string;
}

export interface PromptContextOptions {
  instruction?: string;
}

export interface ChatMemoryFile {
  chats: Record<string, ChatTurn[]>;
}
