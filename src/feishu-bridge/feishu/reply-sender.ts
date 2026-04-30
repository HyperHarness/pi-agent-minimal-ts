import { randomUUID } from 'node:crypto';

export interface ReplyPayload {
  path: {
    message_id: string;
  };
  data: {
    msg_type: string;
    content: string;
    reply_in_thread?: boolean;
    uuid: string;
  };
}

export interface ReplyResponse {
  data?: {
    message_id?: string;
  };
}

export interface FeishuApiErrorInfo {
  statusCode?: number;
  code?: number;
  msg?: string;
  rawMessage: string;
  summary: string;
}

export interface SendReplyWithRetryOptions {
  messageId: string;
  msgType: string;
  content: string;
  replyInThread?: boolean;
  reply: (payload: ReplyPayload) => Promise<ReplyResponse>;
  retryDelayMs?: number;
}

export interface SendReplyWithRetryResult {
  messageId?: string;
  fallbackToCreate: boolean;
  detail?: string;
}

const RETRYABLE_REPLY_ERROR_CODES = new Set([230020, 230049]);

export function parseFeishuApiError(error: unknown): FeishuApiErrorInfo {
  const maybeError = error as {
    message?: string;
    response?: {
      status?: number;
      data?: {
        code?: number;
        msg?: string;
      };
    };
  };

  const statusCode = maybeError?.response?.status;
  const code = maybeError?.response?.data?.code;
  const msg = maybeError?.response?.data?.msg;
  const rawMessage = maybeError?.message ?? String(error);
  const parts = [rawMessage];

  if (statusCode != null) {
    parts.push(`HTTP ${statusCode}`);
  }
  if (code != null) {
    parts.push(`code=${code}`);
  }
  if (msg) {
    parts.push(`msg=${msg}`);
  }

  return {
    statusCode,
    code,
    msg,
    rawMessage,
    summary: parts.join(', '),
  };
}

function shouldRetrySameReply(info: FeishuApiErrorInfo): boolean {
  return info.statusCode === 400 && info.code != null && RETRYABLE_REPLY_ERROR_CODES.has(info.code);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendReplyWithRetry(options: SendReplyWithRetryOptions): Promise<SendReplyWithRetryResult> {
  const uuid = randomUUID();
  const retryDelayMs = options.retryDelayMs ?? 300;
  let lastInfo: FeishuApiErrorInfo | undefined;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await options.reply({
        path: {
          message_id: options.messageId,
        },
        data: {
          msg_type: options.msgType,
          content: options.content,
          uuid,
          ...(options.replyInThread ? { reply_in_thread: true } : {}),
        },
      });

      return {
        messageId: response.data?.message_id,
        fallbackToCreate: false,
      };
    } catch (error) {
      const info = parseFeishuApiError(error);
      lastInfo = info;
      if (attempt === 1 && shouldRetrySameReply(info)) {
        await sleep(retryDelayMs);
        continue;
      }

      return {
        messageId: undefined,
        fallbackToCreate: !shouldRetrySameReply(info),
        detail: info.summary,
      };
    }
  }

  return {
    messageId: undefined,
    fallbackToCreate: false,
    detail: lastInfo?.summary,
  };
}
