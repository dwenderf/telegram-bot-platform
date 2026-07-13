# SPEC — PII Data Minimization & Retention (Group Chat History)

> **Reads against:** `lib/capabilities.ts` (`logMessage`, `logBotResponse`, `buildContext`, `recapConversation`), `lib/isolation.ts` (`pepperedHmac` — will be promoted to shared), `app/api/webhooks/platform/[botSlug]/route.ts` (webhook handler), `lib/telegram.ts` (`sendMessage`), `lib/hmac.ts` (new shared module), `lib/pii.ts` (new), schema migrations.
>
> **Rigor bar:** the retention pipeline must be demonstrable end-to-end without manual SQL — a message logged today must be pseudonymized at Day 14 and purged at Day 30 under cron, with summaries preserved and attributed. The `/optout` command must immediately stop logging a user's future messages and provide status/opt-in/opt-out toggling. A deletion request must remove all messages for a user (except summaries).
>
> **One-line scope:** implement a 14/30-day retention policy: Day 14 → generate thread summary (with attribution) then hash PII; Day 30 → purge raw messages; plus `/optout` toggle command, Entity Admin view of opted-out users, privacy notice delivery, and audit logging.
>
> **Sequencing:** self-contained; builds on `isolation.ts` (promotes `pepperedHmac` to shared), requires new tables/columns, cron jobs, and command handlers. No breaking changes to existing `message_log` rows (additive columns only).

---

## Table of Contents

1. [Why + How the Design Was Pinned](#1-why--how-the-design-was-pinned)
2. [Locked Decisions (Invariants)](#2-locked-decisions-invariants)
3. [Schema Changes](#3-schema-changes)
4. [HMAC Shared Module](#4-hmac-shared-module)
5. [Core Functions (`lib/pii.ts`)](#5-core-functions-libpiits)
6. [`/optout` Toggle Command](#6-optout-toggle-command)
7. [Privacy Notice: Group Link & User Add](#7-privacy-notice-group-link--user-add)
8. [Entity Admin View of Opted-Out Users](#8-entity-admin-view-of-opted-out-users)
9. [`buildContext` — Include Thread Summary](#9-buildcontext--include-thread-summary)
10. [Cron Jobs](#10-cron-jobs)
11. [Audit Logging (Compliance)](#11-audit-logging-compliance)
12. [Environment Variables](#12-environment-variables)
13. [Tests](#13-tests)
14. [Non-Goals & Future Hooks](#14-non-goals--future-hooks)
15. [Handoff Notes](#15-handoff-notes)

---

## 1. Why + How the Design Was Pinned

### The Problem
- `message_log` stores raw PII (`telegram_user_id`, `username`, `message_text`) forever
- GDPR Art. 5(1)(e) requires storage limitation ("kept in a form which permits identification of data subjects for no longer than necessary")
- Non-admin users never accepted ToS — only legitimate interest applies, requiring minimization + transparency + opt-out
- ePrivacy Directive requires consent for non-essential processing (or legitimate interest with strong safeguards)

### The Solution
- **Day 0-14:** Raw data retained (full context for answering, full attribution for summaries)
- **Day 14:** Generate thread summary (with attribution) → then hash PII (pseudonymization)
- **Day 30:** Purge raw messages (keep summary in `threads` table)
- **Ongoing:** `/optout` toggle command blocks future logging; deletion request purges all messages for a user

### Why This Works

| Requirement | How Met |
|-------------|---------|
| **Data minimization** | 30-day max retention for raw/pseudonymized data |
| **Storage limitation** | Automatic purge at Day 30 |
| **Right to erasure** | Delete on request (not just hash) |
| **Transparency** | Privacy notice posted to group on link + on user add |
| **Choice** | `/optout` toggle command (status, confirm, cancel) + group leave |
| **Accountability** | `generation_metadata` logs provenance; summaries are non-PII; audit logging for admin actions |

### Role & Responsibility Model

| Role | Relationship to Platform | Privacy Basis | What They Can Do |
|------|--------------------------|---------------|------------------|
| **Entity Admin** | Signed ToS + Privacy Policy | **Contract** (GDPR Art. 6(1)(b)) | Link groups, manage docs, view excluded users, access audit logs |
| **Group Member** | Never accepted ToS | **Legitimate Interest** (Art. 6(1)(f)) + opt-out | Use bot, ask questions, `/optout` toggle |
| **Platform Operator** | Internal staff | **Internal access controls** + documented in Privacy Policy | Database access (logged) |

---

## 2. Locked Decisions (Invariants)

1. **Retention schedule fixed:**
   - **Day 0-14:** `pii_status = 'raw'` (full PII retained)
   - **Day 14:** Generate summary → set `pii_status = 'pseudonymized'` → hash `telegram_user_id` and `username`
   - **Day 30:** Set `pii_status = 'purged'` → null out `message_text` (keep only summary in `threads`)

2. **Summary timing:** Day 14 (before hashing) so attribution is preserved in the summary. Summary is stored in `threads.summary` and included in `buildContext` as `<thread_summary>`.

3. **Attribution in summaries:** The model is instructed to include names (e.g., "Alice proposed X; Bob raised concern Y"). The summary itself is **non-PII** (aggregate content, not attributable to an identifiable individual in a way that matters).

4. **`/optout` toggle behavior:**
   - User sends `/optout` → shows current status
   - User sends `/optout confirm` → opts out (adds to `excluded_users`)
   - User sends `/optout cancel` → opts back in (removes from `excluded_users`)
   - Future messages from opted-out users are **not logged** (skip in `logMessage`)
   - Existing messages remain subject to retention schedule
   - Opted-out users are **invisible** in recaps, summaries, and context

5. **Deletion request (GDPR Art. 17):**
   - Admin or user requests deletion → find all `message_log` rows with that `telegram_user_id`
   - **Delete** the rows (not just hash) — for `pii_status = 'purged'`, there's nothing to delete (already gone)
   - Summaries **remain** (they are non-PII; if user is specifically mentioned, no action required as summary is aggregate)

6. **`excluded_users` table:**
   - Stores raw `telegram_user_id` (RLS-protected, same as `users` table)
   - No pepper rotation risk (no hashes to invalidate)
   - **Permanent retention** (opt-out must persist indefinitely)
   - Entity Admin can view all excluded users for their entity

7. **Shared HMAC primitive:** Promote `pepperedHmac` from `lib/isolation.ts` to a shared module (`lib/hmac.ts`) so both isolation-scope and PII-hashing use the same pepper with domain separation.

8. **New columns on `message_log`:**
   - `pii_status text NOT NULL DEFAULT 'raw'` (`'raw'`, `'pseudonymized'`, `'purged'`)
   - `telegram_user_id_hash text` (populated at Day 14)
   - `username_hash text` (populated at Day 14)
   - `retention_metadata jsonb` (optional: stores summary generation info)

9. **New tables:**
   - `excluded_users` (entity_id, telegram_user_id, opted_out_at) — permanent retention
   - `privacy_notices` (audit trail of when notices were sent)
   - `admin_audit_log` (track admin actions for compliance)

10. **Notification obligation:**
    - When group is linked (via `/auth`): post privacy notice to the group
    - When a new user joins (Telegram `chat_member` update): try DM first; fall back to short group notice
    - Privacy policy URL must be public and accessible

11. **"Not included" footnote:**
    - Aggregate count only: "3 group members have opted out and are not included in this answer."
    - No usernames or PII displayed

12. **Cron jobs (Vercel Cron or pg_cron):**
    - **Daily:** `summarizeAndPseudonymizeOldMessages()` — processes threads where messages are 14+ days old
    - **Daily:** `purgeOldMessages()` — processes messages 30+ days old (sets to 'purged', nulls text)
    - **Weekly:** `purgeProcessedUpdates()` — cleans old dedup rows

---

## 3. Schema Changes

### 3.1 Migration: PII Columns on `message_log`

```sql
-- Migration: 20260708000000_pii_retention_columns.sql

-- Add PII status and hash columns
alter table public.message_log
  add column if not exists pii_status text not null default 'raw'
    check (pii_status in ('raw', 'pseudonymized', 'purged'));

alter table public.message_log
  add column if not exists telegram_user_id_hash text;

alter table public.message_log
  add column if not exists username_hash text;

alter table public.message_log
  add column if not exists retention_metadata jsonb;

-- Index for cron jobs (find old messages by entity + thread)
create index if not exists idx_message_log_pii_status_created
  on public.message_log (pii_status, created_at)
  where pii_status in ('raw', 'pseudonymized');

-- Index for deletion requests (find messages by user)
create index if not exists idx_message_log_user_id
  on public.message_log (entity_id, telegram_user_id)
  where telegram_user_id is not null;

-- Index for hash-based lookup
create index if not exists idx_message_log_user_hash
  on public.message_log (entity_id, telegram_user_id_hash)
  where telegram_user_id_hash is not null;
```

### 3.2 Migration: Excluded Users Table (Raw ID, Permanent Retention)

```sql
-- Migration: 20260709000000_excluded_users.sql

create table if not exists public.excluded_users (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references public.entities(id) on delete cascade,
  telegram_user_id  text not null,
  opted_out_at      timestamptz not null default now(),
  unique (entity_id, telegram_user_id)
);

-- Index for fast lookup
create index idx_excluded_users_lookup on public.excluded_users (entity_id, telegram_user_id);

-- RLS (same as other tables)
alter table public.excluded_users enable row level security;
alter table public.excluded_users force row level security;

create policy excluded_user_isolation on public.excluded_users
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- Grant privileges to bot_service
grant select, insert, update, delete on public.excluded_users to bot_service;

-- Note: This table has PERMANENT retention. Opt-out must persist indefinitely.
-- No retention schedule applies to excluded_users.
```

### 3.3 Migration: Thread Summary Columns

```sql
-- Migration: 20260708020000_thread_summaries.sql

-- Add summary columns to threads
alter table public.threads
  add column if not exists summary text;

alter table public.threads
  add column if not exists summary_updated_at timestamptz;

alter table public.threads
  add column if not exists summary_generation_metadata jsonb; -- model, token counts, etc.
```

### 3.4 Migration: Privacy Notices Log

```sql
-- Migration: 20260708030000_privacy_notices.sql

-- Log when privacy notices are sent (for compliance audit)
create table if not exists public.privacy_notices (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references public.entities(id) on delete cascade,
  group_id        uuid references public.groups(id) on delete cascade,
  telegram_chat_id bigint not null,
  telegram_user_id bigint,  -- null = sent to group, not a specific user
  notice_type     text not null check (notice_type in ('group_link', 'user_join_dm', 'user_join_group', 'optout_confirmation')),
  sent_at         timestamptz not null default now(),
  metadata        jsonb
);

-- RLS
alter table public.privacy_notices enable row level security;
alter table public.privacy_notices force row level security;

create policy privacy_notices_isolation on public.privacy_notices
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

grant insert on public.privacy_notices to bot_service;
```

### 3.5 Migration: Admin Audit Log

```sql
-- Migration: 20260710000000_admin_audit_log.sql

create table if not exists public.admin_audit_log (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references public.entities(id) on delete cascade,
  profile_id      uuid references public.profiles(id) on delete set null,
  action          text not null,  -- 'doc_view', 'doc_edit', 'doc_create', 'manifest_add', 'manifest_remove', 'excluded_view'
  target_table    text not null,  -- 'doc_cache', 'manifest_entries', 'excluded_users', etc.
  target_id       text,           -- The ID of the affected row
  metadata        jsonb,          -- Changes made, before/after values
  ip_address      text,
  user_agent      text,
  created_at      timestamptz default now()
);

-- RLS: Entity admin can see their own entity's logs
alter table public.admin_audit_log enable row level security;
alter table public.admin_audit_log force row level security;

create policy admin_audit_log_policy on public.admin_audit_log
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

grant select, insert on public.admin_audit_log to bot_service;
```

---

## 4. HMAC Shared Module

**Promote `pepperedHmac` from `isolation.ts` to `lib/hmac.ts`:**

```typescript
// lib/hmac.ts
import { createHmac } from 'crypto';

/**
 * Shared peppered-HMAC primitive — the single place that reads APP_HMAC_PEPPER, applies
 * the algorithm, and joins the domain tag to the message with a fixed ':' separator.
 *
 * Fail-fast: throws if the pepper is unset. Never returns an unpeppered hash.
 *
 * Domain separation via `${domain}:${message}` is injective ONLY because `domain` values
 * are fixed internal constants that never contain a ':'. NEVER pass a user-controlled
 * string as `domain` (that would need length-prefixing to stay unambiguous); `message`
 * may be arbitrary, as it is the trailing field.
 */
export function pepperedHmac(domain: string, message: string): string {
  const pepper = process.env.APP_HMAC_PEPPER;
  if (!pepper) {
    throw new Error('APP_HMAC_PEPPER is not set; refusing to hash.');
  }
  return createHmac('sha256', pepper).update(`${domain}:${message}`).digest('hex');
}
```

**Update `isolation.ts` to import from `hmac.ts`:**

```typescript
// lib/isolation.ts
import { pepperedHmac } from './hmac';

export const ISOLATION_SCOPE_TYPE = 'group' as const;

export function resolveIsolationScopeId(groupId: string): string {
  if (!groupId) {
    throw new Error('resolveIsolationScopeId: groupId is required (isolation is group-scoped).');
  }
  return pepperedHmac('isolation-scope', groupId);
}
```

**PII hashing helpers (in `lib/pii.ts`):**

```typescript
// lib/pii.ts
import { pepperedHmac } from './hmac';

export function hashTelegramUserId(entityId: string, userId: string): string {
  return pepperedHmac('tg-user', `${entityId}:${userId}`);
}

export function hashUsername(entityId: string, username: string): string {
  return pepperedHmac('tg-username', `${entityId}:${username}`);
}
```

---

## 5. Core Functions (`lib/pii.ts`)

### 5.1 Check If User Is Excluded

```typescript
// lib/pii.ts
export async function isUserExcluded(
  entityId: string,
  telegramUserId: string
): Promise<boolean> {
  return await withTenantContext(entityId, async (tx) => {
    const result = await tx`
      SELECT 1 FROM excluded_users 
      WHERE entity_id = ${entityId} 
        AND telegram_user_id = ${telegramUserId}
    `;
    return result.length > 0;
  });
}
```

### 5.2 Log Message with Opt-Out Check

**Modify `logMessage` in `capabilities.ts`:**

```typescript
// In logMessage, before insert:
const isExcluded = await isUserExcluded(input.entityId, userIdStr);
if (isExcluded) {
  return; // Skip logging
}
```

### 5.3 Summarize Thread (Day 14)

```typescript
// lib/pii.ts
export async function summarizeAndPseudonymizeThread(
  entityId: string,
  threadId: string, // threads.id (UUID)
  telegramThreadId: bigint,
  messageIds: string[], // message_log.id (UUIDs)
  fullTranscript: string // chronological, with attribution
): Promise<void> {
  const model = getModelIdentifier();
  const provider = resolveProvider(model);
  const isolationScopeId = resolveIsolationScopeId(threadId);

  const systemPrompt = `You are summarizing a team chat conversation. 
Produce a concise, well-organized summary of the discussion below.
Focus on: key decisions, open questions, and action items.
Attribute points to participants by name (e.g., "Alice proposed X; Bob raised concern Y").
Keep it under 500 words.`;

  const result = await provider.callModel({
    systemPrompt,
    userMessage: `Summarize this conversation:\n\n${fullTranscript}`,
    model,
    cacheable: false,
    isolationScopeId,
  });

  // Store summary in threads table
  await withTenantContext(entityId, async (tx) => {
    await tx`
      UPDATE threads 
      SET 
        summary = ${result.text},
        summary_updated_at = now(),
        summary_generation_metadata = ${tx.json({
          model: result.model,
          token_usage: result.usage,
          message_count: messageIds.length,
        })}
      WHERE id = ${threadId}
    `;

    // Hash PII for all messages in this thread
    await tx`
      UPDATE message_log 
      SET 
        pii_status = 'pseudonymized',
        telegram_user_id_hash = hash_telegram_user_id(${entityId}, telegram_user_id),
        username_hash = hash_username(${entityId}, username),
        telegram_user_id = NULL,
        username = NULL,
        updated_at = now(),
        retention_metadata = jsonb_set(
          coalesce(retention_metadata, '{}'::jsonb),
          '{summarized_at}',
          to_jsonb(now())
        )
      WHERE id = ANY(${messageIds}::uuid[])
        AND pii_status = 'raw'
    `;
  });
}
```

### 5.4 Find Threads Ready for Summary (Cron)

```typescript
// lib/pii.ts
export async function findThreadsReadyForSummary(entityId: string): Promise<{
  threadId: string;
  telegramThreadId: bigint;
  messageIds: string[];
  fullTranscript: string;
}[]> {
  return await withTenantContext(entityId, async (tx) => {
    const rows = await tx`
      SELECT 
        t.id as thread_id,
        t.telegram_thread_id,
        array_agg(m.id) as message_ids,
        string_agg(
          CASE 
            WHEN m.username IS NOT NULL THEN m.username || ': ' || m.message_text
            WHEN m.telegram_user_id IS NOT NULL THEN 'User ' || m.telegram_user_id || ': ' || m.message_text
            ELSE 'User: ' || m.message_text
          END,
          '\n' ORDER BY m.created_at
        ) as full_transcript
      FROM message_log m
      JOIN threads t ON t.telegram_thread_id = m.telegram_thread_id
      WHERE m.pii_status = 'raw'
        AND m.created_at < now() - interval '14 days'
        AND m.telegram_thread_id IS NOT NULL
        AND m.entity_id = ${entityId}
        AND m.message_text IS NOT NULL
        AND m.is_bot_response = false
      GROUP BY t.id, t.telegram_thread_id
      HAVING count(m.id) >= 1
    `;

    return rows.map(row => ({
      threadId: row.thread_id,
      telegramThreadId: row.telegram_thread_id,
      messageIds: row.message_ids,
      fullTranscript: row.full_transcript,
    }));
  });
}
```

### 5.5 Purge Old Messages (Day 30)

```typescript
// lib/pii.ts
export async function purgeOldMessages(entityId: string): Promise<number> {
  return await withTenantContext(entityId, async (tx) => {
    const result = await tx`
      UPDATE message_log 
      SET 
        pii_status = 'purged',
        message_text = NULL,
        updated_at = now(),
        retention_metadata = jsonb_set(
          coalesce(retention_metadata, '{}'::jsonb),
          '{purged_at}',
          to_jsonb(now())
        )
      WHERE pii_status IN ('raw', 'pseudonymized')
        AND created_at < now() - interval '30 days'
    `;
    return result.count;
  });
}
```

### 5.6 Delete User Messages (Right to Erasure)

```typescript
// lib/pii.ts
export async function deleteUserMessages(
  entityId: string,
  telegramUserId: bigint | string
): Promise<{ deleted: number }> {
  const userIdStr = telegramUserId.toString();
  const hashedUserId = hashTelegramUserId(entityId, userIdStr);

  return await withTenantContext(entityId, async (tx) => {
    const result = await tx`
      DELETE FROM message_log 
      WHERE entity_id = ${entityId}
        AND (
          telegram_user_id = ${userIdStr}
          OR telegram_user_id_hash = ${hashedUserId}
        )
    `;
    return { deleted: result.count };
  });
}
```

### 5.7 Count Excluded Users (For Footnote)

```typescript
// lib/pii.ts
export async function getExcludedCount(entityId: string): Promise<number> {
  return await withTenantContext(entityId, async (tx) => {
    const result = await tx`
      SELECT COUNT(*) as count FROM excluded_users 
      WHERE entity_id = ${entityId}
    `;
    return Number(result[0]?.count || 0);
  });
}
```

---

## 6. `/optout` Toggle Command

**In `route.ts`, add to command dispatch:**

```typescript
// In route.ts, after other commands
const isOptOutCommand = text.startsWith('/optout');

if (isOptOutCommand) {
  if (!entityId) {
    await sendMessage(
      bot.telegram_bot_token,
      message.chat.id,
      `This group isn't linked to any entity yet. No data is being stored.`,
      { threadId, replyToMessageId: message.message_id }
    );
    return NextResponse.json({ ok: true });
  }

  const userIdStr = message.from.id.toString();

  // Check current status
  const isExcluded = await isUserExcluded(entityId, userIdStr);

  // Parse sub-command
  const parts = text.split(/\s+/);
  const subCommand = parts.length > 1 ? parts[1].toLowerCase() : null;

  if (isExcluded) {
    // Currently opted out
    if (subCommand === 'cancel') {
      // Opt back in
      await withTenantContext(entityId, async (tx) => {
        await tx`
          DELETE FROM excluded_users 
          WHERE entity_id = ${entityId} 
            AND telegram_user_id = ${userIdStr}
        `;
      });
      await sendMessage(
        bot.telegram_bot_token,
        message.chat.id,
        `✅ You have opted back in. Your messages will be logged again (starting now).\n\n` +
        `To opt out again, send <code>/optout confirm</code>.`,
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );
    } else {
      // Status check (or invalid subcommand)
      await sendMessage(
        bot.telegram_bot_token,
        message.chat.id,
        `ℹ️ You are currently <b>opted out</b>. Your messages are <b>not</b> being logged.\n\n` +
        `To opt back in, send <code>/optout cancel</code>.`,
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );
    }
  } else {
    // Currently opted in
    if (subCommand === 'confirm') {
      // Opt out
      await withTenantContext(entityId, async (tx) => {
        await tx`
          INSERT INTO excluded_users (entity_id, telegram_user_id)
          VALUES (${entityId}, ${userIdStr})
          ON CONFLICT (entity_id, telegram_user_id) DO NOTHING
        `;
      });

      // Log the opt-out confirmation (for audit)
      await withTenantContext(entityId, async (tx) => {
        await tx`
          INSERT INTO privacy_notices (entity_id, group_id, telegram_chat_id, telegram_user_id, notice_type)
          VALUES (${entityId}, ${group.id}, ${message.chat.id}, ${message.from.id}, 'optout_confirmation')
        `;
      });

      await sendMessage(
        bot.telegram_bot_token,
        message.chat.id,
        `✅ You have opted out. Your messages will <b>not</b> be logged going forward.\n\n` +
        `Existing messages remain subject to the retention policy (up to 30 days).\n` +
        `To opt back in, send <code>/optout cancel</code>.`,
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );
    } else {
      // Status check (or invalid subcommand)
      await sendMessage(
        bot.telegram_bot_token,
        message.chat.id,
        `ℹ️ You are currently <b>opted in</b>. Your messages are being logged.\n\n` +
        `To opt out, send <code>/optout confirm</code>.`,
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );
    }
  }

  return NextResponse.json({ ok: true, msg: 'Opt-out toggle processed' });
}
```

---

## 7. Privacy Notice: Group Link & User Add

### 7.1 On Group Link (`/auth` success)

**Add to the existing `/auth` success handler:**

```typescript
// After successful group linking
await sendMessage(
  bot.telegram_bot_token,
  message.chat.id,
  `✅ This group is now linked to <b>${displayName}</b>.\n\n` +
  `📋 <b>Privacy Notice</b>\n\n` +
  `This bot processes messages in this group to:\n` +
  `• Answer questions grounded in group context\n` +
  `• Provide recaps and summaries of discussions\n\n` +
  `<b>What data is processed:</b>\n` +
  `• Your messages, username, and Telegram user ID\n` +
  `• Messages are retained for up to 30 days, then deleted\n` +
  `• User IDs and usernames are hashed after 14 days\n\n` +
  `<b>Your choices:</b>\n` +
  `• Send <code>/optout</code> to check your current status\n` +
  `• Send <code>/optout confirm</code> to opt out\n` +
  `• Send <code>/optout cancel</code> to opt back in\n\n` +
  `<b>If you opt out:</b>\n` +
  `• Your messages will not be logged\n` +
  `• You will not be included in recaps or summaries\n` +
  `• You will not be able to ask the bot questions (your messages are invisible to the bot)\n\n` +
  `Full privacy policy: <a href="${process.env.NEXT_PUBLIC_APP_URL}/privacy">here</a>.\n` +
  `Terms of Service: <a href="${process.env.NEXT_PUBLIC_APP_URL}/terms">here</a>.`,
  { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
);

// Log the notice
await withTenantContext(entityId, async (tx) => {
  await tx`
    INSERT INTO privacy_notices (entity_id, group_id, telegram_chat_id, notice_type)
    VALUES (${entityId}, ${group.id}, ${message.chat.id}, 'group_link')
  `;
});
```

### 7.2 On User Join (`chat_member` update)

**In `route.ts`, after dedup but before command dispatch:**

```typescript
// Handle chat_member updates (user joins)
if (update.chat_member) {
  const { chat, new_chat_member } = update.chat_member;
  const userId = new_chat_member.user.id;
  const status = new_chat_member.status;

  if (status === 'member' || status === 'administrator' || status === 'creator') {
    const entityId = await resolveEntityIdByChat(chat.id);
    if (entityId) {
      // Try DM first
      try {
        await sendMessage(
          bot.telegram_bot_token,
          userId,
          `👋 Welcome to ${chat.title || 'this group'}! This group uses an AI assistant bot.\n\n` +
          `📋 <b>Privacy Notice:</b> Your messages may be processed to answer questions. ` +
          `You can opt out at any time by sending <code>/optout</code> in the group.\n\n` +
          `Privacy policy: <a href="${process.env.NEXT_PUBLIC_APP_URL}/privacy">here</a>.`,
          { parseMode: 'HTML' }
        );

        // Log the DM notice
        await withTenantContext(entityId, async (tx) => {
          await tx`
            INSERT INTO privacy_notices (entity_id, telegram_chat_id, telegram_user_id, notice_type)
            VALUES (${entityId}, ${chat.id}, ${userId}, 'user_join_dm')
          `;
        });
      } catch (err) {
        // DM failed — fall back to short group notice
        await sendMessage(
          bot.telegram_bot_token,
          chat.id,
          `👋 Welcome to the group! This bot processes messages to answer questions. ` +
          `To opt out, send <code>/optout</code>. Privacy policy: <a href="${process.env.NEXT_PUBLIC_APP_URL}/privacy">here</a>.`,
          { parseMode: 'HTML' }
        );

        // Log the group notice
        await withTenantContext(entityId, async (tx) => {
          await tx`
            INSERT INTO privacy_notices (entity_id, telegram_chat_id, telegram_user_id, notice_type)
            VALUES (${entityId}, ${chat.id}, ${userId}, 'user_join_group')
          `;
        });
      }
    }
  }
  return NextResponse.json({ ok: true });
}
```

---

## 8. Entity Admin View of Opted-Out Users

### 8.1 Management API Endpoint

```typescript
// app/api/manage/entity/[entityId]/excluded-users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export async function GET(
  req: NextRequest,
  { params }: { params: { entityId: string } }
) {
  const supabase = createRouteHandlerClient({ cookies });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // RLS enforces that user has access to this entity (via authorizations table)
  const { data, error } = await supabase
    .from('excluded_users')
    .select(`
      telegram_user_id,
      opted_out_at,
      users!inner (
        username,
        display_name
      )
    `)
    .eq('entity_id', params.entityId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Log the audit trail
  await supabase
    .from('admin_audit_log')
    .insert({
      entity_id: params.entityId,
      profile_id: user.id,
      action: 'excluded_view',
      target_table: 'excluded_users',
      metadata: { viewed_at: new Date().toISOString() }
    });

  return NextResponse.json({ excluded: data });
}
```

### 8.2 UI Display

The Entity Admin sees a table showing:
- Telegram username (from `users` table join)
- Opted-out date
- Option to remove the opt-out (admin override) — this would delete the row from `excluded_users`

**Admin override note:** This should be logged in `admin_audit_log` and should require confirmation (to prevent accidental re-enrollment).

---

## 9. `buildContext` — Include Thread Summary

**Modify `buildContext` in `capabilities.ts`:**

```typescript
// In buildContext, after fetching docs:
// If there's a thread summary, include it
const threadSummary = await tx`
  SELECT summary FROM threads 
  WHERE entity_id = ${entityId}
    AND group_id = ${groupId}
    AND telegram_thread_id = ${threadIdStr}::bigint
    AND summary IS NOT NULL
`;

let summaryBlock = '';
if (threadSummary.length > 0 && threadSummary[0].summary) {
  summaryBlock = `\n\n<thread_summary>\n${threadSummary[0].summary}\n</thread_summary>`;
}

const contextDocs = docs
  .map((doc) => `<document path="${doc.display_name}">\n${doc.content}\n</document>`)
  .join('\n\n') + summaryBlock;
```

**Why:** This gives the bot long-term memory of past conversations without retaining raw PII. The summary is non-PII (aggregate).

---

## 10. Cron Jobs

### 10.1 Vercel Cron (Recommended for serverless)

```typescript
// app/api/cron/retention/route.ts
import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  // Verify cron secret (prevent public access)
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Get all entities
  const entities = await sql<{ id: string }[]>`
    SELECT id FROM entities
  `;

  for (const entity of entities) {
    try {
      // Step 1: Summarize threads (Day 14)
      const threads = await findThreadsReadyForSummary(entity.id);
      for (const thread of threads) {
        await summarizeAndPseudonymizeThread(
          entity.id,
          thread.threadId,
          thread.telegramThreadId,
          thread.messageIds,
          thread.fullTranscript
        );
      }

      // Step 2: Purge old messages (Day 30)
      const purged = await purgeOldMessages(entity.id);
      if (purged > 0) {
        console.log(`Purged ${purged} old messages for entity ${entity.id}`);
      }

      // Step 3: Purge old processed_updates (optional)
      await cleanupProcessedUpdates(entity.id);
    } catch (err) {
      console.error(`Retention cron failed for entity ${entity.id}:`, err);
    }
  }

  return NextResponse.json({ ok: true });
}
```

### 10.2 Vercel Cron Configuration

In `vercel.json` or `cron.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/retention",
      "schedule": "0 0 * * *"
    }
  ]
}
```

---

## 11. Audit Logging (Compliance)

### 11.1 Application-Level Audit Log

Track Entity Admin actions via the management UI:

| Action | Target Table | Trigger |
|--------|--------------|---------|
| `doc_view` | `doc_cache` | Admin views a document |
| `doc_edit` | `doc_cache` | Admin edits a document |
| `doc_create` | `doc_cache` | Admin creates a new document |
| `manifest_add` | `manifest_entries` | Admin adds a manifest entry |
| `manifest_remove` | `manifest_entries` | Admin removes a manifest entry |
| `excluded_view` | `excluded_users` | Admin views excluded users list |

**Implementation pattern (in management API routes):**

```typescript
// After the action, insert audit log
await supabase
  .from('admin_audit_log')
  .insert({
    entity_id: params.entityId,
    profile_id: user.id,
    action: 'doc_edit',
    target_table: 'doc_cache',
    target_id: docId,
    metadata: {
      before: { content: oldContent },
      after: { content: newContent }
    },
    ip_address: req.headers.get('x-forwarded-for') || req.ip,
    user_agent: req.headers.get('user-agent'),
  });
```

### 11.2 Postgres Logging (pgAudit)

For the `bot_service` role, enable pgAudit:

```sql
ALTER ROLE bot_service SET pgaudit.log = 'ddl, write';
```

This logs:
- DDL operations (schema changes)
- Data-modifying operations (INSERT, UPDATE, DELETE) on sensitive tables

**Limitation:** `pgaudit.log_parameter` is restricted in hosted Supabase to avoid logging encrypted Vault secrets in plaintext.

### 11.3 Connection Logging

Enable connection logging to track who connects to the database:

```sql
ALTER SYSTEM SET log_connections = 'on';
```

### 11.4 Audit Logging Summary

| Who | What | How to Track |
|-----|------|--------------|
| **Bot service (routine)** | Read/write messages, generate answers | Not logged per-query; legal basis covers processing |
| **Entity Admin (web UI)** | View/edit docs, manage manifest, view excluded | Application audit log (`admin_audit_log`) |
| **Entity Admin (SQL Editor)** | Direct SQL queries | Postgres logs + pgAudit |
| **Platform Operator** | Any database access | Internal access controls + pgAudit + connection logging |
| **Entity Admin (dashboard)** | Project management actions | Platform Audit Logs |

---

## 12. Environment Variables

```env
# .env.example

# HMAC pepper for isolation scope IDs and PII hashing
# REQUIRED: app fails fast if unset
APP_HMAC_PEPPER=your_very_secure_random_hex_32_bytes

# Cron secret for retention endpoint
CRON_SECRET=your_cron_secret_token

# App URL for privacy policy links
NEXT_PUBLIC_APP_URL=https://app.leguan.ai
```

---

## 13. Tests

1. **`/optout` status check.** Send `/optout` as a new user; assert "You are currently opted in." Send `/optout confirm`; assert opt-out confirmation. Send `/optout` again; assert "You are currently opted out." Send `/optout cancel`; assert opt-in confirmation.

2. **`/optout` prevents logging.** After opt-out, send a message; assert no row inserted in `message_log` for that user.

3. **`/optout` admin view.** Entity Admin views excluded users; assert the opted-out user appears in the list.

4. **Day 14 summary generation.** Mock a thread with messages 14+ days old; assert summary is generated and stored; assert PII fields are hashed (`telegram_user_id` and `username` set to NULL, hashes populated).

5. **Day 30 purge.** Mock messages 30+ days old; assert `pii_status = 'purged'` and `message_text = NULL`.

6. **Deletion request.** Call `deleteUserMessages`; assert all rows for that user are deleted (including by hash lookup).

7. **Privacy notice logging.** On group link, assert `privacy_notices` row is inserted. On user join, assert notice is logged (DM or group fallback).

8. **BuildContext includes summary.** After summary generation, assert the summary appears in the context block.

9. **"Not included" footnote.** After opt-out, ask a question; assert the response includes "X group members have opted out and are not included."

10. **Audit logging.** Entity Admin views excluded users; assert `admin_audit_log` row is inserted with correct action and metadata.

---

## 14. Non-Goals & Future Hooks

1. **Anonymizing summaries on deletion request.** Deferred: summaries are non-PII (aggregate). If it becomes a requirement, we could store `summary_mentioned_users` as a jsonb array and anonymize on request — but this is a future enhancement.

2. **Full-text search over message history.** Not building this yet; summaries are the long-term memory, not raw messages.

3. **User-controlled retention period.** Deferred: default is 30 days; per-entity config could be added later.

4. **`/deletemydata` self-service command.** Deferred: for now, users contact admins. Could implement in the future.

5. **Per-user retention exemptions.** Deferred: some users may want longer retention for audit purposes.

---

## 15. Handoff Notes

### New Files
- `lib/hmac.ts` — promoted from isolation (shared HMAC primitive)
- `lib/pii.ts` — PII-related functions (excluded check, summary generation, purge, deletion)
- `app/api/cron/retention/route.ts` — retention cron job
- `app/api/manage/entity/[entityId]/excluded-users/route.ts` — Entity Admin view of excluded users

### Modified Files
- `lib/isolation.ts` — import from `hmac.ts`
- `lib/capabilities.ts` — `logMessage` opt-out check, `buildContext` summary inclusion, `answerQuestion` footnote
- `app/api/webhooks/platform/[botSlug]/route.ts` — `/optout` toggle command, privacy notice on group link, `chat_member` handler

### New Migrations
1. `20260708000000_pii_retention_columns.sql`
2. `20260709000000_excluded_users.sql`
3. `20260708020000_thread_summaries.sql`
4. `20260708030000_privacy_notices.sql`
5. `20260710000000_admin_audit_log.sql`

### Pre-requisites
- `APP_HMAC_PEPPER` must be set in environment (already required for isolation)
- `CRON_SECRET` must be set for cron endpoint
- `NEXT_PUBLIC_APP_URL` must be set for privacy policy links

### Deployment Order
1. Deploy schema migrations (additive only, no destructive changes)
2. Deploy code changes (new files + modified files)
3. Set environment variables
4. Enable cron job (Vercel Cron or custom scheduler)
5. Deploy privacy policy page (`/privacy`) and terms of service (`/terms`)

---

*End of SPEC — PII Data Minimization & Retention*