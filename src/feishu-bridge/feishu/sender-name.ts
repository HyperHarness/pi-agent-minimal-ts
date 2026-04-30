export interface SenderNameLookupSource {
  sender?: {
    sender_name?: string;
    name?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
    };
    id?: {
      open_id?: string;
      user_id?: string;
    };
  };
}

export async function resolveSenderName(
  data: SenderNameLookupSource,
  lookupByOpenId: (openId: string) => Promise<string | undefined>,
): Promise<string> {
  const directName = data.sender?.sender_name?.trim() || data.sender?.name?.trim();
  if (directName) {
    return directName;
  }

  const openId = data.sender?.sender_id?.open_id || data.sender?.id?.open_id;
  if (openId) {
    const lookedUp = await lookupByOpenId(openId);
    if (lookedUp?.trim()) {
      return lookedUp.trim();
    }
    return openId;
  }

  return data.sender?.sender_id?.user_id || data.sender?.id?.user_id || 'unknown';
}
