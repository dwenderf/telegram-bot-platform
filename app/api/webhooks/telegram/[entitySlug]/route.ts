import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { sql, withTenantContext } from '@/lib/supabase';
import {
  resolveTenant,
  resolveUser,
  answerQuestion,
  logMessage,
  getContextManifest,
  logBotResponse,
  recapConversation,
} from '@/lib/capabilities';
import {
  setMessageReaction,
  sendChatAction,
  sendMessage,
  sendDocument,
  sanitizeForTelegramHtml,
} from '@/lib/telegram';

const DEFAULT_RECAP = 20;
const MAX_RECAP = 100;

interface RouteParams {
  params: Promise<{
    entitySlug: string;
  }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  try {
    const { entitySlug } = await params;
    
    // 1. Bootstrap RLS: Resolve the entity ID from public slug
    // This calls the SECURITY DEFINER function to bypass RLS and get the non-secret UUID.
    const bootstrapResult = await sql<any[]>`
      select resolve_entity_id_by_slug(${entitySlug}) as id
    `;

    const entityId = bootstrapResult[0]?.id;
    if (!entityId) {
      console.warn(`Webhook triggered for unknown tenant slug: ${entitySlug}`);
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    const entity = await withTenantContext(entityId, async (tx) => {
      const rows = await tx<any[]>`
        select e.id, e.slug, e.telegram_bot_username, e.excluded_thread_ids,
               get_current_entity_secret(e.telegram_bot_token_id) as telegram_bot_token,
               get_current_entity_secret(e.telegram_webhook_secret_id) as telegram_webhook_secret
        from entities e
        where e.id = ${entityId}
        limit 1
      `;
      return rows[0];
    });

    if (!entity) {
      return NextResponse.json({ error: 'Tenant config mismatch' }, { status: 404 });
    }

    // 3. Auth: Verify the x-telegram-bot-api-secret-token header
    const incomingSecret = req.headers.get('x-telegram-bot-api-secret-token');
    if (incomingSecret !== entity.telegram_webhook_secret) {
      console.warn(`Unauthorized webhook attempt on tenant: ${entitySlug}`);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const update = await req.json();

    // 4. Deduplicate: Idempotency check using update_id
    const updateId = update.update_id;
    if (updateId) {
      try {
        await withTenantContext(entity.id, async (tx) => {
          await tx`
            insert into processed_updates (update_id, entity_id)
            values (${updateId}, ${entity.id})
          `;
        });
      } catch (err) {
        // Unique constraint violation means we already processed this update
        console.info(`Duplicate update ignored (Idempotency): ${updateId}`);
        return NextResponse.json({ ok: true, msg: 'Duplicate ignored' });
      }
    }

    const message = update.message;
    if (!message || !message.chat || !message.text) {
      // Return 200 OK for unhandled update types
      return NextResponse.json({ ok: true });
    }

    // 5. Resolve group and verify it matches the current entity
    const text = message.text.trim();
    const botUsername = entity.telegram_bot_username;
    const threadId = message.message_thread_id !== undefined ? message.message_thread_id : null;

    // Determine intents
    const isAskCommand = text.startsWith('/ask');
    const isHelpCommand = text.startsWith('/help');
    const isContextCommand = text.startsWith('/context');
    const isWhoamiCommand = text.startsWith('/whoami');
    const isRecapCommand = text.startsWith('/recap');
    const isMention = text.includes(`@${botUsername}`);

    let isCommand = false;
    let isBotMention = false;
    let question = '';

    if (isHelpCommand) {
      isCommand = true;
    } else if (isContextCommand) {
      isCommand = true;
    } else if (isWhoamiCommand) {
      isCommand = true;
    } else if (isRecapCommand) {
      isCommand = true;
    } else if (isAskCommand) {
      isCommand = true;
      question = text.replace(/^\/ask(?:@[a-zA-Z0-9_]+)?\s*/i, '');
    } else if (isMention) {
      isBotMention = true;
      question = text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '');
    }

    // 5. Resolve group context if registered
    const tenantInfo = await resolveTenant(entity.id, message.chat.id);
    const group = tenantInfo && tenantInfo.entity.id === entity.id ? tenantInfo.group : null;

    // 5b. Respond to /whoami — echo the raw Telegram ids + resolved entity/group when known.
    // MUST run before the untracked-group bail-out so it works during onboarding.
    if (isWhoamiCommand) {
      const chatId = message.chat.id;
      const fromId = message.from?.id ?? null;
      const fromUsername = message.from?.username ?? null;

      const entityLabel = entity?.slug ?? 'unregistered';
      const groupLabel = group?.display_name ?? 'unregistered';

      // Compute exclusion status so /whoami can report WHY the bot is silent here.
      // (This is the diagnostic value of /whoami running above the excluded gate.)
      const whoamiExcluded =
        threadId !== null &&
        entity.excluded_thread_ids &&
        entity.excluded_thread_ids.some(
          (id: any) => id.toString() === threadId.toString()
        );

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

      // Log the command execution only if group is registered
      if (group) {
        const isExcluded = whoamiExcluded;

        if (!isExcluded) {
          try {
            await logMessage({
              entityId: entity.id,
              groupId: group.id,
              telegramChatId: chatId,
              telegramThreadId: threadId,
              telegramUserId: fromId,
              username: fromUsername || message.from?.first_name || 'User',
              messageText: text,
              isCommand: true,
              isBotMention: false,
            });
          } catch (err) {
            console.error('Failed to log whoami command:', err);
          }
        }
      }

      await sendMessage(
        entity.telegram_bot_token,
        chatId,
        lines.join('\n'),
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );

      return NextResponse.json({ ok: true, msg: 'whoami sent' });
    }

    // 5c. Resolve group check for non-whoami requests — bail early if untracked
    if (!group) {
      console.info(`Message received from untracked chat ID: ${message.chat.id}`);
      return NextResponse.json({ ok: true, msg: 'Untracked group' });
    }

    // 5d. Excluded-thread gate (single choke point for ALL commands below).
    // If this thread is in the entity's excluded_thread_ids, the bot stays out:
    //   - it does NOT log the message, and
    //   - it does NOT dispatch any command (/help, /context, /recap, /ask, @mention).
    // It declines ONCE, but only when actually addressed (a command or @mention),
    // so it stays silent on ordinary chatter in the excluded thread.
    // (/whoami is intentionally handled in 5b, ABOVE this gate, so it still works
    // here as a diagnostic — including reporting that this thread is excluded.)
    // Placing the gate here means every current AND future command inherits this
    // behavior automatically — no per-command exclusion check to maintain.
    const isExcluded =
      threadId !== null &&
      entity.excluded_thread_ids &&
      entity.excluded_thread_ids.some(
        (id: any) => id.toString() === threadId.toString()
      );

    if (isExcluded) {
      if (isCommand || isBotMention) {
        // Addressed directly → decline once so the user isn't left wondering.
        try {
          await sendMessage(
            entity.telegram_bot_token,
            message.chat.id,
            `⛔️ <i>I'm not configured to operate in this topic.</i>`,
            { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
          );
        } catch (err) {
          console.error('Failed to send excluded-thread notice:', err);
        }
      }
      // Either way: do not log, do not dispatch any command.
      return NextResponse.json({ ok: true, msg: 'Excluded thread' });
    }

    // 6. Log the message (we're past the excluded-thread gate, so the thread is
    //    not excluded — log unconditionally).
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
    });

    // 7. Respond to /help
    if (isHelpCommand) {
      waitUntil(
        (async () => {
          const helpText = `<b>Telegram Bot Platform v1 Help</b>\n\n` +
            `• Use <code>/ask &lt;question&gt;</code> to ask me a question grounded in the repository context.\n` +
            `• Use <code>/context</code> to see what documentation I'm answering from in this topic.\n` +
            `• Use <code>/recap [N]</code> to summarize the last N messages here (default 20).\n` +
            `• Use <code>/whoami</code> to show this chat's ids (useful for setup/diagnostics).\n` +
            `• Mention me <code>@${botUsername} &lt;question&gt;</code> inside a topic to ask a question.\n` +
            `• Use <code>/help</code> to see this message.`;

          await sendMessage(entity.telegram_bot_token, message.chat.id, helpText, {
            threadId,
            replyToMessageId: message.message_id,
            parseMode: 'HTML',
          });
        })()
      );

      return NextResponse.json({ ok: true, msg: 'Help sent' });
    }

    // 7b. Respond to /context — show what the bot answers from here (read-only).
    if (isContextCommand) {
      waitUntil(
        (async () => {
          try {
            const { entityDocs, topicDocs } = await getContextManifest(entity.id, threadId);

            const totalDocs = entityDocs.length + topicDocs.length;

            // (1) Inline summary — status-based metrics (ADDENDUM 1)
            const entityText = entityDocs.length > 0
              ? `✓ ${entityDocs.length} document${entityDocs.length === 1 ? '' : 's'}`
              : `<i>— none set</i>`;
            
            const groupText = `<i>— not enabled in this version</i>`;
            
            const topicText = topicDocs.length > 0
              ? `✓ ${topicDocs.length} document${topicDocs.length === 1 ? '' : 's'}`
              : `<i>— none set</i>`;

            const summaryLines: string[] = [];
            summaryLines.push(`<b>📚 Context for this topic</b>`);
            summaryLines.push('');
            summaryLines.push(`<b>Entity:</b> ${entityText}`);
            summaryLines.push(`<b>Group:</b> ${groupText}`);
            summaryLines.push(`<b>Topic:</b> ${topicText}`);
            summaryLines.push('');
            
            if (totalDocs > 0) {
              summaryLines.push(`📎 Full text attached below ↓`);
            } else {
              summaryLines.push(`<i>No context is configured for this topic yet.</i>`);
            }

            await sendMessage(
              entity.telegram_bot_token,
              message.chat.id,
              summaryLines.join('\n'),
              { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
            );

            // (2) Full content as an attached markdown file — only if there's content.
            if (totalDocs > 0) {
              const docMarkdown = buildContextDocument(entityDocs, topicDocs);
              await sendDocument(
                entity.telegram_bot_token,
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
                entity.telegram_bot_token,
                message.chat.id,
                `⚠️ <i>Sorry, couldn't retrieve the context right now.</i>`,
                { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
              );
            } catch (sendErr) {
              console.error('Failed to send /context error fallback:', sendErr);
            }
          }
        })()
      );

      return NextResponse.json({ ok: true, msg: 'Context sent' });
    }

    // 7c. Respond to /recap — summarize the last N messages in this thread (model call).
    if (isRecapCommand) {
      // Parse requested limit
      const recapArg = text.replace(/^\/recap(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();

      let requested = parseInt(recapArg, 10);
      let note = ''; // optional user-facing note about clamping/fallback

      if (!Number.isInteger(requested) || requested <= 0) {
        requested = DEFAULT_RECAP;
        if (recapArg.length > 0) {
          note = `Didn't catch a number, recapping the last ${DEFAULT_RECAP}.`;
        }
      } else if (requested > MAX_RECAP) {
        requested = MAX_RECAP;
        note = `Recapping the last ${MAX_RECAP} messages (max).`;
      }

      // 1. Immediate ack (same as /ask): 👀 + typing
      try {
        await setMessageReaction(entity.telegram_bot_token, message.chat.id, message.message_id, '👀');
      } catch (err) {
        console.error('Failed to set eyes reaction:', err);
      }
      try {
        await sendChatAction(entity.telegram_bot_token, message.chat.id, 'typing', threadId);
      } catch (err) {
        console.error('Failed to send typing action:', err);
      }

      // 2. Slow part async
      waitUntil(
        (async () => {
          try {
            const { recapText } = await recapConversation({
              entityId: entity.id,
              groupId: group.id,
              threadId,
              limit: requested,
            });

            const prefix = note ? `<i>${escapeHtml(note)}</i>\n\n` : '';
            const sanitized = sanitizeForTelegramHtml(recapText);

            await sendMessage(
              entity.telegram_bot_token,
              message.chat.id,
              prefix + sanitized,
              { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
            );

            // Phase 1 storage: a recap IS a bot response → log it (so the log stays complete).
            try {
              await logBotResponse({
                entityId: entity.id,
                groupId: group.id,
                telegramChatId: message.chat.id,
                telegramThreadId: threadId,
                botUsername: entity.telegram_bot_username,
                messageText: recapText,
                summary: null,
                generationMetadata: {
                  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
                  thread_id: threadId,
                  kind: 'recap',
                  recap_limit: requested,
                },
              });
            } catch (err) {
              console.error('Failed to log recap response:', err);
            }
          } catch (err) {
            console.error('Error handling /recap:', err);
            try {
              await sendMessage(
                entity.telegram_bot_token,
                message.chat.id,
                `⚠️ <i>Sorry, couldn't build a recap right now.</i>`,
                { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
              );
            } catch (sendErr) {
              console.error('Failed to send /recap error fallback:', sendErr);
            }
          }
        })()
      );

      return NextResponse.json({ ok: true, msg: 'Recap processing' });
    }

    // 8. Respond to /ask or Mentions
    if (isAskCommand || isBotMention) {
      // Immediate acknowledgment:
      try {
        await setMessageReaction(entity.telegram_bot_token, message.chat.id, message.message_id, '👀');
      } catch (err) {
        console.error('Failed to set eyes reaction:', err);
      }

      try {
        await sendChatAction(entity.telegram_bot_token, message.chat.id, 'typing', threadId);
      } catch (err) {
        console.error('Failed to send typing action:', err);
      }

      // Execute slow LLM task asynchronously in background
      waitUntil(
        (async () => {
          try {
            if (message.from) {
              await resolveUser(entity.id, group.id, message.from);
            }

            const { answerText } = await answerQuestion({
              entityId: entity.id,
              groupId: group.id,
              threadId: threadId,
              question: question,
            });

            const sanitizedAnswer = sanitizeForTelegramHtml(answerText);

            await sendMessage(entity.telegram_bot_token, message.chat.id, sanitizedAnswer, {
              threadId: threadId,
              replyToMessageId: message.message_id,
              parseMode: 'HTML',
            });

            // Phase 1: record the bot's response so the conversation log is complete
            // (enables /recap and future multi-turn context). Non-fatal if it fails.
            try {
              await logBotResponse({
                entityId: entity.id,
                groupId: group.id,
                telegramChatId: message.chat.id,
                telegramThreadId: threadId,
                botUsername: entity.telegram_bot_username,
                messageText: answerText,   // store the ORIGINAL answer, not the HTML-sanitized one
                summary: null,             // Phase 2 will fill this for long answers
                generationMetadata: {
                  model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
                  thread_id: threadId,
                },
              });
            } catch (err) {
              console.error('Failed to log bot response:', err);
            }
          } catch (err: any) {
            console.error('Error handling async answer workflow:', err);
            try {
              await sendMessage(
                entity.telegram_bot_token,
                message.chat.id,
                `⚠️ <i>Sorry, something went wrong while processing your request.</i>`,
                {
                  threadId: threadId,
                  replyToMessageId: message.message_id,
                  parseMode: 'HTML',
                }
              );
            } catch (sendErr) {
              console.error('Failed to send error fallback message:', sendErr);
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

// Assemble the full-context markdown document (Entity / Group / Topic sections).
function buildContextDocument(
  entityDocs: { doc_path: string; content: string }[],
  topicDocs: { doc_path: string; content: string }[]
): string {
  const sections: string[] = [];
  sections.push(`# Context the bot answers from\n`);

  sections.push(`## Entity context\n`);
  if (entityDocs.length > 0) {
    for (const d of entityDocs) {
      sections.push(`### ${d.doc_path}\n\n${d.content}\n`);
    }
  } else {
    sections.push(`_No entity-general context._\n`);
  }

  sections.push(`## Group context\n`);
  sections.push(`_Group-scoped context is not enabled in this version._\n`);

  sections.push(`## Topic context\n`);
  if (topicDocs.length > 0) {
    for (const d of topicDocs) {
      sections.push(`### ${d.doc_path}\n\n${d.content}\n`);
    }
  } else {
    sections.push(`_No topic-specific context._\n`);
  }

  return sections.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
