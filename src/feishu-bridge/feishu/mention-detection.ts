export interface BotMentionConfig {
  botOpenId?: string;
  botAliases: string[];
}

function normalize(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function detectBotMention(event: any, text: string, config: BotMentionConfig): boolean {
  const mentions = event?.message?.mentions ?? event?.mentions ?? [];
  const normalizedAliases = config.botAliases.map(normalize).filter(Boolean);

  if (Array.isArray(mentions) && mentions.length > 0) {
    for (const mention of mentions) {
      if (mention?.mentioned_type === 'bot') {
        return true;
      }

      const mentionOpenId = mention?.id?.open_id ?? mention?.id ?? mention?.open_id;
      if (config.botOpenId && mentionOpenId === config.botOpenId) {
        return true;
      }

      const mentionName = normalize(mention?.name ?? mention?.key);
      if (!config.botOpenId && mentionName && normalizedAliases.includes(mentionName)) {
        return true;
      }
    }

    return false;
  }

  const normalizedText = normalize(text);
  return normalizedAliases.some((alias) => normalizedText.startsWith(`@${alias}`) || normalizedText.startsWith(alias));
}
