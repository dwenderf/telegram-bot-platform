import { NextRequest, NextResponse } from 'next/server';
import { waitUntil } from '@vercel/functions';
import { sql, withTenantContext } from '@/lib/supabase';
import {
  resolveTenant,
  resolveUser,
  answerQuestion,
  logMessage,
  getContextManifest,
} from '@/lib/capabilities';
import {
  setMessageReaction,
  sendChatAction,
  sendMessage,
  sendDocument,
  sanitizeForTelegramHtml,
} from '@/lib/telegram';

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
        select e.id, e.telegram_bot_username, e.excluded_thread_ids,
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
    const tenantInfo = await resolveTenant(entity.id, message.chat.id);
    if (!tenantInfo || tenantInfo.entity.id !== entity.id) {
      console.info(`Message received from untracked chat ID: ${message.chat.id}`);
      return NextResponse.json({ ok: true, msg: 'Untracked group' });
    }

    const { group } = tenantInfo;
    const text = message.text.trim();
    const botUsername = entity.telegram_bot_username;
    const threadId = message.message_thread_id !== undefined ? message.message_thread_id : null;

    // Determine intents
    const isAskCommand = text.startsWith('/ask');
    const isHelpCommand = text.startsWith('/help');
    const isContextCommand = text.startsWith('/context');
    const isMention = text.includes(`@${botUsername}`);

    let isCommand = false;
    let isBotMention = false;
    let question = '';

    if (isHelpCommand) {
      isCommand = true;
    } else if (isContextCommand) {
      isCommand = true;
    } else if (isAskCommand) {
      isCommand = true;
      question = text.replace(/^\/ask(?:@[a-zA-Z0-9_]+)?\s*/i, '');
    } else if (isMention) {
      isBotMention = true;
      question = text.replace(new RegExp(`@${botUsername}\\s*`, 'gi'), '');
    }

    // 6. Log the message unless the thread is in excluded-topics config
    const isExcluded =
      threadId !== null &&
      entity.excluded_thread_ids &&
      entity.excluded_thread_ids.some(
        (id: any) => id.toString() === threadId.toString()
      );

    if (!isExcluded) {
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
    }

    // 7. Respond to /help
    if (isHelpCommand) {
      waitUntil(
        (async () => {
          const helpText = `<b>Telegram Bot Platform v1 Help</b>\n\n` +
            `• Use <code>/ask &lt;question&gt;</code> to ask me a question grounded in the repository context.\n` +
            `• Use <code>/context</code> to see what documentation I'm answering from in this topic.\n` +
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

            // (1) Inline summary — always small, always fits.
            const summaryLines: string[] = [];
            summaryLines.push(`<b>📚 Context for this topic</b>`);
            summaryLines.push('');
            summaryLines.push(`<b>Entity:</b> ${entityDocs.length > 0 ? entityDocs.map(d => `<code>${escapeHtml(d.doc_path)}</code>`).join(', ') : '<i>none</i>'}`);
            // Group layer not resolved in v1 (PLANNING §9) — show as not-yet-scoped.
            summaryLines.push(`<b>Group:</b> <i>none (group-scoped context not enabled)</i>`);
            summaryLines.push(`<b>Topic:</b> ${topicDocs.length > 0 ? topicDocs.map(d => `<code>${escapeHtml(d.doc_path)}</code>`).join(', ') : '<i>none</i>'}`);
            summaryLines.push('');
            summaryLines.push(`Answering from <b>${totalDocs}</b> document${totalDocs === 1 ? '' : 's'}.`);

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

// Minimal HTML escape for inline summary (doc_paths are simple, but be safe).
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
