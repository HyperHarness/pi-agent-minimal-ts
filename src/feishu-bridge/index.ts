import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
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
import { splitLongTextForFeishu } from './feishu/long-message.js';
import { buildAgentToolProgressText, formatAgentToolStatus, type AgentToolStatus } from './agent-tool-status.js';
import {
  extractDownloadedPdfAttachment,
  extractPdfAttachmentsFromText,
  extractQueuedPdfDeliveryJob,
  parseCompiledPaperPdfDeliveryCommand,
  resolveDownloadedPdfAttachmentsForQueuedJobs,
  resolveCompiledPaperPdfAttachment,
  type DownloadedPdfAttachment,
  type QueuedPdfDeliveryJob,
} from './feishu/pdf-delivery.js';
import { ChatMemoryStore } from './memory/chat-memory.js';
import { buildMemoryDebugLines } from './memory/debug.js';
import { extractDurableGroupFacts, extractDurableUserFacts } from './memory/extractors.js';
import { KeyMemoryStore, extractKeyMemoryCandidates } from './memory/key-memory.js';
import { LongTermMemoryStore } from './memory/long-term-memory.js';
import { PiRpcClient, type PiEvent } from './pi-client.js';
import { buildPiClientOptionsForMessage, getPiClientKey } from './pi-session.js';
import { startPiClientWithRetry } from './pi-client-retry.js';
import { buildSearchQuery, formatWebResults, searchWeb } from './web/search.js';
import { createPerKeyQueue } from './chat-queue.js';
import {
  autoCommitManagedRepos,
  captureManagedRepoSnapshots,
  parseManagedRepoCommand,
  runManagedRepoCommand,
  type ManagedRepoSnapshot,
} from './paper-git.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function compactLogText(value: unknown, maxLength = 180): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const compacted = value.replace(/\s+/g, ' ').trim();
  if (!compacted) {
    return undefined;
  }

  return compacted.length > maxLength
    ? `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
    : compacted;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
  return compactLogText(record[key], 220);
}

function formatArgsSummary(args: unknown): string {
  if (!isRecord(args)) {
    return '';
  }

  const fields = ['query', 'url', 'id', 'path', 'texPath', 'paperKey', 'topic', 'question']
    .map((key) => {
      const value = getStringField(args, key);
      return value ? `${key}=${value}` : undefined;
    })
    .filter(Boolean);

  return fields.length > 0 ? ` ${fields.join(' ')}` : '';
}

function formatToolResultSummary(result: unknown): string {
  if (!isRecord(result)) {
    return '';
  }

  const details = isRecord(result.details) ? result.details : undefined;
  if (!details) {
    return '';
  }

  const fields = ['status', 'source', 'query', 'count', 'jobId', 'paperKey', 'canonicalId', 'articleUrl', 'recordPath', 'message']
    .map((key) => {
      const value = typeof details[key] === 'number' ? String(details[key]) : getStringField(details, key);
      return value ? `${key}=${value}` : undefined;
    })
    .filter(Boolean);

  return fields.length > 0 ? ` ${fields.join(' ')}` : '';
}

function formatToolProgressSummary(partialResult: unknown): string {
  if (!isRecord(partialResult)) {
    return '';
  }

  const details = isRecord(partialResult.details) ? partialResult.details : undefined;
  const progress = details && isRecord(details.progress) ? details.progress : undefined;
  const progressMessage = progress ? getStringField(progress, 'message') : undefined;
  if (progressMessage) {
    return ` ${progressMessage}`;
  }

  const content = Array.isArray(partialResult.content) ? partialResult.content : [];
  const text = content
    .filter(isRecord)
    .find((item) => item.type === 'text' && typeof item.text === 'string')?.text;
  const compactText = compactLogText(text, 220);
  return compactText ? ` ${compactText}` : '';
}

function logPiEvent(clientKey: string, event: PiEvent): void {
  const toolName = compactLogText(event.toolName, 80) ?? 'unknown_tool';

  if (event.type === 'tool_execution_start') {
    log.pi(`[${clientKey}] tool:start ${toolName}${formatArgsSummary(event.args)}`);
    return;
  }

  if (event.type === 'tool_execution_update') {
    log.pi(`[${clientKey}] tool:progress ${toolName}${formatToolProgressSummary(event.partialResult)}`);
    return;
  }

  if (event.type === 'tool_execution_end') {
    const status = event.isError === true ? 'error' : 'ok';
    log.pi(`[${clientKey}] tool:end ${toolName} ${status}${formatToolResultSummary(event.result)}`);
    return;
  }

  if (event.type === 'agent_end') {
    log.pi(`[${clientKey}] agent:end`);
  }
}

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
      nextClient.on('event', (event: PiEvent) => logPiEvent(clientKey, event));
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

async function sendTextMessageChunks(
  client: Lark.Client,
  chatId: string,
  chunks: string[],
  replyToMessageId?: string,
): Promise<string | undefined> {
  let firstMessageId: string | undefined;

  for (const chunk of chunks) {
    const messageId = await sendTextMessage(client, chatId, chunk, replyToMessageId);
    firstMessageId ??= messageId;
  }

  return firstMessageId;
}

async function uploadPdfFile(client: Lark.Client, attachment: DownloadedPdfAttachment): Promise<string> {
  const response = await client.im.v1.file.create({
    data: {
      file_type: 'pdf',
      file_name: attachment.fileName,
      file: createReadStream(attachment.path),
    },
  });

  if (!response?.file_key) {
    throw new Error('飞书文件上传未返回 file_key');
  }

  return response.file_key;
}

async function deliverPdfAttachment(
  client: Lark.Client,
  chatId: string,
  attachment: DownloadedPdfAttachment,
  replyToMessageId?: string,
): Promise<string> {
  const info = await stat(attachment.path);
  if (!info.isFile()) {
    throw new Error(`PDF 路径不是文件：${attachment.path}`);
  }

  if (info.size > config.feishu.maxPdfUploadMb * 1024 * 1024) {
    throw new Error(
      `PDF 文件超过飞书上传限制：${attachment.fileName} (${Math.ceil(info.size / 1024 / 1024)} MB > ${config.feishu.maxPdfUploadMb} MB)`,
    );
  }

  const fileKey = await uploadPdfFile(client, attachment);
  await sendFileMessage(client, chatId, fileKey, replyToMessageId);
  log.feishu(`PDF 文件已发送: ${attachment.fileName}`);
  return `已发送编译后的论文 PDF：${attachment.fileName}`;
}

async function sendFileMessage(
  client: Lark.Client,
  chatId: string,
  fileKey: string,
  replyToMessageId?: string,
): Promise<string | undefined> {
  const content = JSON.stringify({ file_key: fileKey });

  if (config.feishu.replyToMessage && replyToMessageId) {
    const replyResult = await sendReplyWithRetry({
      messageId: replyToMessageId,
      msgType: 'file',
      content,
      replyInThread: config.feishu.replyInThread,
      reply: (payload) => client.im.v1.message.reply(payload),
    });

    if (replyResult.messageId) {
      return replyResult.messageId;
    }

    if (!replyResult.fallbackToCreate) {
      log.warn(`回复 PDF 文件消息状态未明，跳过回退新建消息以避免重复: ${replyResult.detail || 'unknown error'}`);
      return undefined;
    }

    log.warn(`回复 PDF 文件消息失败，回退到新建消息: ${replyResult.detail || 'unknown error'}`);
  }

  const response = await client.im.v1.message.create({
    params: {
      receive_id_type: 'chat_id',
    },
    data: {
      receive_id: chatId,
      msg_type: 'file',
      content,
    },
  });

  return response.data?.message_id;
}

async function sendDownloadedPdfAttachments(
  client: Lark.Client,
  chatId: string,
  attachments: DownloadedPdfAttachment[],
  replyToMessageId?: string,
): Promise<void> {
  if (!config.feishu.sendDownloadedPdf || attachments.length === 0) {
    return;
  }

  for (const attachment of attachments) {
    try {
      await deliverPdfAttachment(client, chatId, attachment, replyToMessageId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`PDF 文件发送失败 ${attachment.fileName}: ${message}`);
      await sendTextMessage(client, chatId, `PDF 文件发送失败：${attachment.fileName} (${message})`, replyToMessageId).catch(() => {});
    }
  }
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

async function sendBridgeCommandResult(
  client: Lark.Client,
  chatId: string,
  senderName: string,
  text: string,
  replyMessageId?: string,
  replyToMessageId?: string,
): Promise<void> {
  const chunks = splitLongTextForFeishu(text, config.feishu.maxReplyChars);
  if (!replyMessageId) {
    await sendTextMessageChunks(client, chatId, chunks, replyToMessageId);
    return;
  }

  if (isTextStreamMode()) {
    try {
      await patchTextMessage(client, replyMessageId, chunks[0] ?? text);
    } catch (error) {
      log.warn(`桥接命令结果更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
      await sendTextMessage(client, chatId, chunks[0] ?? text, replyToMessageId);
    }
    if (chunks.length > 1) {
      await sendTextMessageChunks(client, chatId, chunks.slice(1), replyToMessageId);
    }
    return;
  }

  if (isCardToTextMode()) {
    await sendTextMessageChunks(client, chatId, chunks, replyToMessageId);
    return;
  }

  try {
    await patchStreamingMessage(client, replyMessageId, senderName, chunks[0] ?? text, true);
  } catch (error) {
    log.warn(`桥接命令卡片更新失败，改为发送文本消息: ${error instanceof Error ? error.message : String(error)}`);
    await sendTextMessage(client, chatId, chunks[0] ?? text, replyToMessageId);
  }
  if (chunks.length > 1) {
    await sendTextMessageChunks(client, chatId, chunks.slice(1), replyToMessageId);
  }
}

function buildErrorText(message: string): string {
  return message;
}

function buildLongReplyNotice(chunkCount: number): string {
  return `回答较长，已拆分为 ${chunkCount} 段文本发送。`;
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
  const repoCommand = parseManagedRepoCommand(message.text);
  if (repoCommand) {
    try {
      const result = await runManagedRepoCommand(config.managedRepos, repoCommand);
      await sendBridgeCommandResult(
        client,
        message.chatId,
        message.senderName,
        result.text,
        replyMessageId,
        replyTargetMessageId,
      );
      const now = new Date().toISOString();
      memory.appendTurn(message.chatId, {
        role: 'user',
        text: message.text,
        timestamp: now,
        senderId: message.senderId,
        senderName: message.senderName,
      });
      memory.appendTurn(message.chatId, {
        role: 'assistant',
        text: result.text,
        timestamp: now,
      });
      log.feishu(`Repo Git 命令完成 repo=${repoCommand.repoKey} message=${message.messageId}`);
    } catch (error) {
      const errorText = `Repo Git 命令失败：${error instanceof Error ? error.message : String(error)}`;
      log.warn(errorText);
      await sendBridgeCommandResult(
        client,
        message.chatId,
        message.senderName,
        errorText,
        replyMessageId,
        replyTargetMessageId,
      );
    }
    return;
  }

  if (parseCompiledPaperPdfDeliveryCommand(message.text)) {
    let resultText = '';
    try {
      const attachment = resolveCompiledPaperPdfAttachment(config.paperWorkspace);
      if (!attachment) {
        resultText = config.paperWorkspace.dir
          ? '编译后的论文 PDF 路径未配置为 PDF 文件。请检查 BRIDGE_PAPER_COMPILED_PDF_PATH。'
          : '论文工作区未配置。请设置 BRIDGE_PAPER_WORKSPACE_DIR。';
      } else {
        resultText = await deliverPdfAttachment(client, message.chatId, attachment, replyTargetMessageId);
      }
      await sendBridgeCommandResult(
        client,
        message.chatId,
        message.senderName,
        resultText,
        replyMessageId,
        replyTargetMessageId,
      );
      const now = new Date().toISOString();
      memory.appendTurn(message.chatId, {
        role: 'user',
        text: message.text,
        timestamp: now,
        senderId: message.senderId,
        senderName: message.senderName,
      });
      memory.appendTurn(message.chatId, {
        role: 'assistant',
        text: resultText,
        timestamp: now,
      });
      log.feishu(`编译后论文 PDF 发送命令完成 message=${message.messageId}`);
    } catch (error) {
      const errorText = `编译后论文 PDF 发送失败：${error instanceof Error ? error.message : String(error)}`;
      log.warn(errorText);
      await sendBridgeCommandResult(
        client,
        message.chatId,
        message.senderName,
        errorText,
        replyMessageId,
        replyTargetMessageId,
      );
    }
    return;
  }

  const history = memory.getTurns(message.chatId);
  const promptHistory = config.memory.includeAgentMessagesInHistory
    ? history
    : history.filter((turn) => turn.role !== 'assistant');
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
      includeAgentMessagesInHistory: config.memory.includeAgentMessagesInHistory,
    });

  for (const debugLine of buildMemoryDebugLines({
    message,
    sessionDir: piClientOptions.sessionDir,
    history,
    promptHistory,
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
  let repoSnapshots: ManagedRepoSnapshot[] = [];
  try {
    repoSnapshots = await captureManagedRepoSnapshots(config.managedRepos);
    for (const snapshot of repoSnapshots) {
      if (snapshot.enabled && snapshot.status?.trim()) {
        log.warn(`${snapshot.label ?? snapshot.repoKey ?? 'Repo'} Git 自动提交将跳过：agent 回合开始前工作区已有未提交改动。`);
      }
    }
  } catch (error) {
    log.warn(`Repo Git 自动提交快照失败，将跳过自动提交: ${error instanceof Error ? error.message : String(error)}`);
  }
  const downloadedPdfAttachments = new Map<string, DownloadedPdfAttachment>();
  const queuedPdfDeliveryJobs = new Map<string, QueuedPdfDeliveryJob>();
  const visibleToolStatuses: AgentToolStatus[] = [];
  const collectDownloadedPdfAttachment = (event: PiEvent): void => {
    if (!config.feishu.sendDownloadedPdf) {
      return;
    }

    const attachment = extractDownloadedPdfAttachment(event, process.cwd());
    if (attachment) {
      downloadedPdfAttachments.set(attachment.path, attachment);
    }
    const queuedJob = extractQueuedPdfDeliveryJob(event);
    if (queuedJob) {
      queuedPdfDeliveryJobs.set(queuedJob.jobId, queuedJob);
    }
  };
  const updateAgentToolProgressCard = (event: PiEvent): void => {
    const status = formatAgentToolStatus(event);
    if (!status) {
      return;
    }

    visibleToolStatuses.push(status);
    updater.push(buildAgentToolProgressText(visibleToolStatuses));
  };
  pi.on('event', collectDownloadedPdfAttachment);
  pi.on('event', updateAgentToolProgressCard);

  try {
    const agentStartedAt = Date.now();
    log.pi(
      `prompt:start chat=${message.chatId} stored_history_turns=${history.length} prompt_history_turns=${promptHistory.length}`,
    );
    const agentResult = await (async () => {
      try {
        return await runAgentWithWebSearch({
          initialWebContext: webContext,
          maxSearchSteps: config.web.enabled ? maxAgentWebSearchSteps : 0,
          buildPrompt: buildPromptForWebContext,
          promptAgent: async (prompt: string) => pi.prompt(prompt),
          search: async (query: string) => runSearchAndFormat(query, 'agent'),
          onSearchRequest: async (query: string) => {
            log.info(`Agent主动请求追加联网搜索: ${buildSearchQuery(query)}`);
          },
        });
      } finally {
        pi.off('event', collectDownloadedPdfAttachment);
        pi.off('event', updateAgentToolProgressCard);
      }
    })();
    const finalResponse = agentResult.finalResponse;
    log.pi(
      `prompt:end chat=${message.chatId} duration_ms=${Date.now() - agentStartedAt} response_chars=${finalResponse.length} search_queries=${agentResult.searchQueries.length}`,
    );
    webContext = agentResult.webContext;
    const finalAsText = isTextFinalMode();
    await updater.complete(finalResponse);
    const finalTextChunks = splitLongTextForFeishu(finalResponse, config.feishu.maxReplyChars);
    const finalReplyIsChunked = finalTextChunks.length > 1;

    const finalCardContent = buildStreamingCardContent({
      senderName: message.senderName,
      answer: finalResponse,
      isFinal: true,
    });

    if (!replyMessageId) {
      if (finalAsText || finalReplyIsChunked) {
        await sendTextMessageChunks(client, message.chatId, finalTextChunks, replyTargetMessageId);
      } else {
        await sendCardMessage(client, message.chatId, finalCardContent, replyTargetMessageId);
      }
    } else {
      if (isTextStreamMode()) {
        if (finalReplyIsChunked) {
          try {
            await patchTextMessage(client, replyMessageId, finalTextChunks[0]);
          } catch (error) {
            log.warn(`最终消息更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
            await sendTextMessage(client, message.chatId, finalTextChunks[0], replyTargetMessageId);
          }
          await sendTextMessageChunks(client, message.chatId, finalTextChunks.slice(1), replyTargetMessageId);
        } else {
          try {
            await patchTextMessage(client, replyMessageId, finalResponse);
          } catch (error) {
            log.warn(`最终消息更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
            await sendTextMessage(client, message.chatId, finalResponse, replyTargetMessageId);
          }
        }
      } else if (isCardToTextMode()) {
        await sendTextMessageChunks(client, message.chatId, finalTextChunks, replyTargetMessageId);
      } else if (finalReplyIsChunked) {
        try {
          await patchStreamingMessage(
            client,
            replyMessageId,
            message.senderName,
            buildLongReplyNotice(finalTextChunks.length),
            true,
          );
        } catch (error) {
          log.warn(`最终消息更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
          await sendCardMessage(
            client,
            message.chatId,
            buildStreamingCardContent({
              senderName: message.senderName,
              answer: buildLongReplyNotice(finalTextChunks.length),
              isFinal: true,
            }),
            replyTargetMessageId,
          );
        }
        await sendTextMessageChunks(client, message.chatId, finalTextChunks, replyTargetMessageId);
      } else {
        try {
          await patchStreamingMessage(client, replyMessageId, message.senderName, finalResponse, true);
        } catch (error) {
          log.warn(`最终消息更新失败，改为发送新消息: ${error instanceof Error ? error.message : String(error)}`);
          if (finalAsText) {
            await patchTextMessage(client, replyMessageId, finalResponse);
          } else {
            await sendCardMessage(client, message.chatId, finalCardContent, replyTargetMessageId);
          }
        }
      }
    }

    for (const attachment of await resolveDownloadedPdfAttachmentsForQueuedJobs(
      process.cwd(),
      Array.from(queuedPdfDeliveryJobs.values()),
    )) {
      downloadedPdfAttachments.set(attachment.path, attachment);
    }
    for (const attachment of extractPdfAttachmentsFromText(finalResponse, process.cwd())) {
      downloadedPdfAttachments.set(attachment.path, attachment);
    }
    if (queuedPdfDeliveryJobs.size > 0 && downloadedPdfAttachments.size === 0) {
      log.warn(`PDF 文件发送跳过：${queuedPdfDeliveryJobs.size} 个扩展下载任务尚未完成。`);
    }

    await sendDownloadedPdfAttachments(
      client,
      message.chatId,
      Array.from(downloadedPdfAttachments.values()),
      replyTargetMessageId,
    );

    try {
      const autoGitResults = await autoCommitManagedRepos(config.managedRepos, repoSnapshots, message.text);
      for (const autoGitResult of autoGitResults) {
        if (!autoGitResult.text) {
          continue;
        }
        await sendBridgeCommandResult(
          client,
          message.chatId,
          message.senderName,
          autoGitResult.text,
          undefined,
          replyTargetMessageId,
        );
        log.feishu(
          `Repo Git 自动处理完成 repo=${autoGitResult.repoKey ?? 'unknown'} commit=${autoGitResult.didCommit ? 'yes' : 'no'} push=${autoGitResult.didPush ? 'yes' : 'no'}`,
        );
      }
    } catch (error) {
      const errorText = `Repo Git 自动提交失败：${error instanceof Error ? error.message : String(error)}`;
      log.warn(errorText);
      await sendBridgeCommandResult(
        client,
        message.chatId,
        message.senderName,
        errorText,
        undefined,
        replyTargetMessageId,
      );
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
