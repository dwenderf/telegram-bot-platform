import { sql, withTenantContext } from './supabase';
import { callModel } from './anthropic';

export interface Entity {
  id: string;
  slug: string;
  display_name: string;
  github_owner: string | null;
  github_repo: string | null;
  github_branch: string | null;
  context_root: string | null;
  telegram_bot_username: string;
  excluded_thread_ids: string[];
  telegram_bot_token: string;
  telegram_webhook_secret: string;
  github_token: string | null;
  created_at: Date;
}

export interface Group {
  id: string;
  entity_id: string;
  telegram_chat_id: string; // postgres bigint returns as string
  display_name: string | null;
  created_at: Date;
}

export interface User {
  id: string;
  entity_id: string;
  telegram_user_id: string; // postgres bigint returns as string
  username: string | null;
  display_name: string | null;
  created_at: Date;
}

/**
 * Resolve which entity + group an incoming Telegram chat maps to.
 * Scoped inside the RLS context of the resolved entityId.
 */
export async function resolveTenant(
  entityId: string,
  telegramChatId: bigint | number | string
): Promise<{ entity: Entity; group: Group } | null> {
  const chatIdStr = telegramChatId.toString();

  return await withTenantContext(entityId, async (tx) => {
    // Query the group mapping (RLS-enforced)
    const groups = await tx<Group[]>`
      select id, entity_id, telegram_chat_id, display_name, created_at
      from groups
      where telegram_chat_id = ${chatIdStr}
      limit 1
    `;

    if (groups.length === 0) {
      return null;
    }

    const group = groups[0];

    // Query the entity joining with decrypted secrets from Supabase Vault (RLS-enforced)
    const entities = await tx<any[]>`
      select e.id, e.slug, e.display_name, e.github_owner, e.github_repo, e.github_branch, e.context_root,
             e.telegram_bot_username, e.excluded_thread_ids, e.created_at,
             get_current_entity_secret(e.telegram_bot_token_id) as telegram_bot_token,
             get_current_entity_secret(e.telegram_webhook_secret_id) as telegram_webhook_secret,
             get_current_entity_secret(e.github_token_id) as github_token
      from entities e
      where e.id = ${group.entity_id}
      limit 1
    `;

    if (entities.length === 0) {
      return null;
    }

    return {
      entity: entities[0] as Entity,
      group,
    };
  });
}

/**
 * Resolve (and lazily upsert) the user + their role in this group.
 */
export async function resolveUser(
  entityId: string,
  groupId: string,
  telegramUser: {
    id: bigint | number | string;
    username?: string | null;
    first_name: string;
    last_name?: string | null;
  }
): Promise<{ user: User; role: string }> {
  const userIdStr = telegramUser.id.toString();
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ').trim() || null;
  const username = telegramUser.username || null;

  return await withTenantContext(entityId, async (tx) => {
    // 1. Upsert the user profile
    const users = await tx<User[]>`
      insert into users (entity_id, telegram_user_id, username, display_name)
      values (${entityId}, ${userIdStr}, ${username}, ${displayName})
      on conflict (entity_id, telegram_user_id) do update set
        username = excluded.username,
        display_name = excluded.display_name
      returning id, entity_id, telegram_user_id, username, display_name, created_at
    `;

    const user = users[0];

    // 2. Upsert membership
    const memberships = await tx`
      insert into memberships (user_id, group_id, entity_id, role)
      values (${user.id}, ${groupId}, ${entityId}, 'member')
      on conflict (user_id, group_id) do update set
        updated_at = now()
      returning role
    `;

    const role = memberships[0]?.role || 'member';

    return {
      user,
      role,
    };
  });
}

/**
 * Build the context block for a question: entity-general docs + this-topic docs (from manifest + doc_cache),
 * plus recent conversation (from message_log).
 */
export async function buildContext(
  entityId: string,
  groupId: string,
  threadId: bigint | number | string | null
): Promise<{ contextDocs: string; recentConversation: string }> {
  const threadIdStr = threadId !== null && threadId !== undefined ? threadId.toString() : null;

  return await withTenantContext(entityId, async (tx) => {
    // 1. Fetch manifest entries and join with cached doc content
    const docs = await tx`
      select m.telegram_thread_id, c.doc_path, c.content
      from manifest_entries m
      join doc_cache c on c.entity_id = m.entity_id and c.doc_path = m.doc_path
      where m.entity_id = ${entityId}
        and (m.telegram_thread_id is null
             or m.telegram_thread_id is not distinct from ${threadIdStr})
    `;

    // Sort: general docs (thread_id is null) first, then thread-specific docs
    const sortedDocs = [...docs].sort((a, b) => {
      if (a.telegram_thread_id === null && b.telegram_thread_id !== null) return -1;
      if (a.telegram_thread_id !== null && b.telegram_thread_id === null) return 1;
      return 0;
    });

    // Format docs as structured XML tags
    const contextDocs = sortedDocs
      .map(
        (doc) =>
          `<document path="${doc.doc_path}">\n${doc.content}\n</document>`
      )
      .join('\n\n');

    // 2. Fetch the most recent 30 messages in this thread
    const messages = await tx`
      select username, message_text, created_at
      from message_log
      where group_id = ${groupId}
        and telegram_thread_id is not distinct from ${threadIdStr}
      order by created_at desc
      limit 30
    `;

    // Format messages in chronological order (oldest first)
    const recentConversation = messages
      .reverse()
      .map((msg: any) => `${msg.username || 'User'}: ${msg.message_text || ''}`)
      .join('\n');

    return {
      contextDocs: contextDocs || 'No documentation context available for this topic.',
      recentConversation: recentConversation || 'No recent conversation messages.',
    };
  });
}

/**
 * Generate an answer. Internally builds the system prompt, calls the model provider, and returns answer.
 */
export async function answerQuestion(input: {
  entityId: string;
  groupId: string;
  threadId: bigint | number | string | null;
  question: string;
}): Promise<{ answerText: string }> {
  // Load the project documentation and recent transcript context
  const { contextDocs, recentConversation } = await buildContext(
    input.entityId,
    input.groupId,
    input.threadId
  );

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  const systemPrompt = `You are a helpful AI assistant for the team. Answer the user's question accurately based ONLY on the provided context documents. If the answer cannot be determined from the context, politely state that you do not know.

OUTPUT FORMAT RULES (CRITICAL):
- Use Telegram-HTML format.
- ONLY use the following whitelisted HTML tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">.
- Use bullet points like "• " for lists.
- Avoid unsupported tags like <p>, <ul>, <li>, <h1>, <div>, etc.
- Escape literal <, >, and & (e.g. use &amp; for ampersands, &lt; for less-than, &gt; for greater-than).

PROJECT CONTEXT:
${contextDocs}

RECENT CONVERSATION:
${recentConversation}`;

  const result = await callModel({
    systemPrompt,
    userMessage: input.question,
    model,
  });

  return {
    answerText: result.text,
  };
}

/**
 * Log an incoming message.
 */
export async function logMessage(input: {
  entityId: string;
  groupId: string;
  telegramChatId: bigint | number | string;
  telegramThreadId: bigint | number | string | null;
  telegramUserId: bigint | number | string | null;
  username: string | null;
  messageText: string;
  isCommand: boolean;
  isBotMention: boolean;
}): Promise<void> {
  const chatIdStr = input.telegramChatId.toString();
  const threadIdStr = input.telegramThreadId !== null && input.telegramThreadId !== undefined ? input.telegramThreadId.toString() : null;
  const userIdStr = input.telegramUserId !== null && input.telegramUserId !== undefined ? input.telegramUserId.toString() : null;

  await withTenantContext(input.entityId, async (tx) => {
    await tx`
      insert into message_log (
        entity_id,
        group_id,
        telegram_chat_id,
        telegram_thread_id,
        telegram_user_id,
        username,
        message_text,
        is_command,
        is_bot_mention
      ) values (
        ${input.entityId},
        ${input.groupId},
        ${chatIdStr},
        ${threadIdStr},
        ${userIdStr},
        ${input.username},
        ${input.messageText},
        ${input.isCommand},
        ${input.isBotMention}
      )
    `;
  });
}

/**
 * Log the bot's own outgoing response to message_log (is_bot_response = true).
 * summary stays null in Phase 1 (Phase 2 will populate it for long responses).
 * generationMetadata captures provenance for debugging / future "explain this answer".
 */
export async function logBotResponse(input: {
  entityId: string;
  groupId: string;
  telegramChatId: bigint | number | string;
  telegramThreadId: bigint | number | string | null;
  botUsername: string;              // stored in `username` so recaps read naturally
  messageText: string;              // the full answer text the bot sent
  summary?: string | null;          // Phase 2; pass null/undefined for now
  generationMetadata?: Record<string, any> | null;
}): Promise<void> {
  const chatIdStr = input.telegramChatId.toString();
  const threadIdStr =
    input.telegramThreadId !== null && input.telegramThreadId !== undefined
      ? input.telegramThreadId.toString()
      : null;

  await withTenantContext(input.entityId, async (tx) => {
    await tx`
      insert into message_log (
        entity_id, group_id, telegram_chat_id, telegram_thread_id,
        telegram_user_id, username, message_text,
        is_command, is_bot_mention, is_bot_response,
        summary, generation_metadata
      ) values (
        ${input.entityId}, ${input.groupId}, ${chatIdStr}, ${threadIdStr},
        ${null}, ${input.botUsername}, ${input.messageText},
        ${false}, ${false}, ${true},
        ${input.summary ?? null},
        ${input.generationMetadata ? tx.json(input.generationMetadata as any) : null}
      )
    `;
  });
}

/**
 * Summarize the last `limit` messages in a thread. Reads message_log (user msgs +
 * bot responses), formatting each as "Name: text". Uses coalesce(summary, message_text)
 * so long bot answers contribute their stored summary once Phase 2 populates it
 * (today summary is null → falls back to full text). Thread-scoped.
 */
export async function recapConversation(input: {
  entityId: string;
  groupId: string;
  threadId: bigint | number | string | null;
  limit: number;
}): Promise<{ recapText: string }> {
  const threadIdStr =
    input.threadId !== null && input.threadId !== undefined ? input.threadId.toString() : null;

  const transcript = await withTenantContext(input.entityId, async (tx) => {
    const rows = await tx<{ username: string | null; body: string | null; is_bot_response: boolean }[]>`
      select username,
             coalesce(summary, message_text) as body,
             is_bot_response
      from message_log
      where group_id = ${input.groupId}
        and telegram_thread_id is not distinct from ${threadIdStr}
        and message_text is not null
      order by created_at desc
      limit ${input.limit}
    `;
    // rows are newest-first; reverse to chronological for the transcript
    return rows.reverse()
      .map((m) => `${m.username || (m.is_bot_response ? 'Bot' : 'User')}: ${m.body || ''}`)
      .join('\n');
  });

  if (!transcript.trim()) {
    return { recapText: 'There are no recent messages in this topic to recap yet.' };
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const systemPrompt = `You are summarizing a team chat conversation. Produce a concise, well-organized recap of the discussion below.

OUTPUT FORMAT RULES (CRITICAL):
- Use Telegram-HTML format.
- ONLY these tags: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">.
- Use "• " for bullet points.
- No <p>, <ul>, <li>, <h1>, <div>, etc.
- Escape literal <, >, & as &lt; &gt; &amp;.

Guidelines:
- Lead with a one-line <b>summary</b>, then key points / decisions / open questions as bullets.
- Attribute notable points to who said them when useful.
- Be faithful to the transcript; do not invent. If it's short, keep the recap short.`;

  const result = await callModel({
    systemPrompt,
    userMessage: `Recap the last ${input.limit} messages of this conversation:\n\n${transcript}`,
    model,
  });

  return { recapText: result.text };
}

/**
 * Verify that active secret handles in entities resolve to valid tokens in Vault.
 */
export async function checkVaultSecretsHealth(
  entityId: string
): Promise<{ ok: boolean; errors: string[] }> {
  return await withTenantContext(entityId, async (tx) => {
    const entities = await tx<any[]>`
      select 
        telegram_bot_token_id,
        telegram_webhook_secret_id,
        github_token_id,
        get_current_entity_secret(telegram_bot_token_id) as telegram_bot_token,
        get_current_entity_secret(telegram_webhook_secret_id) as telegram_webhook_secret,
        get_current_entity_secret(github_token_id) as github_token
      from entities
      where id = ${entityId}
      limit 1
    `;

    if (entities.length === 0) {
      return { ok: false, errors: ['Entity not found'] };
    }

    const entity = entities[0];
    const errors: string[] = [];

    if (entity.telegram_bot_token_id && !entity.telegram_bot_token) {
      errors.push('telegram_bot_token_id is set but secret could not be decrypted/found in Vault');
    }
    if (entity.telegram_webhook_secret_id && !entity.telegram_webhook_secret) {
      errors.push('telegram_webhook_secret_id is set but secret could not be decrypted/found in Vault');
    }
    if (entity.github_token_id && !entity.github_token) {
      errors.push('github_token_id is set but secret could not be decrypted/found in Vault');
    }

    return {
      ok: errors.length === 0,
      errors,
    };
  });
}

/**
 * Read-only: return the context docs that apply to a given entity + topic,
 * structured by layer (entity-general vs topic-specific). Used by the /context
 * command. Mirrors buildContext's manifest+cache resolution so /context shows
 * exactly what /ask would answer from.
 *
 * NOTE (v1): group-layer scoping (manifest_entries.group_id) is not yet resolved
 * here, matching buildContext. When group-scoped resolution lands (PLANNING §9),
 * update BOTH this and buildContext together so they stay in sync.
 */
export async function getContextManifest(
  entityId: string,
  threadId: bigint | number | string | null
): Promise<{
  entityDocs: { doc_path: string; content: string }[];
  topicDocs: { doc_path: string; content: string }[];
}> {
  const threadIdStr =
    threadId !== null && threadId !== undefined ? threadId.toString() : null;

  return await withTenantContext(entityId, async (tx) => {
    const docs = await tx<{ telegram_thread_id: string | null; doc_path: string; content: string }[]>`
      select m.telegram_thread_id, c.doc_path, c.content
      from manifest_entries m
      join doc_cache c on c.entity_id = m.entity_id and c.doc_path = m.doc_path
      where m.entity_id = ${entityId}
        and (m.telegram_thread_id is null
             or m.telegram_thread_id is not distinct from ${threadIdStr})
      order by c.doc_path
    `;

    const entityDocs = docs
      .filter((d) => d.telegram_thread_id === null)
      .map((d) => ({ doc_path: d.doc_path, content: d.content }));

    const topicDocs = docs
      .filter((d) => d.telegram_thread_id !== null)
      .map((d) => ({ doc_path: d.doc_path, content: d.content }));

    return { entityDocs, topicDocs };
  });
}
