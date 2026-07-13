import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { sql, withTenantContext, withBotContext } from '@/lib/supabase';
import {
  resolveUser,
  answerQuestion,
  logMessage,
  getContextManifest,
  logBotResponse,
  recapConversation,
  consumeLinkToken,
  resolveBotIdBySlug,
  resolveEntityIdByChat,
  updateLoggedMessage,
  registerThread,
  answerAboutDocument,
  pushContext,
} from '@/lib/capabilities';
import { htmlToFormattable } from '@gramio/format/html';
import {
  setMessageReaction,
  sendChatAction,
  sendMessage,
  sendDocument,
  sanitizeForTelegramHtml,
  getChatMember,
  sendFormattedMessage,
  downloadTelegramFile,
  TELEGRAM_MAX_DOWNLOAD_BYTES,
  editMessageText,
  deleteMessage,
  startTypingKeepalive,
  splitFormattedMessage,
  type TelegramMessageEntity,
  runWithStatus,
} from '@/lib/telegram';
import { getModelIdentifier, ANTHROPIC_DOCUMENT_MODEL } from '@/lib/config';
import { DocumentReadError } from '@/lib/model';

const DEFAULT_RECAP = 20;
const MAX_RECAP = 100;

// Status copy (David-adjustable)
const STATUS_QUESTION = '✍️ Pulling together the context and writing your response…';
const STATUS_RECAP = '✍️ Reading back through the recent messages and putting your recap together…';
const STATUS_DOC_DOWNLOAD = '📄 Downloading your document — one moment…';
const STATUS_DOC_READING = '✍️ Got it — reading through the document and writing your response…';

interface RouteParams {
  params: Promise<{
    botSlug: string;
  }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { botSlug } = await params;

    // 1. Resolve bot ID from slug
    const botId = await resolveBotIdBySlug(botSlug);
    if (!botId) {
      console.warn(`Webhook triggered for unknown bot slug: ${botSlug}`);
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }

    // 2. Fetch bot info using get_bot_config SECURITY DEFINER resolver
    const bot = await withBotContext(botId, async (tx) => {
      const rows = await tx<any[]>`
        select * from public.get_bot_config(${botId})
      `;
      return rows[0];
    });

    if (!bot) {
      return NextResponse.json({ error: 'Bot config mismatch' }, { status: 404 });
    }

    if (bot.status === 'retired') {
      console.warn(`Webhook triggered for retired bot: ${botSlug}`);
      return NextResponse.json({ error: 'Bot retired' }, { status: 404 });
    }

    // 3. Webhook-secret gate (runs before entity resolution) (S1)
    const incomingSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (incomingSecret !== bot.telegram_webhook_secret) {
      console.warn(`Unauthorized webhook attempt on bot: ${botSlug}`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const update = await req.json();

    // 3b. Archive raw Telegram event (best-effort, non-blocking-on-failure)
    try {
      const updateId = update && (typeof update.update_id === 'number' || typeof update.update_id === 'string')
        ? update.update_id.toString()
        : null;

      let updateType = 'unknown';
      if (update && typeof update === 'object') {
        const keys = Object.keys(update);
        const typeKey = keys.find((k) => k !== 'update_id');
        if (typeKey) {
          updateType = typeKey;
        }
      }

      await sql`
        insert into public.telegram_events (bot_slug, update_id, update_type, payload)
        values (${botSlug}, ${updateId}, ${updateType}, ${sql.json(update)})
      `;
    } catch (err) {
      console.error('Failed to archive raw Telegram event:', err);
    }

    const message = update.message;
    const editedMessage = update.edited_message;

    // Handle edited messages (Item 2.1)
    if (editedMessage && editedMessage.chat && editedMessage.text) {
      const entityId = await resolveEntityIdByChat(editedMessage.chat.id);
      if (entityId) {
        const entityInfo = await withTenantContext(entityId, async (tx) => {
          const rows = await tx<any[]>`
            select excluded_thread_ids from public.entities where id = ${entityId}
          `;
          return rows[0];
        });
        const threadId = editedMessage.message_thread_id !== undefined ? editedMessage.message_thread_id : null;
        const isExcluded = threadId !== null &&
          entityInfo?.excluded_thread_ids &&
          entityInfo.excluded_thread_ids.some(
            (id: any) => id.toString() === threadId.toString()
          );

        if (!isExcluded) {
          const groupRow = await withTenantContext(entityId, async (tx) => {
            const rows = await tx<any[]>`
              select id from public.groups where telegram_chat_id = ${editedMessage.chat.id.toString()}
            `;
            return rows[0];
          });
          if (groupRow) {
            await updateLoggedMessage({
              entityId,
              groupId: groupRow.id,
              telegramChatId: editedMessage.chat.id,
              telegramMessageId: editedMessage.message_id,
              newText: editedMessage.text.trim(),
            });
          }
        }
      }
      return NextResponse.json({ ok: true, msg: 'Edit synced' });
    }

    // Handle service messages (forum topic created, edited, chat renamed)
    if (message && message.chat) {
      const isTopicCreated = !!message.forum_topic_created;
      const isTopicEdited = !!message.forum_topic_edited;
      const isGroupRenamed = message.new_chat_title !== undefined && message.new_chat_title !== null;

      if (isTopicCreated || isTopicEdited || isGroupRenamed) {
        const entityId = await resolveEntityIdByChat(message.chat.id);
        if (entityId) {
          await withTenantContext(entityId, async (tx) => {
            const groupRows = await tx<any[]>`
              select id from public.groups where telegram_chat_id = ${message.chat.id.toString()}
            `;
            const groupRow = groupRows[0];
            if (groupRow) {
              const groupId = groupRow.id;

              if (isTopicCreated) {
                const created = message.forum_topic_created;
                const threadId = message.message_thread_id !== undefined ? message.message_thread_id : null;
                if (threadId !== null && threadId !== undefined) {
                  await registerThread(tx, {
                    entityId,
                    groupId,
                    telegramThreadId: threadId,
                    name: created.name,
                    iconColor: created.icon_color,
                    iconCustomEmojiId: created.icon_custom_emoji_id,
                  });
                }
              } else if (isTopicEdited) {
                const edited = message.forum_topic_edited;
                const threadId = message.message_thread_id !== undefined ? message.message_thread_id : null;
                if (threadId !== null && threadId !== undefined) {
                  await registerThread(tx, {
                    entityId,
                    groupId,
                    telegramThreadId: threadId,
                    name: edited.name,
                    iconColor: null,
                    iconCustomEmojiId: edited.icon_custom_emoji_id,
                  });
                }
              } else if (isGroupRenamed) {
                await tx`
                  update public.groups
                  set display_name = ${message.new_chat_title}
                  where id = ${groupId}::uuid
                `;
              }
            }
          });
        }
        return NextResponse.json({ ok: true, msg: 'Service message handled' });
      }
    }

    if (!message || !message.chat) {
      return NextResponse.json({ ok: true });
    }

    const botUsername = bot.telegram_username;
    const rawText = message.text?.trim() ?? null;
    const rawCaption = message.caption?.trim() ?? null;
    const captionMentionsBot = !!(message.document && rawCaption && botUsername && rawCaption.includes('@' + botUsername));

    if (!rawText && !captionMentionsBot) {
      return NextResponse.json({ ok: true });
    }

    const effectiveText = rawText ?? rawCaption ?? '';
    const text = effectiveText;
    const threadId = message.message_thread_id !== undefined ? message.message_thread_id : null;

    // Determine intents
    const isHelpCommand = rawText ? rawText.startsWith('/help') : false;
    const isContextCommand = rawText ? rawText.startsWith('/context') : false;
    const isWhoamiCommand = rawText ? rawText.startsWith('/whoami') : false;
    const isAuthCommand = rawText ? rawText.startsWith('/auth') : false;
    const isRecapCommand = rawText ? rawText.startsWith('/recap') : false;
    const isPushCommand = rawText ? rawText.startsWith('/push') : false;
    const isMention = botUsername ? effectiveText.includes(`@${botUsername}`) : false;

    let isCommand = false;
    let isBotMention = false;
    let question = '';

    if (isHelpCommand) {
      isCommand = true;
    } else if (isContextCommand) {
      isCommand = true;
    } else if (isWhoamiCommand) {
      isCommand = true;
    } else if (isAuthCommand) {
      isCommand = true;
    } else if (isRecapCommand) {
      isCommand = true;
    } else if (isPushCommand) {
      isCommand = true;
    } else if (isMention) {
      isBotMention = true;
      question = effectiveText.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '').trim();
    }

    // 4. Resolve entity ID from the group chat ID (S2)
    // Note: The bot_entities table maps authorized entities to a bot (a deliberate future-authorization seam
    // for bot-store subscription gating). In Phase 3, we resolve the tenant context purely via chat_id -> groups -> entity_id.
    const entityId = await resolveEntityIdByChat(message.chat.id);

    // 4b. Early Deduplication for bound chats (Idempotency)
    const updateId = update.update_id;
    if (updateId && entityId) {
      try {
        await withTenantContext(entityId, async (tx) => {
          await tx`
            insert into processed_updates (update_id, entity_id)
            values (${updateId}, ${entityId})
          `;
        });
      } catch (err) {
        // Unique constraint violation means we already processed this update
        console.info(`Duplicate update ignored (Idempotency): ${updateId}`);
        return NextResponse.json({ ok: true, msg: 'Duplicate ignored' });
      }
    }

    // 5. Unbound Commands: /whoami & /auth (S3)
    if (isWhoamiCommand) {
      const chatId = message.chat.id;
      const fromId = message.from?.id ?? null;
      const fromUsername = message.from?.username ?? null;

      let entityLabel = 'unregistered';
      let groupLabel = 'unregistered';
      let whoamiExcluded = false;

      if (entityId) {
        // Resolve entity info to report details in whoami
        const entityInfo = await withTenantContext(entityId, async (tx) => {
          const rows = await tx<any[]>`
            select slug, excluded_thread_ids from public.entities where id = ${entityId}
          `;
          return rows[0];
        });
        if (entityInfo) {
          entityLabel = entityInfo.slug || 'unregistered';
          whoamiExcluded =
            threadId !== null &&
            entityInfo.excluded_thread_ids &&
            entityInfo.excluded_thread_ids.some(
              (id: any) => id.toString() === threadId.toString()
            );

          // Find group display name
          const groupRow = await withTenantContext(entityId, async (tx) => {
            const rows = await tx<any[]>`
              select display_name from public.groups where telegram_chat_id = ${chatId.toString()}
            `;
            return rows[0];
          });
          if (groupRow) {
            groupLabel = groupRow.display_name || 'unregistered';
          }
        }
      }

      const lines = [
        '<b>🪪 whoami</b>',
        '',
        `<b>Chat ID:</b> <code>${chatId}</code>`,
        `<b>Topic (thread) ID:</b> ${threadId === null ? '<i>General (none)</i>' : `<code>${threadId}</code>`}`,
        `<b>Your user ID:</b> ${fromId === null ? '<i>unknown</i>' : `<code>${fromId}</code>`}`,
        `<b>Your username:</b> ${fromUsername ? `@${escapeHtml(fromUsername)}` : '<i>none set</i>'}`,
        '',
        `<b>Entity:</b> ${escapeHtml(entityLabel)}`,
        `<b>Group:</b> ${escapeHtml(groupLabel)}`,
        `<b>Topic status:</b> ${whoamiExcluded ? '⛔️ <i>excluded (bot does not operate here)</i>' : '✅ <i>active</i>'}`,
      ];

      if (entityId && groupLabel !== 'unregistered' && !whoamiExcluded) {
        try {
          // Log whoami only if bound and active
          const resolvedGroup = await withTenantContext(entityId, async (tx) => {
            const rows = await tx<any[]>`
              select id from public.groups where telegram_chat_id = ${chatId.toString()} limit 1
            `;
            return rows[0];
          });
          if (resolvedGroup) {
            await logMessage({
              entityId,
              groupId: resolvedGroup.id,
              telegramChatId: chatId,
              telegramThreadId: threadId,
              telegramUserId: fromId,
              username: fromUsername || message.from?.first_name || 'User',
              messageText: text,
              isCommand: true,
              isBotMention: false,
              telegramMessageId: message.message_id,
            });
          }
        } catch (err) {
          console.error('Failed to log whoami:', err);
        }
      }

      await sendMessage(
        bot.telegram_bot_token,
        chatId,
        lines.join('\n'),
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );

      return NextResponse.json({ ok: true, msg: 'whoami sent' });
    }

    if (isAuthCommand) {
      try {
        await setMessageReaction(bot.telegram_bot_token, message.chat.id, message.message_id, '👀');
      } catch (err) {
        console.error('Failed to set eyes reaction:', err);
      }

      const authArg = text.replace(/^\/auth(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();

      if (!authArg) {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
        let appHost = appUrl;
        try {
          appHost = new URL(appUrl).host;
        } catch { }

        const infoMsg = `To link this group, generate a one-time code in the dashboard, then send <code>/auth &lt;code&gt;</code> here. Get a code at ${escapeHtml(appHost)} — only a group admin can complete linking.`;
        await sendMessage(bot.telegram_bot_token, message.chat.id, infoMsg, {
          threadId,
          replyToMessageId: message.message_id,
          parseMode: 'HTML',
        });
        return NextResponse.json({ ok: true, msg: 'Auth info sent' });
      }

      // Group admin check
      try {
        const member = await getChatMember(bot.telegram_bot_token, message.chat.id, message.from.id);
        const isAdmin = member?.result?.status === 'administrator' || member?.result?.status === 'creator';
        if (!isAdmin) {
          await sendMessage(
            bot.telegram_bot_token,
            message.chat.id,
            `Only a group admin can link this group.`,
            { threadId, replyToMessageId: message.message_id }
          );
          return NextResponse.json({ ok: true, msg: 'Not admin' });
        }
      } catch (err) {
        console.error('Failed admin check:', err);
        await sendMessage(
          bot.telegram_bot_token,
          message.chat.id,
          `⚠️ <i>Failed to verify administrator status. Please try again.</i>`,
          { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
        );
        return NextResponse.json({ ok: true, msg: 'Admin check failed' });
      }

      // Forum check
      const isForum = !!message.chat.is_forum;
      if (!isForum) {
        await sendMessage(
          bot.telegram_bot_token,
          message.chat.id,
          `⚠️ <i>This bot requires a forum group with Topics enabled to operate. Please enable Topics in this group's settings.</i>`,
          { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
        );
        return NextResponse.json({ ok: true, msg: 'Not forum' });
      }

      // Consume the link token (null expected entity in Phase 3)
      try {
        const { displayName } = await consumeLinkToken({
          code: authArg,
          expectedEntityId: null,
          chatId: message.chat.id,
          tgUserId: message.from.id,
          chatTitle: message.chat.title || 'Telegram Group',
          isForum,
        });

        await sendMessage(
          bot.telegram_bot_token,
          message.chat.id,
          `✅ This group is now linked to <b>${escapeHtml(displayName)}</b>.`,
          { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
        );
      } catch (err: any) {
        console.error('Link token consumption failed:', err);
        const errMsg = err.message || '';
        let replyMsg = `⚠️ <i>Something went wrong while processing the linking request.</i>`;

        if (errMsg.includes('invalid_code') || errMsg.includes('expired')) {
          replyMsg = `That link code is invalid or expired. Generate a new one in the dashboard.`;
        } else if (errMsg.includes('already_consumed')) {
          replyMsg = `That code was already used. Generate a new one.`;
        } else if (errMsg.includes('chat_bound_elsewhere')) {
          replyMsg = `This group is already linked to another workspace. Unlink it first.`;
        } else if (errMsg.includes('not_forum')) {
          replyMsg = `⚠️ <i>This bot requires a forum group with Topics enabled to operate. Please enable Topics in this group's settings.</i>`;
        }

        await sendMessage(
          bot.telegram_bot_token,
          message.chat.id,
          replyMsg,
          { threadId, replyToMessageId: message.message_id }
        );
      }

      return NextResponse.json({ ok: true, msg: 'Auth command processed' });
    }

    // 6. Bail if group is not bound
    if (!entityId) {
      console.info(`Message received from untracked chat ID: ${message.chat.id}`);
      return NextResponse.json({ ok: true, msg: 'Untracked group' });
    }

    // 7. Load Entity & Group Context
    const entity = await withTenantContext(entityId, async (tx) => {
      const rows = await tx<any[]>`
        select id, slug, display_name, excluded_thread_ids
        from public.entities
        where id = ${entityId}
        limit 1
      `;
      return rows[0];
    });

    const group = await withTenantContext(entityId, async (tx) => {
      const rows = await tx<any[]>`
        select id, display_name
        from public.groups
        where telegram_chat_id = ${message.chat.id.toString()}
        limit 1
      `;
      return rows[0];
    });

    if (!entity || !group) {
      return NextResponse.json({ error: 'Tenant config mismatch' }, { status: 404 });
    }

    // 8. Excluded-thread check
    const isExcluded =
      threadId !== null &&
      entity.excluded_thread_ids &&
      entity.excluded_thread_ids.some(
        (id: any) => id.toString() === threadId.toString()
      );

    if (isExcluded) {
      if (isCommand || isBotMention) {
        try {
          await sendMessage(
            bot.telegram_bot_token,
            message.chat.id,
            `⛔️ <i>I'm not configured to operate in this topic.</i>`,
            { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
          );
        } catch (err) {
          console.error('Failed to send excluded thread notice:', err);
        }
      }
      return NextResponse.json({ ok: true, msg: 'Excluded thread' });
    }

    // 9. processed_updates idempotency (handled early in step 4b for bound chats)

    // 10. Log incoming message
    await logMessage({
      entityId: entity.id,
      groupId: group.id,
      telegramChatId: message.chat.id,
      telegramThreadId: threadId,
      telegramUserId: message.from?.id || null,
      username: message.from?.username || message.from?.first_name || 'User',
      messageText: text,
      isCommand,
      isBotMention,
      telegramMessageId: message.message_id,
    });

    // 11. Respond to /help
    if (isHelpCommand) {
      waitUntil(
        (async () => {
          const helpText = `<b>Telegram Bot Platform Help</b>\n\n` +
            `• Use <code>/context</code> to see what documentation I'm answering from in this topic.\n` +
            `• Use <code>/push topic</code> or <code>/push group</code> as a <i>reply</i> to a message to save that message as context for the topic or group (group admins only).\n` +
            `• Use <code>/recap [N]</code> to summarize the last N messages here (default 20).\n` +
            `• Use <code>/whoami</code> to show this chat's ids (useful for setup/diagnostics).\n` +
            `• Mention me <code>@${botUsername} &lt;question&gt;</code> inside a topic to ask a question.`;

          await sendMessage(bot.telegram_bot_token, message.chat.id, helpText, {
            threadId,
            replyToMessageId: message.message_id,
            parseMode: 'HTML',
          });
        })()
      );
      return NextResponse.json({ ok: true, msg: 'Help sent' });
    }

    // 12. Respond to /context
    if (isContextCommand) {
      waitUntil(
        (async () => {
          try {
            const { entityDocs, groupDocs, topicDocs } = await getContextManifest(entity.id, group.id, threadId);
            const totalDocs = entityDocs.length + groupDocs.length + topicDocs.length;

            const entityText = entityDocs.length > 0
              ? `✓ ${entityDocs.length} document${entityDocs.length === 1 ? '' : 's'}`
              : `<i>— none set</i>`;
            const groupText = groupDocs.length > 0
              ? `✓ ${groupDocs.length} document${groupDocs.length === 1 ? '' : 's'}`
              : `<i>— none set</i>`;
            const topicText = topicDocs.length > 0
              ? `✓ ${topicDocs.length} document${topicDocs.length === 1 ? '' : 's'}`
              : `<i>— none set</i>`;

            const summaryLines = [
              `<b>📚 Context for this topic</b>`,
              '',
              `<b>Entity:</b> ${entityText}`,
              `<b>Group:</b> ${groupText}`,
              `<b>Topic:</b> ${topicText}`,
              '',
            ];

            if (totalDocs > 0) {
              summaryLines.push(`📎 Full text attached below ↓`);
            } else {
              summaryLines.push(`<i>No context is configured for this topic yet.</i>`);
            }

            await sendMessage(
              bot.telegram_bot_token,
              message.chat.id,
              summaryLines.join('\n'),
              { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
            );

            if (totalDocs > 0) {
              const docMarkdown = buildContextDocument(entityDocs, groupDocs, topicDocs);
              await sendDocument(
                bot.telegram_bot_token,
                message.chat.id,
                'context.md',
                docMarkdown,
                { threadId, caption: 'Full context the bot answers from' }
              );
            }
          } catch (err) {
            console.error('Error handling /context:', err);
            try {
              await sendMessage(
                bot.telegram_bot_token,
                message.chat.id,
                `⚠️ <i>Sorry, couldn't retrieve the context right now.</i>`,
                { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
              );
            } catch (sendErr) {
              console.error('Failed fallback:', sendErr);
            }
          }
        })()
      );
      return NextResponse.json({ ok: true, msg: 'Context sent' });
    }

    // 13. Respond to /recap
    if (isRecapCommand) {
      const recapArg = text.replace(/^\/recap(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();
      let requested = parseInt(recapArg, 10);
      let note = '';

      if (!Number.isInteger(requested) || requested <= 0) {
        requested = DEFAULT_RECAP;
        if (recapArg.length > 0) {
          note = `Didn't catch a number, recapping the last ${DEFAULT_RECAP}.`;
        }
      } else if (requested > MAX_RECAP) {
        requested = MAX_RECAP;
        note = `Recapping the last ${MAX_RECAP} messages (max).`;
      }

      try {
        await setMessageReaction(bot.telegram_bot_token, message.chat.id, message.message_id, '👀');
      } catch (err) {
        console.error('Reaction error:', err);
      }

      waitUntil(
        (async () => {
          try {
            const result = await runWithStatus({
              token: bot.telegram_bot_token,
              chatId: message.chat.id,
              threadId,
              replyToMessageId: message.message_id,
              initialStatus: STATUS_RECAP,
              work: async () => recapConversation({
                entityId: entity.id,
                groupId: group.id,
                threadId,
                limit: requested,
                botId,
                note: note || null,
              }),
              mapError: () => '⚠️ Sorry, couldn\'t build a recap right now.',
            });

            if (result) {
              try {
                await logBotResponse({
                  entityId: entity.id,
                  groupId: group.id,
                  telegramChatId: message.chat.id,
                  telegramThreadId: threadId,
                  botUsername: bot.telegram_username,
                  messageText: result.text,
                  summary: null,
                  generationMetadata: {
                    model: bot.model || getModelIdentifier(),
                    thread_id: threadId,
                    kind: 'recap',
                    recap_limit: requested,
                  },
                });
              } catch (err) {
                console.error('Failed to log recap response:', err);
              }
            }
          } catch (err) {
            console.error('Error handling /recap:', err);
            try {
              await sendMessage(
                bot.telegram_bot_token,
                message.chat.id,
                `⚠️ <i>Sorry, couldn't build a recap right now.</i>`,
                { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
              );
            } catch (sendErr) {
              console.error('Failed fallback:', sendErr);
            }
          }
        })()
      );
      return NextResponse.json({ ok: true, msg: 'Recap processing' });
    }

    // 13b. Respond to /push
    if (isPushCommand) {
      try {
        await setMessageReaction(bot.telegram_bot_token, message.chat.id, message.message_id, '👀');
      } catch (err) {
        console.error('Reaction error in /push:', err);
      }

      const pushArg = text.replace(/^\/push(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();
      const normalized = pushArg.toLowerCase();
      let scope: 'topic' | 'group' | null = null;
      if (normalized === 'topic' || normalized === 't') scope = 'topic';
      else if (normalized === 'group' || normalized === 'g') scope = 'group';

      const usageMessage = 'Usage: reply to a message with <code>/push topic</code> or <code>/push group</code> to save it as lasting context. (Group admins only.)';

      if (!scope) {
        try {
          await sendMessage(bot.telegram_bot_token, message.chat.id, usageMessage, {
            threadId,
            replyToMessageId: message.message_id,
            parseMode: 'HTML',
          });
        } catch (sendErr) {
          console.error('Failed to send usage message:', sendErr);
        }
        return NextResponse.json({ ok: true, msg: 'Invalid push scope' });
      }

      const replyTarget = message.reply_to_message;
      if (!replyTarget) {
        try {
          await sendMessage(bot.telegram_bot_token, message.chat.id, 'Reply to a message with <code>/push topic</code> or <code>/push group</code> to save its text as lasting context.', {
            threadId,
            replyToMessageId: message.message_id,
            parseMode: 'HTML',
          });
        } catch (sendErr) {
          console.error('Failed to send missing-reply prompt:', sendErr);
        }
        return NextResponse.json({ ok: true, msg: 'Missing reply target' });
      }

      const rawTargetText = replyTarget.text?.trim() ?? null;
      if (replyTarget.document && !rawTargetText) {
        try {
          await sendMessage(bot.telegram_bot_token, message.chat.id, "I can't push a document directly. Mention me on it first to get a text summary, then reply to that summary with /push.", {
            threadId,
            replyToMessageId: message.message_id,
          });
        } catch (sendErr) {
          console.error('Failed to send direct-doc prompt:', sendErr);
        }
        return NextResponse.json({ ok: true, msg: 'Direct document push rejected' });
      }

      if (!rawTargetText) {
        try {
          await sendMessage(bot.telegram_bot_token, message.chat.id, 'I can only push text messages. Reply to a text message (or one of my text answers) with /push.', {
            threadId,
            replyToMessageId: message.message_id,
          });
        } catch (sendErr) {
          console.error('Failed to send text-only prompt:', sendErr);
        }
        return NextResponse.json({ ok: true, msg: 'Non-text push rejected' });
      }

      let isAdmin = false;
      const callerId = message.from?.id ?? null;
      if (callerId !== null) {
        try {
          const chatMember = await getChatMember(bot.telegram_bot_token, message.chat.id, callerId);
          const status = chatMember?.result?.status;
          if (status === 'administrator' || status === 'creator') {
            isAdmin = true;
          }
        } catch (err) {
          console.error('Failed to check admin status for push:', err);
        }
      }

      if (!isAdmin) {
        try {
          await sendMessage(bot.telegram_bot_token, message.chat.id, 'Only a group admin can push context here.', {
            threadId,
            replyToMessageId: message.message_id,
          });
        } catch (sendErr) {
          console.error('Failed to send admin-only warning:', sendErr);
        }
        return NextResponse.json({ ok: true, msg: 'Unauthorized push' });
      }

      waitUntil(
        (async () => {
          try {
            await runWithStatus({
              token: bot.telegram_bot_token,
              chatId: message.chat.id,
              threadId,
              replyToMessageId: message.message_id,
              initialStatus: '💭 Saving this to context…',
              work: async () => {
                if (scope === 'topic' && threadId === null) {
                  throw new Error('no_topic_here');
                }

                const pushedResult = await pushContext({
                  entityId: entity.id,
                  groupId: group.id,
                  scope: scope!,
                  threadTelegramId: threadId,
                  content: rawTargetText,
                  originChatId: message.chat.id.toString(),
                  originMessageId: replyTarget.message_id.toString(),
                  pushedByTgUserId: callerId!,
                  pushedByUsername: message.from?.username ?? null,
                  botId,
                  model: bot.model || undefined,
                });

                const scopeLabel = scope === 'topic' ? 'this topic' : 'this group';
                const prefix = pushedResult.isUpdate ? '🔄 <b>Updated in ' : '✅ <b>Saved to ';
                const escapedSnippet = sanitizeForTelegramHtml(
                  rawTargetText.length > 100 ? rawTargetText.slice(0, 100) + '…' : rawTargetText
                );

                const htmlString = `${prefix}${scopeLabel}</b>\n\n<b>${pushedResult.name}</b>\n${escapedSnippet}`;
                return htmlToFormattable(htmlString);
              },
              mapError: (err: any) => {
                if (err?.message === 'no_topic_here') {
                  return "There's no topic here to push to — try /push group instead, or push from inside a specific topic.";
                }
                return '⚠️ Sorry, something went wrong while processing your request.';
              },
            });
          } catch (err) {
            console.error('Error handling async push workflow:', err);
          }
        })()
      );
      return NextResponse.json({ ok: true, msg: 'Push processing' });
    }

    // 14. Respond to Mentions (answer Question) (S4)
    if (isBotMention) {
      try {
        await setMessageReaction(bot.telegram_bot_token, message.chat.id, message.message_id, '👀');
      } catch (err) {
        console.error('Reaction error:', err);
      }

      waitUntil(
        (async () => {
          try {
            if (message.from) {
              await resolveUser(entity.id, group.id, message.from);
            }

            const targetDoc = message.document ?? message.reply_to_message?.document;
            if (targetDoc) {
              // 1. MIME check
              if (targetDoc.mime_type !== 'application/pdf') {
                await sendMessage(
                  bot.telegram_bot_token,
                  message.chat.id,
                  'I can only read PDF documents right now.',
                  { threadId, replyToMessageId: message.message_id }
                );
                return;
              }

              // 2. Size check
              if (targetDoc.file_size && targetDoc.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
                await sendMessage(
                  bot.telegram_bot_token,
                  message.chat.id,
                  'That file is too large for me to read (max 20 MB).',
                  { threadId, replyToMessageId: message.message_id }
                );
                return;
              }

              const result = await runWithStatus({
                token: bot.telegram_bot_token,
                chatId: message.chat.id,
                threadId,
                replyToMessageId: message.message_id,
                initialStatus: STATUS_DOC_DOWNLOAD,
                work: async (updateStatus) => {
                  const fileData = await downloadTelegramFile(bot.telegram_bot_token, targetDoc.file_id);
                  await updateStatus(STATUS_DOC_READING);
                  return answerAboutDocument({
                    entityId: entity.id,
                    groupId: group.id,
                    threadId,
                    question,
                    document: {
                      data: fileData.data,
                      mediaType: 'application/pdf',
                    },
                    botId,
                  });
                },
                mapError: (err) => {
                  if (err instanceof DocumentReadError) {
                    if (err.reason === 'too_many_pages') {
                      return 'That PDF has too many pages for me to read — the limit is 100 pages.';
                    } else if (err.reason === 'unreadable') {
                      return 'I was unable to read that PDF. Please ensure it is not password-protected or corrupt.';
                    }
                  }
                  return '⚠️ Sorry, something went wrong while processing your request.';
                },
              });

              if (result) {
                try {
                  await logBotResponse({
                    entityId: entity.id,
                    groupId: group.id,
                    telegramChatId: message.chat.id,
                    telegramThreadId: threadId,
                    botUsername: bot.telegram_username,
                    messageText: result.text,
                    summary: null,
                    generationMetadata: {
                      model: ANTHROPIC_DOCUMENT_MODEL,
                      thread_id: threadId,
                      kind: 'document_qa',
                    },
                  });
                } catch (logErr) {
                  console.error('Failed to log bot response for document QA:', logErr);
                }
              }
            } else {
              // Normal answer flow
              const result = await runWithStatus({
                token: bot.telegram_bot_token,
                chatId: message.chat.id,
                threadId,
                replyToMessageId: message.message_id,
                initialStatus: STATUS_QUESTION,
                work: async () => answerQuestion({
                  entityId: entity.id,
                  groupId: group.id,
                  threadId: threadId,
                  question: question,
                  model: bot.model,
                  persona: bot.persona,
                  botId,
                }),
                mapError: () => '⚠️ Sorry, something went wrong while processing your request.',
              });

              if (result) {
                try {
                  await logBotResponse({
                    entityId: entity.id,
                    groupId: group.id,
                    telegramChatId: message.chat.id,
                    telegramThreadId: threadId,
                    botUsername: bot.telegram_username,
                    messageText: result.text,
                    summary: null,
                    generationMetadata: {
                      model: bot.model || getModelIdentifier(),
                      thread_id: threadId,
                    },
                  });
                } catch (err) {
                  console.error('Failed to log bot response:', err);
                }
              }
            }
          } catch (err: any) {
            console.error('Error handling async answer workflow:', err);
            try {
              await sendMessage(
                bot.telegram_bot_token,
                message.chat.id,
                `⚠️ <i>Sorry, something went wrong while processing your request.</i>`,
                { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
              );
            } catch (sendErr) {
              console.error('Failed fallback:', sendErr);
            }
          }
        })()
      );
      return NextResponse.json({ ok: true, msg: 'Processing asynchronously' });
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Telegram webhook handler crash:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function buildContextDocument(
  entityDocs: { display_name: string; content: string }[],
  groupDocs: { display_name: string; content: string }[],
  topicDocs: { display_name: string; content: string }[]
): string {
  const sections: string[] = [];
  sections.push(`# Context the bot answers from\n`);
  sections.push(`## Entity context\n`);
  if (entityDocs.length > 0) {
    for (const d of entityDocs) {
      sections.push(`### ${d.display_name}\n\n${d.content}\n`);
    }
  } else {
    sections.push(`_No entity-general context._\n`);
  }
  sections.push(`## Group context\n`);
  if (groupDocs.length > 0) {
    for (const d of groupDocs) {
      sections.push(`### ${d.display_name}\n\n${d.content}\n`);
    }
  } else {
    sections.push(`_No group-scoped context._\n`);
  }
  sections.push(`## Topic context\n`);
  if (topicDocs.length > 0) {
    for (const d of topicDocs) {
      sections.push(`### ${d.display_name}\n\n${d.content}\n`);
    }
  } else {
    sections.push(`_No topic-specific context._\n`);
  }
  return sections.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
