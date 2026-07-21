import { marked } from 'marked';
import { getPrivacyPolicyUrl } from '@/lib/config';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Determines whether the bot's membership status change in a chat warrants a first-add announcement.
 * Announcement fires only when transitioning from outside ('left'|'kicked') to inside ('member'|'administrator')
 * in a group or supergroup chat.
 */
export function shouldAnnounceFirstAdd(mcm: any): boolean {
  if (!mcm || !mcm.chat) return false;

  const chatType = mcm.chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
  const oldStatus = mcm.old_chat_member?.status;
  const newStatus = mcm.new_chat_member?.status;

  const wasOutside = oldStatus === 'left' || oldStatus === 'kicked';
  const isInside = newStatus === 'member' || newStatus === 'administrator';
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  return isGroup && wasOutside && isInside;
}

/**
 * Filters out bot accounts from new_chat_members and formats inline tg://user?id HTML user mentions.
 */
export function buildJoinerMentions(users: any[]): { joiners: any[]; mentionsHtml: string } {
  if (!Array.isArray(users)) {
    return { joiners: [], mentionsHtml: '' };
  }

  const joiners = users.filter((u: any) => u && !u.is_bot);
  const mentionsHtml = joiners
    .map((u: any) => `<a href="tg://user?id=${u.id}">${escapeHtml(u.first_name || 'there')}</a>`)
    .join(', ');

  return { joiners, mentionsHtml };
}

/**
 * Generates the first-add announcement copy with dynamic Privacy Policy link.
 */
export function getAnnounceFirstAdd(): string {
  const privacyUrl = getPrivacyPolicyUrl();
  return (
    `👋 Hi everyone — I'm Leguan, an AI assistant that was just added to this group.\n\n` +
    `Once set up, I can answer questions from your team's saved documents (mention me), ` +
    `summarize recent discussion (<code>/recap</code>), and save messages as lasting context (<code>/push</code>).\n\n` +
    `To do that, I log group messages and may send them to AI model providers to generate answers. ` +
    `Here's how your data is handled: <a href="${privacyUrl}">Privacy Policy</a>.`
  );
}

/**
 * Generates the on-join notice copy for welcomed members with dynamic Privacy Policy link.
 */
export function NOTICE_ON_JOIN(mentionsHtml: string): string {
  const privacyUrl = getPrivacyPolicyUrl();
  return (
    `👋 Welcome, ${mentionsHtml}! This group uses <b>Leguan</b>, an AI assistant that logs messages ` +
    `to power Q&A and recaps and may send them to AI providers to generate answers. ` +
    `How your data is handled: <a href="${privacyUrl}">Privacy Policy</a>.`
  );
}

/**
 * Strips top HTML comments (e.g., draft/review headers) non-greedily and converts markdown to HTML.
 */
export async function renderPolicyHtml(markdownText: string): Promise<string> {
  const cleanMd = markdownText.replace(/^\s*<!--[\s\S]*?-->/, '').trim();
  const parsed = await marked.parse(cleanMd);
  return typeof parsed === 'string' ? parsed : String(parsed);
}
