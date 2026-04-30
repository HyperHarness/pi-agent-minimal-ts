import * as Lark from '@larksuiteoapi/node-sdk';
import { log } from './colors.js';
import { loadConfig } from './config.js';
import { runAgentWithWebSearch } from './agent-web-search.js';
import {
  buildAgentPrompt,
  extractTextContent,
  shouldRespondToMessage,
  shouldStoreAsPassiveMemory,
  stripBotMention,
} from './feishu/message-utils.js';
import {
  buildErrorCardContent,
  buildStatusCardContent,
  buildStreamingCardContent,
  buildThinkingCardContent,
} from './feishu/card-builder.js';
import { detectBotMention } from './feishu/mention-detection.js';
import { resolveSenderName } from './feishu/sender-name.js';
import { StreamUpdater } from './feishu/stream-updater.js';
import { sendReplyWithRetry } from './feishu/reply-sender.js';
import { ChatMemoryStore } from './memory/chat-memory.js';
import { buildMemoryDebugLines } from './memory/debug.js';
import { extractDurableGroupFacts, extractDurableUserFacts } from './memory/extractors.js';
import { KeyMemoryStore, extractKeyMemoryCandidates } from './memory/key-memory.js';
import { LongTermMemoryStore } from './memory/long-term-memory.js';
import { PiRpcClient } from './pi-client.js';
import { buildPiClientOptionsForMessage, getPiClientKey } from './pi-session.js';
import { startPiClientWithRetry } from './pi-client-retry.js';
import { buildSearchQuery, formatWebResults, searchWeb } from './web/search.js';
import { createPerKeyQueue } from './chat-queue.js';
import type { ParsedIncomingMessage } from './types.js';

const config = loadConfig();
const memory = new ChatMemoryStore(config.memory.dir, config.memory.historyLimit);
const longTermMemory = new LongTermMemoryStore(config.memory.dir);
const keyMemory = new KeyMemoryStore(config.memory.dir, 50);
const processedMessageIds = new Set<string>();
const messageQueue = createPerKeyQueue();
const PROCESSED_CACHE_LIMIT = 1000;
const defaultPiSessionRoot = config.pi.sessionDir || `${config.memory.dir}/pi-sessions`;
const piClients = new Map<string, PiRpcClient>();

function trimProcessedCache(): void {
  if (processedMessageIds.size <= PROCESSED_CACHE_LIMIT) {
    return;
  }
  const toDelete = Array.from(processedMessageIds).slice(0, 100);
  for (const id of toDelete) {
    processedMessageIds.delete(id);
  }
}

async function ensurePiClient(message: ParsedIncomingMessage): Promise<PiRpcClient> {
  const options = buildPiClientOptionsForMessage(config.pi, message, defaultPiSessionRoot);
  const clientKey = getPiClientKey(options);
  const existingClient = piClients.get(clientKey);
  if (existingClient?.isProcessReady()) {
    return existingClient;
  }

  if (existingClient) {
    existingClient.stop();
    piClients.delete(clientKey);
  }

  const client = await startPiClientWithRetry({
    maxAttempts: 2,
    createClient: () => {
      const nextClient = new PiRpcClient(options);
      nextClient.on('stderr', (stderrMessage: string) => log.pi(stderrMessage.trim()));
      nextClient.on('exit', (code: number) => {
        log.warn(`PI 进程退出[${clientKey}]: ${code}`);
        if (piClients.get(clientKey) === nextClient) {
          piClients.delete(clientKey);
        }
      });
      nextClient.on('error', (error: unknown) => {
        log.error(`PI 客户端错误[${clientKey}]`, error);
      });
      return nextClient;
    },
  });
  piClients.set(clientKey, client as PiRpcClient);
  log.pi(`PI RPC 已连接[${clientKey}]`);
  return client as PiRpcClient;
}

function pickSenderId(sender: any): string {
  return sender?.sender_id?.open_id ?? sender?.sender_id?.user_id ?? sender?.sender_id ?? sender?.id?.open_id ?? 'unknown';
}

function pickSenderName(sender: any): string {
  return sender?.sender_name ?? sender?.name ?? sender?.sender_id?.open_id ?? 'unknown';
}

function mentionsBot(event: any, text: string): boolean {
  const mentions = event?.message?.mentions ?? event?.mentions ?? [];
  if (Array.isArray(mentions) && mentions.length > 0) {
    if (!config.feishu.botOpenId) {
      return true;
    }
    return mentions.some((mention: any) => {
      const mentionId = mention?.id?.open_id ?? mention?.id ?? mention?.open_id;
      return mentionId === config.feishu.botOpenId;
    });
  }

  return config.feishu.botAliases.some((alias) => {
    const lower = alias.toLowerCase();
    const normalized = text.trim().toLowerCase();
    return normalized.startsWith(`@${lower}`) || normalized.startsWith(lower);
  });
}

async function lookupUserName(client: Lark.Client, openId: string): Promise<string | undefined> {
  try {
    const response = await client.contact.v3.user.get({
      path: {
        user_id: openId,
      },
      params: {
        user_id_type: 'open_id',
      },
    });

    return response.data?.user?.name || response.data?.user?.nickname;
  } catch (error) {
    log.warn(`用户姓名查询失败，回退到 open_id: ${openId}`);
    return undefined;
  }
}

async function parseIncomingMessage(client: Lark.Client, data: any): Promise<ParsedIncomingMessage | null> {
  const rawContent = data?.message?.content;
  if (!rawContent || data?.message?.message_type !== 'text') {
    return null;
  }

  const originalText = extractTextContent(rawContent);
  const cleanedText = stripBotMention(originalText, config.feishu.botAliases);
  const chatType = data?.message?.chat_type ?? data?.chat_type ?? 'group';
  const senderId = pickSenderId(data?.sender);
  const senderName = await resolveSenderName(data, async (openId: string) => lookupUserName(client, openId));

  return {
    chatId: data?.message?.chat_id,
    chatType,
    isDirectMessage: chatType === 'p2p',
    mentionsBot: detectBotMention(data, originalText, {
      botOpenId: config.feishu.botOpenId,
      botAliases: config.feishu.botAliases,
    }),
    messageId: data?.message?.message_id,
    senderId,
    senderName,
    text: cleanedText || originalText,
    threadId: data?.message?.thread_id,
  };
}

function isTextStreamMode(): boolean {
  return config.feishu.streamMode === 'text';
}

function isCardToTextMode(): boolean {
  return config.feishu.streamMode === 'card_to_text';
}

function isTextFinalMode(): boolean {
  return isTextStreamMode() || isCardToTextMode();
}

function shouldPatchExistingTextMessage(): boolean {
  return isTextStreamMode();
}

function buildThinkingTextContent(placeholderText: string): string {
  return placeholderText;
}

function buildStatusTextContent(status: string, detail: string): string {
  return `${status}：${detail}`;
}

function buildStreamingTextContent(_senderName: string, answer: string): string {
  return answer;
}

function resolveReplyToMessageId(
  messageId: string | undefined,
  isDirectMessage: boolean,
): string | undefined {
  if (!config.feishu.replyToMessage || !messageId || isDirectMessage) {
    return undefined;
  }
  return messageId;
}

async function sendTextMessage(
  client: Lark.Client,
  chatId: string,
  text: string,
  replyToMessageId?: string,
): Promise<string | undefined> {
  if (config.feishu.replyToMessage && replyToMessageId) {
    const replyResult = await sendReplyWithRetry({
      messageId: replyToMessageId,
      msgType: 'text',
      content: JSON.stringify({ text }),
      replyInThread: config.feishu.replyInThread,
      reply: (payload) => client.im.v1.message.reply(payload),
    });

    if (replyResult.messageId) {
      return replyResult.messageId;
    }

    if (!replyResult.fallbackToCreate) {
      log.warn(`回复文本消息状态未明，跳过回退新建消息以避免重复: ${replyResult.detail || 'unknown error'}`);
      return undefined;
    }

    log.warn(`回复文本消息失败，回退到新建消息: ${replyResult.detail || 'unknown error'}`);
  }

  const response = await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });

  return response.data?.message_id;
}

async function patchTextMessage(client: Lark.Client, messageId: string, text: string): Promise<void> {
  await patchTextOnExistingMessage(client, messageId, text);
}

async function sendCardMessage(
  client: Lark.Client,
  chatId: string,
  cardContent: string,
  replyToMessageId?: string,
): Promise<string | undefined> {
  if (config.feishu.replyToMessage && replyToMessageId) {
    const replyResult = await sendReplyWithRetry({
      messageId: replyToMessageId,
      msgType: 'interactive',
      content: cardContent,
      replyInThread: config.feishu.replyInThread,
      reply: (payload) => client.im.v1.message.reply(payload),
    });

    if (replyResult.messageId) {
      return replyResult.messageId;
    }

    if (!replyResult.fallbackToCreate) {
      log.warn(`回复卡片消息状态未明，跳过回退新建消息以避免重复: ${replyResult.detail || 'unknown error'}`);
      return undefined;
    }

    log.warn(`回复卡片消息失败，回退到新建消息: ${replyResult.detail || 'unknown error'}`);
  }

  const response = await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: cardContent,
    },
  });

  return response.data?.message_id;
}

async function patchCardMessage(client: Lark.Client, messageId: string, cardContent: string): Promise<void> {
  await client.im.v1.message.patch({
    path: {
      message_id: messageId,
    },
    data: {
      content: cardContent,
    },
  });
}

async function patchTextOnExistingMessage(client: Lark.Client, messageId: string, text: string): Promise<void> {
  const messageResource = client.im.v1.message as unknown as {
    update?: (payload: { data: { msg_type: 'text'; content: string }; path: { message_id: string } }) => Promise<unknown>;
    patch?: (payload: { data: { content: string }; path: { message_id: string } }) => Promise<unknown>;
  };

  if (typeof messageResource.update === 'function') {
    await messageResource.update({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    return;
  }

  if (typeof messageResource.patch === 'function') {
    await messageResource.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({ text }),
      },
    });
    return;
  }

  throw new Error('当前SDK不支持im.message更新文本内容');
}

async function sendThinkingMessage(
  client: Lark.Client,
  chatId: string,
  senderName: string,
  replyToMessageId?: string,
): Promise<string | undefined> {
  if (isTextStreamMode()) {
    return sendTextMessage(client, chatId, buildThinkingTextContent(config.feishu.placeholderText), replyToMessageId);
  }

  return sendCardMessage(client, chatId, buildThinkingCardContent(senderName, config.feishu.placeholderText), replyToMessageId);
}

async function patchProgressMessage(
  client: Lark.Client,
  messageId: string,
  senderName: string,
  status: string,
  detail: string,
  statusColor: 'blue' | 'green' | 'red',
): Promise<void> {
  if (isTextStreamMode()) {
    await patchTextMessage(client, messageId, buildStatusTextContent(status, detail));
    return;
  }

  await patchCardMessage(
    client,
    messageId,
    buildStatusCardContent({
      senderName,
      status,
      detail,
      statusColor,
    }),
  );
}

async function patchStreamingMessage(
  client: Lark.Client,
  messageId: string,
  senderName: string,
  answer: string,
  isFinal: boolean,
): Promise<void> {
  if (isTextStreamMode()) {
    await patchTextMessage(client, messageId, buildStreamingTextContent(senderName, answer));
    return;
  }

  await patchCardMessage(
    client,
    messageId,
    buildStreamingCardContent({
      senderName,
      answer,
      isFinal,
    }),
  );
}

async function sendErrorMessage(
  client: Lark.Client,
  chatId: string,
  error: string,
  messageId?: string,
  replyToMessageId?: string,
): Promise<void> {
  const errorText = buildErrorText(error);
  const shouldOutputText = isTextFinalMode();

  if (shouldOutputText) {
    if (shouldPatchExistingTextMessage() && messageId) {
      try {
        await patchTextMessage(client, messageId, errorText);
      } catch (error) {
        log.warn(`错误信息更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
        await sendTextMessage(client, chatId, errorText, replyToMessageId);
      }
      return;
    }

    await sendTextMessage(client, chatId, errorText, replyToMessageId);
    return;
  }

  if (!messageId) {
    await sendCardMessage(client, chatId, buildErrorCardContent(errorText), replyToMessageId);
    return;
  }

  await patchCardMessage(client, messageId, buildErrorCardContent(errorText));
}

function buildErrorText(message: string): string {
  return message;
}
function saveLongTermMemory(message: ParsedIncomingMessage): void {
  if (!config.memory.longTermEnabled) {
    return;
  }

  for (const fact of extractDurableUserFacts(message.text)) {
    longTermMemory.upsertUserFact(message.senderId, fact, 'preference');
  }

  for (const fact of extractDurableGroupFacts(message.text)) {
    longTermMemory.upsertGroupFact(message.chatId, fact, 'fact');
  }

  const now = new Date().toISOString();
  for (const item of extractKeyMemoryCandidates(message.text)) {
    keyMemory.upsert(message.chatId, {
      ...item,
      updatedAt: now,
    });
  }
}

function storePassiveMemory(message: ParsedIncomingMessage): void {
  const now = new Date().toISOString();
  memory.appendTurn(message.chatId, {
    role: 'user',
    text: message.text,
    timestamp: now,
    senderId: message.senderId,
    senderName: message.senderName,
  });
  saveLongTermMemory(message);
}

async function processMessage(client: Lark.Client, message: ParsedIncomingMessage): Promise<void> {
  if (!message.chatId || !message.messageId || !message.text.trim()) {
    return;
  }

  log.feishu(`收到消息 chat=${message.chatId} sender=${message.senderName}: ${message.text}`);

  const replyTargetMessageId = resolveReplyToMessageId(message.messageId, message.isDirectMessage);
  const replyMessageId = await sendThinkingMessage(client, message.chatId, message.senderName, replyTargetMessageId);

  const history = memory.getTurns(message.chatId);
  const piClientOptions = buildPiClientOptionsForMessage(config.pi, message, defaultPiSessionRoot);
  const userMemoryText = config.memory.longTermEnabled ? longTermMemory.renderUserMemory(message.senderId) : '(无)';
  const groupMemoryText = config.memory.longTermEnabled ? longTermMemory.renderGroupMemory(message.chatId) : '(无)';
  const keyMemoryText = config.memory.longTermEnabled ? keyMemory.render(message.chatId) : '(无)';
  let webContext = '(无联网结果)';
  const piClientPromise = ensurePiClient(message);
  const maxAgentWebSearchSteps = 7;

  const runSearchAndFormat = async (query: string, reason: 'initial' | 'agent'): Promise<string> => {
    const cleanedQuery = buildSearchQuery(query);
    if (!cleanedQuery) {
      return '(无联网结果)';
    }

    log.info(`${reason === 'initial' ? '触发' : 'Agent请求'}联网搜索: ${cleanedQuery}`);
    if (replyMessageId) {
      try {
        await patchProgressMessage(
          client,
          replyMessageId,
          message.senderName,
          '联网搜索中',
          `正在联网搜索：${cleanedQuery}`,
          'blue',
        );
      } catch (error) {
        log.warn(`状态更新失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const results = await searchWeb(cleanedQuery, config.web.maxResults);
      return formatWebResults(results);
    } catch (error) {
      const failureMessage = `联网搜索失败：${error instanceof Error ? error.message : String(error)}`;
      log.warn(failureMessage);
      return failureMessage;
    }
  };

  const buildPromptForWebContext = (currentWebContext: string): string =>
    buildAgentPrompt(message, history, config.bridge.promptInstruction, {
      userMemory: userMemoryText,
      groupMemory: groupMemoryText,
      keyMemory: keyMemoryText,
      webContext: currentWebContext,
      maxRecentTurns: 10,
    });

  for (const debugLine of buildMemoryDebugLines({
    message,
    sessionDir: piClientOptions.sessionDir,
    history,
    userMemoryText,
    groupMemoryText,
    keyMemoryText,
    webContext,
  })) {
    log.memory(debugLine);
  }
  const updater = new StreamUpdater({
    enabled: config.feishu.streamUpdates && Boolean(replyMessageId),
    intervalMs: config.feishu.streamUpdateIntervalMs,
    maxMessageLength: config.feishu.maxReplyChars,
    patchMessage: async (content: string) => {
      if (replyMessageId) {
        try {
          await patchStreamingMessage(client, replyMessageId, message.senderName, content, false);
        } catch (error) {
          log.warn(`流式更新失败: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  });

  const pi = await piClientPromise;

  try {
    const agentResult = await runAgentWithWebSearch({
      initialWebContext: webContext,
      maxSearchSteps: config.web.enabled ? maxAgentWebSearchSteps : 0,
      buildPrompt: buildPromptForWebContext,
      promptAgent: async (prompt: string) => pi.prompt(prompt),
      search: async (query: string) => runSearchAndFormat(query, 'agent'),
      onSearchRequest: async (query: string) => {
        log.info(`Agent主动请求追加联网搜索: ${buildSearchQuery(query)}`);
      },
    });
    const finalResponse = agentResult.finalResponse;
    webContext = agentResult.webContext;
    const finalAsText = isTextFinalMode();
    await updater.complete(finalResponse);

    const finalCardContent = buildStreamingCardContent({
      senderName: message.senderName,
      answer: finalResponse,
      isFinal: true,
    });

    if (!replyMessageId) {
      if (finalAsText) {
        await sendTextMessage(client, message.chatId, finalResponse, replyTargetMessageId);
      } else {
        await sendCardMessage(client, message.chatId, finalCardContent, replyTargetMessageId);
      }
    } else {
      try {
        if (isTextStreamMode()) {
          await patchTextMessage(client, replyMessageId, finalResponse);
        } else if (isCardToTextMode()) {
          await sendTextMessage(client, message.chatId, finalResponse, replyTargetMessageId);
        } else {
          await patchStreamingMessage(client, replyMessageId, message.senderName, finalResponse, true);
        }
      } catch (error) {
        log.warn(`最终消息更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
        if (isCardToTextMode()) {
          await sendTextMessage(client, message.chatId, finalResponse, replyTargetMessageId);
        } else if (finalAsText) {
          await sendTextMessage(client, message.chatId, finalResponse, replyTargetMessageId);
        } else {
          await sendCardMessage(client, message.chatId, finalCardContent, replyTargetMessageId);
        }
      }
    }

    const now = new Date().toISOString();
    memory.appendTurn(message.chatId, {
      role: 'user',
      text: message.text,
      timestamp: now,
      senderId: message.senderId,
      senderName: message.senderName,
    });
    memory.appendTurn(message.chatId, { role: 'assistant', text: finalResponse, timestamp: new Date().toISOString() });
    saveLongTermMemory(message);
    log.feishu(`回复完成 message=${message.messageId}`);
  } catch (error) {
    const fallback = `抱歉，处理消息时出现错误：${error instanceof Error ? error.message : String(error)}`;
    try {
      await sendErrorMessage(client, message.chatId, fallback, replyMessageId, replyTargetMessageId);
    } catch (sendError) {
      log.error('发送错误消息失败', sendError);
    }
    log.error('处理飞书消息失败', error);
  }
}

async function main(): Promise<void> {
  const client = new Lark.Client({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  });

  const wsClient = new Lark.WSClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  const eventDispatcher = new Lark.EventDispatcher(
    config.feishu.encryptKey ? { encryptKey: config.feishu.encryptKey } : {},
  ).register({
    'im.message.receive_v1': async (data: any) => {
      const rawMentions = data?.message?.mentions ?? data?.mentions ?? [];
      if (Array.isArray(rawMentions) && rawMentions.length > 0) {
        log.info(`收到消息 mentions: ${JSON.stringify(rawMentions)}`);
      }

      const message = await parseIncomingMessage(client, data);
      if (!message) {
        return;
      }

      if (processedMessageIds.has(message.messageId)) {
        log.queue(`忽略重复消息: ${message.messageId}`);
        return;
      }
      processedMessageIds.add(message.messageId);
      trimProcessedCache();

      if (!shouldRespondToMessage(message, {
        allowedChatIds: config.feishu.allowedChatIds,
        requireMentionInGroups: config.feishu.requireMentionInGroups,
        learnFromAllGroupMessages: config.memory.learnFromAllGroupMessages,
      })) {
        if (shouldStoreAsPassiveMemory(message, {
          allowedChatIds: config.feishu.allowedChatIds,
          requireMentionInGroups: config.feishu.requireMentionInGroups,
          learnFromAllGroupMessages: config.memory.learnFromAllGroupMessages,
        })) {
          storePassiveMemory(message);
          log.queue(`已记录非@群消息到记忆: ${message.messageId}`);
        } else {
          log.queue(`消息未命中响应规则: ${message.messageId}`);
        }
        return;
      }

      messageQueue.enqueue(message.chatId, async () => {
        await processMessage(client, message);
      });
    },
  });

  log.feishu('正在连接飞书长连接...');
  await wsClient.start({ eventDispatcher });
  log.feishu('飞书桥接服务已启动，等待消息中。');
}

function shutdown(): void {
  log.warn('收到退出信号，正在关闭...');
  for (const client of piClients.values()) {
    client.stop();
  }
  piClients.clear();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((error) => {
  log.error('启动失败', error);
  process.exit(1);
});
