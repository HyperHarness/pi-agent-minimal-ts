interface StreamingCardOptions {
  senderName: string;
  answer: string;
  isFinal: boolean;
}

interface StatusCardOptions {
  senderName: string;
  status: string;
  detail: string;
  statusColor: 'blue' | 'green' | 'red';
}

function truncate(text: string, max = 6000): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

function buildCard(status: string, statusColor: 'blue' | 'green' | 'red', body: string, _senderName?: string, detail?: string): string {
  const lines = [body].filter(Boolean) as string[];

  return JSON.stringify({
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: detail || status,
      },
      template: statusColor,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: truncate(lines.join('\n\n')),
        },
      },
    ],
  });
}

export function buildThinkingCardContent(senderName: string, placeholderText: string): string {
  return buildCard('思考中', 'blue', placeholderText, senderName, '正在理解问题并整理上下文');
}

export function buildStatusCardContent(options: StatusCardOptions): string {
  return buildCard(options.status, options.statusColor, options.detail, options.senderName, options.detail);
}

export function buildStreamingCardContent(options: StreamingCardOptions): string {
  return buildCard(
    options.isFinal ? '已完成' : '输出中',
    options.isFinal ? 'green' : 'blue',
    options.answer,
    options.senderName,
    options.isFinal ? '回答生成完成' : '正在生成回答内容',
  );
}

export function buildErrorCardContent(message: string): string {
  return buildCard('出错', 'red', message, undefined, '处理请求时发生异常');
}
