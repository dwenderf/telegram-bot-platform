# SPEC: `/whoami` command (for Antigravity)

> **Status:** ready to implement.
> **Goal:** a lightweight diagnostic command that echoes back the Telegram identifiers from the incoming update — chat id, topic/thread id, user id, username — plus the resolved entity slug + group name when the chat is registered (or "unregistered" when it isn't).
> **Primary value:** removes the manual log-diving step from onboarding. Instead of "send a message → read the Vercel 'untracked chat ID' log → copy the chat id," an operator runs `/whoami` in the group and reads the ids straight from the bot's reply — and it works **even in a group not yet in the database** (the onboarding case).

---

## The one critical design point: handle `/whoami` BEFORE tenant/group resolution

The existing handler resolves the tenant (by slug) and the group (by chat id), and **bails early** when the group isn't registered (the "untracked chat ID" path). `/whoami` must be answered **before that bail-out**, because its whole purpose includes the unregistered-group case (onboarding). So:

- `/whoami` is dispatched on the **raw incoming update** — it does not require a resolved group.
- It echoes the raw ids unconditionally.
- It **attempts** entity + group resolution and includes the results **when available**, but shows `unregistered` (rather than failing) when they're not.

Concretely: the `/whoami` branch sits **after** the webhook-secret auth check (we still want auth — only the real bot's webhook should reach this) and **after** the entity-by-slug resolution (the slug comes from the URL path, so the entity is usually known even for an unregistered *group*), but **before** the "group not found → log untracked chat id and return" bail-out.

> Note on what's resolvable when:
> - **Entity** is resolved from the **URL slug** (`/api/webhooks/telegram/{slug}`), so it's known as long as the slug maps to an entity — even if *this group* isn't registered. If the slug itself is unknown, entity shows `unregistered`.
> - **Group** is resolved from the incoming **chat id**; for a brand-new group it won't be found → show `unregistered` (this is the expected onboarding state, and the chat id echoed is exactly what you need to register it).

---

## Change 1 — Telegram intent detection + dispatch (in `route.ts`)

### 1a. Intent flag
Alongside the existing `isAskCommand` / `isHelpCommand` / `isContextCommand`:
```typescript
const isWhoamiCommand = text.startsWith('/whoami');
```
And include it in the command-logging branch (so it's logged with `is_command = true`), same as the others.

### 1b. Dispatch — placed BEFORE the untracked-group bail-out
This is the key placement. In the current flow, after entity resolution and the auth check, there's a point where the group is looked up by chat id and, if not found, the handler logs "untracked chat ID" and returns. The `/whoami` handler must run **before** that return.

```typescript
// Respond to /whoami — echo the raw Telegram ids + resolved entity/group when known.
// MUST run before the untracked-group bail-out so it works during onboarding
// (a group not yet in the DB is exactly when you need this).
if (isWhoamiCommand) {
  const chatId = message.chat.id;
  const threadId = message.message_thread_id ?? null; // null = General topic
  const fromId = message.from?.id ?? null;
  const fromUsername = message.from?.username ?? null;

  // entity may be resolved (from the URL slug) even if this group isn't registered.
  const entityLabel = entity?.slug ?? 'unregistered';
  // group may be null for a brand-new (untracked) group — that's expected here.
  const groupLabel = group?.display_name ?? 'unregistered';

  const lines = [
    '<b>🪪 whoami</b>',
    '',
    `<b>Chat ID:</b> <code>${chatId}</code>`,
    `<b>Topic (thread) ID:</b> ${threadId === null ? '<i>General (none)</i>' : `<code>${threadId}</code>`}`,
    `<b>Your user ID:</b> ${fromId === null ? '<i>unknown</i>' : `<code>${fromId}</code>`}`,
    `<b>Your username:</b> ${fromUsername ? `@${escapeHtmlWhoami(fromUsername)}` : '<i>none set</i>'}`,
    '',
    `<b>Entity:</b> ${escapeHtmlWhoami(entityLabel)}`,
    `<b>Group:</b> ${escapeHtmlWhoami(groupLabel)}`,
  ];

  await sendMessage(
    entity?.telegram_bot_token ?? /* see note below */ botTokenForReply,
    chatId,
    lines.join('\n'),
    { threadId, replyToMessageId: message.message_id, parseMode: 'HTML' }
  );

  return NextResponse.json({ ok: true, msg: 'whoami sent' });
}
```

> **Bot-token-for-reply caveat (important):** `sendMessage` needs the bot token. Normally that's `entity.telegram_bot_token` — available once the entity is resolved from the slug (the common case, even for an unregistered group). **But** if the *slug itself* is unknown (no entity), there's no Vault-stored token to load. In that rare case `/whoami` can't reply (the bot doesn't know which token to use). Handle gracefully:
> - If `entity` is resolved → use `entity.telegram_bot_token` (the normal path; works for unregistered *groups* under a known entity — the main onboarding case).
> - If `entity` is **not** resolved (unknown slug) → just `return NextResponse.json({ ok: true })` without replying (can't send without a token). This is an edge case that shouldn't happen in practice, since the webhook URL always carries a real slug. Do **not** crash.
>
> Implementer: confirm where `entity.telegram_bot_token` becomes available in the current flow relative to this dispatch point, and place the `/whoami` block just after the entity (token) is available but before the group bail-out. If the token decrypt happens *after* the group check today, move the `/whoami` handling to right after the token is available — the ordering requirement is: **token available, group lookup attempted (may be null), THEN whoami responds.**

### 1c. Small HTML-escape helper
The username is user-controlled, so escape it (chat/user/thread ids are numeric and safe, but escaping the username is correct hygiene). If a shared escape helper already exists in `route.ts`, reuse it; otherwise:
```typescript
function escapeHtmlWhoami(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```
(Named distinctly to avoid colliding with any prior helper; rename/merge as appropriate.)

---

## Change 2 — Add `/whoami` to `/help` text

It's a public command, so list it in the `/help` output alongside `/ask`, `/context`:
```typescript
`• Use <code>/whoami</code> to show this chat's ids (useful for setup/diagnostics).\n` +
```

---

## Change 3 — Register `/whoami` in the command menu (`setMyCommands`)

`/whoami` is fully public, so add it to the registered command set. Update the B7 `setMyCommands` call (DEPLOYMENT.md) and re-run it for existing bots:
```json
{"commands":[
  {"command":"ask","description":"Ask a question grounded in the team docs"},
  {"command":"context","description":"See what docs the bot answers from here"},
  {"command":"whoami","description":"Show this chat's ids (setup/diagnostics)"},
  {"command":"help","description":"Show what the bot can do"}
]}
```
> Telegram orders the `/` menu as given, but clients often present them alphabetically; either way `whoami` naturally sorts last. (Re-running `setMyCommands` is required for the new command to appear in the menu — see DEPLOYMENT B7.)

---

## Example output

**In a registered group, in a named topic:**
```
🪪 whoami

Chat ID: -1001234567890
Topic (thread) ID: 42
Your user ID: 8675309
Your username: @davidwender

Entity: hys
Group: HYS Internal
```

**In an unregistered group (onboarding), General topic:**
```
🪪 whoami

Chat ID: -1009988776655
Topic (thread) ID: General (none)
Your user ID: 8675309
Your username: @davidwender

Entity: hys
Group: unregistered
```
(The `Chat ID` here is exactly what you copy into the B4 `groups` insert — no log-diving.)

---

## Test plan

1. **Registered group, named topic** → all ids populated; Entity = slug, Group = display name; reply lands in-thread.
2. **Registered group, General topic** → Topic shows `General (none)` (null thread handled); reply lands in General.
3. **UNREGISTERED group (the key case)** → Entity = slug (resolved from URL), Group = `unregistered`; the echoed Chat ID matches what the "untracked chat ID" log would have shown. **This is the onboarding win — verify the chat id is correct and usable for the B4 insert.**
4. **User with no username set** → `Your username: none set` (no crash on null `from.username`).
5. **Logged as command** → `/whoami` produces a `message_log` row with `is_command = true`.
6. **Menu** → after re-running `setMyCommands`, `/whoami` appears in the `/` autocomplete.
7. **Does NOT leak across the bail-out** → confirm `/whoami` still answers in an unregistered group (i.e. it's dispatched before the untracked-chat return), AND that a *non-whoami* message in an unregistered group still hits the normal untracked-chat log path (we didn't accidentally swallow it).

---

## What this deliberately does NOT do
- **No system-health diagnostics** (webhook status, Vault secret health, privacy-mode check, model id). Those are a separate, operator-facing concern (`checkVaultSecretsHealth` route, PLANNING §9) — keeping `/whoami` to *just the ids* avoids scope creep and keeps it safe to expose publicly.
- **No write/side effects** — pure read/echo. It does not register the group or change anything; it just reports.
- **No auth/permission gating beyond the existing webhook-secret check** — the ids it reports (chat id, the caller's own user id/username) are not sensitive (Telegram shows them to every member), so any member may run it. (It does NOT report *other* users' ids — only the caller's, from `message.from`.)
