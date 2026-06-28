import { BOT_COMMANDS, type BotCommand } from './commands';

interface SendMessageOptions {
  replyToMessageId?: number;
  threadId?: bigint | number;
  parseMode?: 'HTML' | 'MarkdownV2' | string;
}

/**
 * Sends a POST request to the Telegram Bot API.
 */
async function callTelegramApi(
  token: string,
  method: string,
  body: Record<string, any>
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Telegram API call ${method} failed (${res.status}): ${errorText}`);
  }

  return await res.json();
}

/**
 * Reacts to a message with a specific emoji (e.g., 👀).
 */
export async function setMessageReaction(
  token: string,
  chatId: bigint | number,
  messageId: number,
  emoji: string
): Promise<void> {
  await callTelegramApi(token, 'setMessageReaction', {
    chat_id: chatId.toString(),
    message_id: messageId,
    reaction: [
      {
        type: 'emoji',
        emoji: emoji,
      },
    ],
    is_big: false,
  });
}

/**
 * Sends a chat action (e.g., 'typing') to a specific chat and thread.
 */
export async function sendChatAction(
  token: string,
  chatId: bigint | number,
  action: 'typing' | 'upload_photo' | string,
  threadId?: bigint | number
): Promise<void> {
  const body: Record<string, any> = {
    chat_id: chatId.toString(),
    action: action,
  };

  if (threadId !== undefined && threadId !== null) {
    body.message_thread_id = Number(threadId);
  }

  await callTelegramApi(token, 'sendChatAction', body);
}

/**
 * Sends a text message to a chat/thread.
 */
export async function sendMessage(
  token: string,
  chatId: bigint | number,
  text: string,
  options: SendMessageOptions = {}
): Promise<any> {
  const body: Record<string, any> = {
    chat_id: chatId.toString(),
    text: text,
  };

  if (options.threadId !== undefined && options.threadId !== null) {
    body.message_thread_id = Number(options.threadId);
  }

  if (options.replyToMessageId !== undefined) {
    body.reply_to_message_id = options.replyToMessageId;
  }

  if (options.parseMode) {
    body.parse_mode = options.parseMode;
  }

  return await callTelegramApi(token, 'sendMessage', body);
}

/**
 * Sanitizes raw string text for Telegram HTML parsing.
 * Preserves whitelisted tags (b, strong, i, em, u, ins, s, strike, del, span, code, pre, a)
 * and escapes all other HTML characters/tags.
 */
export function sanitizeForTelegramHtml(raw: string): string {
  if (!raw) return '';

  // 1. Escape bare ampersands that are not already valid HTML entities
  let sanitized = raw.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');

  // 2. Tokenize by splitting on tags
  const tagRegex = /(<\/?[a-zA-Z0-9]+(?:\s+href="[^"]*")?\s*>)/g;
  const parts = sanitized.split(tagRegex);

  // Whitelist pattern for valid Telegram HTML tags
  const whitelist = /^<\/?(b|strong|i|em|u|ins|s|strike|del|span|code|pre|a(?:\s+href="[^"]*")?)\s*>$/i;

  for (let i = 0; i < parts.length; i++) {
    // Odd indices represent parsed tags
    if (i % 2 === 1) {
      const tag = parts[i];
      if (!whitelist.test(tag)) {
        // Not a whitelisted tag, escape the brackets so it displays as plain text
        parts[i] = tag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
    } else {
      // Even indices represent raw text, escape raw angle brackets
      parts[i] = parts[i].replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  }

  return parts.join('');
}

/**
 * Uploads a text document (e.g. markdown) to a chat/thread as a file attachment.
 * Uses multipart/form-data (required by Telegram for file uploads), so it does
 * NOT go through callTelegramApi (which is JSON-only).
 */
export async function sendDocument(
  token: string,
  chatId: bigint | number,
  filename: string,
  content: string,
  options: {
    caption?: string;
    threadId?: bigint | number | null;
    parseMode?: 'HTML' | 'MarkdownV2' | string;
  } = {}
): Promise<any> {
  const url = `https://api.telegram.org/bot${token}/sendDocument`;

  const form = new FormData();
  form.append('chat_id', chatId.toString());

  // The file part. Use a Blob with a text/markdown mime type.
  const blob = new Blob([content], { type: 'text/markdown' });
  form.append('document', blob, filename);

  if (options.caption) {
    form.append('caption', options.caption);
    if (options.parseMode) form.append('parse_mode', options.parseMode);
  }
  if (options.threadId !== undefined && options.threadId !== null) {
    form.append('message_thread_id', Number(options.threadId).toString());
  }

  // NOTE: do NOT set Content-Type manually — fetch sets the multipart boundary.
  const res = await fetch(url, { method: 'POST', body: form });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Telegram API call sendDocument failed (${res.status}): ${errorText}`);
  }

  return await res.json();
}

/**
 * Registers the bot's command menu (setMyCommands). Pass a command list;
 * defaults to the shared BOT_COMMANDS. setMyCommands is a full replace
 * (not a merge), so this is idempotent and safe to re-run.
 */
export async function setMyCommands(
  token: string,
  commands: BotCommand[] = BOT_COMMANDS
): Promise<any> {
  return await callTelegramApi(token, 'setMyCommands', { commands });
}

/**
 * Gets a chat member's status (used to check if a Telegram user is a group admin/creator).
 */
export async function getChatMember(
  token: string,
  chatId: bigint | number,
  userId: bigint | number
): Promise<any> {
  return await callTelegramApi(token, 'getChatMember', {
    chat_id: chatId.toString(),
    user_id: Number(userId),
  });
}
