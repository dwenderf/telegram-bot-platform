# SPEC: `/recap` command (for Antigravity)

> **Status:** ready AFTER the message-history storage spec (`SPEC-message-history-storage.md`) is implemented. `/recap` reads the conversation log, which is only complete once bot responses are stored.
> **Goal:** `/recap [N]` summarizes the last **N** messages **in the current topic/thread**. It's a model call (like `/ask`), so it uses the same 👀-reaction → typing → async-generate → reply pattern.

---

## Behavior

- **`/recap`** (no argument) → recap the last **DEFAULT_RECAP (20)** messages in this thread.
- **`/recap 50`** → recap the last 50, if ≤ **MAX_RECAP (100)**.
- **`/recap 500`** (over the cap) → **clamp to MAX_RECAP** and recap the last 100; note it in the reply ("Recapping the last 100 messages (max).").
- **`/recap abc` / `/recap -5` / `/recap 0` / `/recap 3.7`** → not a usable positive integer → fall back to DEFAULT_RECAP, with a gentle note ("Didn't catch a number, recapping the last 20.").

**Scope: current topic/thread only.** The recap covers messages where `telegram_thread_id is not distinct from <this thread>` within this group — matching the bot's per-topic model (same filter `buildContext` uses). A recap in the General topic recaps General; a recap in a topic recaps that topic. No cross-topic mixing.

**Constants** (define near the handler or in a small config):
```typescript
const DEFAULT_RECAP = 20;
const MAX_RECAP = 100;
```

---

## Argument parsing

```typescript
// text is the trimmed message, e.g. "/recap 50" or "/recap@kenntnis_hys_bot 30"
// Strip the command (and optional @botname suffix), then parse the remainder.
const recapArg = text.replace(/^\/recap(?:@[a-zA-Z0-9_]+)?\s*/i, '').trim();

let requested = parseInt(recapArg, 10);
let note = '';                 // optional user-facing note about clamping/fallback

if (!Number.isInteger(requested) || requested <= 0) {
  requested = DEFAULT_RECAP;
  if (recapArg.length > 0) {
    note = `Didn't catch a number, recapping the last ${DEFAULT_RECAP}.`;
  }
} else if (requested > MAX_RECAP) {
  requested = MAX_RECAP;
  note = `Recapping the last ${MAX_RECAP} messages (max).`;
}
```

(`parseInt('3.7')` → 3, which is a fine positive integer → recap 3; that's acceptable. `parseInt('abc')` → NaN → fallback. `parseInt('-5')` → -5 → ≤ 0 → fallback. Good enough; no need to over-validate.)

---

## Handler placement & flow (in `route.ts`)

`/recap` is a **model-calling command**, so it belongs with `/ask` — AFTER the untracked-group bail-out (unlike `/whoami`, a recap of an unregistered group is meaningless: there's no logged history). Add an intent flag alongside the others:

```typescript
const isRecapCommand = text.startsWith('/recap');
```
…and include it in the `isCommand` branch (so the `/recap` invocation itself is logged as a command, consistent with `/ask`).

Then, in the same region as the `/ask` handler (after group is resolved + message logged), add the dispatch. It mirrors `/ask`'s structure: react 👀, send typing, then `waitUntil` an async block that builds the recap and replies.

```typescript
// Respond to /recap — summarize the last N messages in this thread (model call).
if (isRecapCommand) {
  // 1. Immediate ack (same as /ask): 👀 + typing
  try {
    await setMessageReaction(entity.telegram_bot_token, message.chat.id, message.message_id, '👀');
  } catch (err) { console.error('Failed to set eyes reaction:', err); }
  try {
    await sendChatAction(entity.telegram_bot_token, message.chat.id, 'typing', threadId);
  } catch (err) { console.error('Failed to send typing action:', err); }

  // 2. Slow part async
  waitUntil((async () => {
    try {
      const { recapText } = await recapConversation({
        entityId: entity.id,
        groupId: group.id,
        threadId,
        limit: requested,           // already clamped/defaulted above
      });

      const prefix = note ? `<i>${escapeHtml(note)}</i>\n\n` : '';
      const sanitized = sanitizeForTelegramHtml(recapText);

      await sendMessage(
        entity.telegram_bot_token, message.chat.id, prefix + sanitized,
        { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
      );

      // Phase 1 storage: a recap IS a bot response → log it (so the log stays complete).
      try {
        await logBotResponse({
          entityId: entity.id, groupId: group.id,
          telegramChatId: message.chat.id, telegramThreadId: threadId,
          botUsername: entity.telegram_bot_username,
          messageText: recapText,
          summary: null,
          generationMetadata: { model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', thread_id: threadId, kind: 'recap', recap_limit: requested },
        });
      } catch (err) { console.error('Failed to log recap response:', err); }

    } catch (err) {
      console.error('Error handling /recap:', err);
      try {
        await sendMessage(
          entity.telegram_bot_token, message.chat.id,
          `⚠️ <i>Sorry, couldn't build a recap right now.</i>`,
          { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
        );
      } catch (sendErr) { console.error('Failed to send /recap error fallback:', sendErr); }
    }
  })());

  return NextResponse.json({ ok: true, msg: 'Recap processing' });
}
```

> Note the recap is itself logged via `logBotResponse` with `kind: 'recap'` in metadata — so the log stays complete, and a later recap won't be confused by it (it reads as the bot summarizing, which is accurate). If experience shows recaps shouldn't feed back into future recaps, we can filter `generation_metadata->>'kind' = 'recap'` out of the recap query later — but don't pre-build that; note it and move on.

---

## Change — `recapConversation(...)` in `lib/capabilities.ts`

A sibling of `answerQuestion`. It pulls the last N messages in the thread (using `coalesce(summary, message_text)` so a long bot answer contributes its stored summary once Phase 2 exists — today summary is null, so it's just `message_text`), formats them, and asks the model for a concise recap.

```typescript
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
```

**Notes:**
- **`coalesce(summary, message_text)`** is the forward-compatible read: harmless today (summary null), and automatically uses summaries once Phase 2 fills them — keeping recap input bounded for long answers.
- **`message_text is not null`** guard skips any odd null-text rows.
- **Empty-thread case** returns a friendly message rather than calling the model on nothing.
- The recap input is bounded by `limit` (≤ MAX_RECAP) — that's the cost/latency control.

---

## Change — add `/recap` to `lib/commands.ts` and `/help`

`/recap` is public, so add it to the shared command list (which the sync script and any future menu use):
```typescript
{ command: 'recap', description: 'Summarize the last messages in this topic' },
```
(Order it sensibly — e.g. after `context`, before `whoami`, or wherever reads well; clients often alphabetize anyway.)

And add a line to the `/help` text:
```typescript
`• Use <code>/recap [N]</code> to summarize the last N messages here (default 20).\n` +
```

After shipping, re-run the sync script (`scripts/sync-commands.ts`) to push the updated menu to all bots.

---

## Test plan
1. **`/recap`** in a thread with history → 👀, typing, then an HTML recap of the last 20 (or fewer if <20 exist). The recap itself appears as an `is_bot_response` row afterward.
2. **`/recap 5`** → recaps last 5.
3. **`/recap 999`** → clamps to 100, reply notes "(max)".
4. **`/recap banana`** → recaps default 20, reply notes "didn't catch a number".
5. **Thread scoping** → a recap in topic A does not include messages from topic B or General.
6. **Empty thread** → "no recent messages to recap yet" (no model call needed, or a clean short reply).
7. **Now includes bot answers** → after an `/ask` then `/recap`, the recap reflects BOTH the question and the bot's answer (proves Phase-1 storage is feeding recap).
8. **Error isolation** → if the model call fails, the ⚠️ fallback sends; no crash.
9. **Menu** → after re-running sync-commands, `/recap` appears in the `/` menu.

---

## What this does NOT do
- **No cross-topic / whole-group recap** (decided: topic-scoped). A `group` scope could be a future `/recap group` argument; not now.
- **No date/time ranges** ("recap today"). N-messages only for v1; ranges are a possible later refinement.
- **No summary persistence of the recap's *inputs*** — `/recap` consumes summaries if present (Phase 2) but doesn't generate per-message summaries itself; that's Phase 2's job on bot responses.
