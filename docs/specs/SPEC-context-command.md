# SPEC: `/context` command (for Antigravity)

> **Status:** ready to implement. Reviewed design; hand to Antigravity.
> **Goal:** add a `/context` slash command that shows what the bot answers from in the current entity + topic. It sends (1) a short inline summary message listing which docs load, then (2) the full context as an attached markdown file (Entity / Group / Topic sections).
> **Why this shape:** the summary gives a quick inline glance; the file always delivers the full content without hitting Telegram's ~4096-char message limit. One command, two sends.
> **Discipline:** `/context` must reuse the *same* manifest+cache resolution as `buildContext`, so it shows exactly what `/ask` would use (they can't drift). Do NOT change `buildContext` or `answerQuestion` — add a new read-only capability alongside them.

---

## Change 1 — New capability: `getContextManifest` in `lib/capabilities.ts`

Add a new exported function. It runs the **same** manifest+cache join `buildContext` uses, but returns structured data (not a model-bound string) so the handler can format both a summary and a document.

```typescript
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
        and (m.telegram_thread_id is null or m.telegram_thread_id = ${threadIdStr})
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
```

**Notes for the implementer:**
- This is deliberately a separate function from `buildContext`, not a refactor of it — keeps `/ask`'s hot path untouched and the risk contained. The duplicated query is acceptable; if you prefer, you may extract the shared SELECT into a private helper that both call, but only if it does not change `buildContext`'s behavior or return shape.
- `group_id` is intentionally ignored in v1 (same as `buildContext`). The note in the docstring is important — flag it so the future group-scoping change updates both.

---

## Change 2 — New Telegram helper: `sendDocument` in `lib/telegram.ts`

The existing `callTelegramApi` sends JSON. Telegram's `sendDocument` requires **`multipart/form-data`** (file upload), so it needs its own fetch using `FormData` + `Blob`. Add this exported function:

```typescript
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
```

**Notes for the implementer:**
- **Do not set a `Content-Type` header manually** — `fetch` must set the `multipart/form-data; boundary=...` header itself. Setting it by hand breaks the upload.
- `Blob` and `FormData` are available in the Vercel/Next.js (Node 18+/edge-compatible) runtime. If the project's runtime complains, the fallback is the `form-data` npm package, but try the native path first.
- `caption` is optional and limited to ~1024 chars by Telegram — we use it for a tiny label only, not the content. The content goes in the file body (no length limit that matters here).

---

## Change 3 — Dispatch `/context` in the Telegram handler

In `app/api/webhooks/telegram/[entitySlug]/route.ts`:

### 3a. Import the new capability + helper
```typescript
import {
  resolveTenant,
  resolveUser,
  answerQuestion,
  logMessage,
  getContextManifest,   // ADD
} from '@/lib/capabilities';
import {
  setMessageReaction,
  sendChatAction,
  sendMessage,
  sendDocument,         // ADD
  sanitizeForTelegramHtml,
} from '@/lib/telegram';
```

### 3b. Add intent detection (alongside the existing `isAskCommand` / `isHelpCommand`)
```typescript
const isContextCommand = text.startsWith('/context');
```
And in the intent if/else chain (where `isHelpCommand` / `isAskCommand` set `isCommand = true`), add a branch so it's logged as a command:
```typescript
} else if (isContextCommand) {
  isCommand = true;
}
```
(Place this before the `isAskCommand` branch is fine, or after — just ensure `/context` is matched and not mistaken for `/ask`. Since `startsWith('/ask')` and `startsWith('/context')` are disjoint, order doesn't matter, but keep it readable.)

### 3c. Add the handler block (mirror the `/help` block — no model call, uses `waitUntil` for the sends)
Place this **after** the `/help` block and **before** the `/ask || mention` block:

```typescript
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
```

### 3d. Two small helpers (top of the route file, module scope)

```typescript
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
```

**Note on the document being markdown, not HTML:** the file body is plain markdown (`.md`) — it is NOT sent through `sanitizeForTelegramHtml` and NOT parsed by Telegram (it's an uploaded file, not a message). So the doc content goes in raw/as-cached. Only the *inline summary message* uses Telegram HTML (and escapes doc_paths via `escapeHtml`).

---

## Change 4 — Update `/help` text to mention `/context`

In the `/help` block, add a line:
```typescript
`• Use <code>/context</code> to see what documentation I'm answering from in this topic.\n` +
```

---

## Change 5 — Register the command menu (optional, recommended)

Run once (or fold into a future onboarding step) via the Bot API so `/context` appears in the `/` menu alongside `/ask` and `/help`:
```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"ask","description":"Ask a question grounded in the team docs"},
    {"command":"context","description":"See what docs the bot answers from here"},
    {"command":"help","description":"Show what the bot can do"}
  ]}'
```
(This also resolves the `setMyCommands` BACKLOG item.)

---

## Test plan (have Antigravity verify after implementing)

1. **`/context` in a topic with entity-general content only** → inline summary lists the entity doc(s), Group = none, Topic = none, "Answering from N documents"; followed by a `context.md` file with the Entity section populated and Group/Topic showing the "none/not enabled" notes.
2. **`/context` in a topic that has a topic-specific manifest entry** → Topic section lists that doc inline and includes its content in the file.
3. **`/context` in a topic with NO matching docs at all** → summary shows all "none", "Answering from 0 documents", and **no file is sent** (the `if (totalDocs > 0)` guard).
4. **Large content (>4096 chars)** → confirms the file delivery works where an inline message would have failed (this is the whole point of the file).
5. **`/context` matches correctly** → does not trigger `/ask` (disjoint prefixes), and is logged as a command in `message_log` (`is_command = true`).
6. **Confirm `/context` shows the SAME docs `/ask` uses** → ask a question whose answer is in a doc, then `/context` — the doc that grounded the answer appears in the context listing.

---

## What this deliberately does NOT do (kept simple, per "don't build ahead of need")
- **No group-layer scoping** — matches `buildContext` (v1). The summary/file label the Group section as "not enabled" so it's honest, and the seam is obvious for when group-scoped resolution lands.
- **No recent-conversation display** — `/context` is about *documentation* context (what's stable/configured), not the live message history. (Could be added later, but the docs are the useful, stable thing to surface.)
- **No editing** — read-only. Editing is the web-app/management-plane job (MANAGEMENT-PROPOSAL.md).
