# SPEC: Privacy transparency notices — first-add announcement + on-join notice (for Antigravity)

> **Status:** ready to implement.
> **Goal:** make group members aware, in-chat, that the bot is present and logs/processes messages, with a link to the privacy policy — via two permission-free touchpoints:
> 1. a **first-add announcement** when the bot is added to a group (reaches everyone already in the group), and
> 2. an **on-join notice** when a new member joins (reaches people we'll never onboard).
> A third, durable backstop — the bot's **BotFather profile fields** (Privacy Policy / About / Description) — is documented here but set manually (no code).
>
> **Non-goals / hard constraints (decided in planning):** NO `restrictChatMember`, NO `banChatMember`, NO consent gate, NO requirement that the bot be a group admin. These notices are **transparency** (GDPR Art. 13/14), not consent. The lawful basis is the tenant-controller's (legitimate interest); the notice informs, and a later `/optout` (separate spec) honors objection. See planning discussion; this spec is deliberately the *notice* layer only.

---

## Why now

Our groups are open and mixed (employees, external partners, and members of the public can all be in one group), so we can't rely on an onboarding relationship to inform people. The non-obvious fact a reasonable person would **not** assume on joining a group is that an AI vendor is **systematically logging every message and sending it to third-party model providers** (Anthropic / DeepSeek). Transparency law requires that this be *provided*, not merely *available if you go looking*. These two in-chat notices are the "provided" mechanism; the bot profile is the "available if you go looking" depth layer behind them.

This is cheap (two send calls at two events) and requires no new permissions.

---

## Telegram delivery preconditions (verify — do not assume)

- **`allowed_updates`:** the platform `setWebhook` (DEPLOYMENT A8c.1) is called **without** an `allowed_updates` argument, so Telegram applies its **default** set, which **includes** `my_chat_member` and `message` (which carries `new_chat_members` service messages) and excludes only `chat_member` / `message_reaction*` (none of which we need). **No webhook re-registration is required.**
  - **Verify (David runs SQL):** confirm the events are actually arriving by checking the archive:
    ```sql
    select update_type, count(*) from public.telegram_events
    where update_type in ('my_chat_member') group by update_type;
    ```
    (After the bot is added to any group at least once, expect a `my_chat_member` row. `new_chat_members` arrives inside `update_type = 'message'`, so it won't show as its own type — that's expected.)
  - **Only if** `my_chat_member` is somehow absent (a prior `setWebhook` restricted `allowed_updates`): re-run `setWebhook` **omitting** `allowed_updates` to restore the default set. Do **not** pass a narrow explicit list.
- **Privacy mode OFF** (already required platform-wide) ensures the bot receives `new_chat_members` service messages.
- **Known coverage gap (document, don't try to close):** in large/public supergroups, members who **self-join via an invite link or public username** may not generate a `new_chat_members` service message. Those users are covered by (a) the first-add announcement if they were present when the bot joined, and (b) the bot-profile / Privacy Policy backstop. We do **not** claim 100% per-user delivery, and that's fine for a notice (vs. a consent gate).

---

## Change 1 — First-add announcement (handle top-level `my_chat_member`)

**What:** when the bot's own membership transitions to "added" in a group, post one group-wide announcement.

**Placement (route):** `app/api/webhooks/platform/[botSlug]/route.ts`, a new top-level branch **immediately after the raw-event archive block (step 3b)** and **before** `const message = update.message;`. Rationale: `my_chat_member` is a top-level update field (not under `message`); the current handler never inspects it and would fall through to the `if (!message || !message.chat)` bail. `bot` (with `telegram_bot_token`) is already resolved at step 2, which is all we need.

**Mechanics:**
```ts
// 3c. First-add announcement (bot added to a group) — entity-agnostic, runs pre-/auth.
const mcm = update.my_chat_member;
if (mcm && mcm.chat) {
  const chatType = mcm.chat.type; // 'private' | 'group' | 'supergroup' | 'channel'
  const oldStatus = mcm.old_chat_member?.status;
  const newStatus = mcm.new_chat_member?.status;

  const wasOutside = oldStatus === 'left' || oldStatus === 'kicked';
  const isInside = newStatus === 'member' || newStatus === 'administrator';
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (isGroup && wasOutside && isInside) {
    try {
      await sendMessage(bot.telegram_bot_token, mcm.chat.id, ANNOUNCE_FIRST_ADD, {
        parseMode: 'HTML',
        // no threadId → posts to the General topic in forum groups
      });
    } catch (err) {
      console.error('Failed to send first-add announcement:', err);
    }
  }
  return NextResponse.json({ ok: true, msg: 'my_chat_member handled' });
}
```

**Notes / edge cases:**
- **Only the "added" transition fires.** Promote/demote (`member` ↔ `administrator`) and removal (`→ left/kicked`) are intentionally silent (the `wasOutside && isInside` guard).
- **`private` is excluded** so a user pressing Start in DM never triggers it.
- **Entity-agnostic on purpose.** At bot-add time the group is almost always **not** yet `/auth`-bound, so we do not resolve or require an entity. The announcement is generic ("once set up, I…"), which is accurate for the pre-binding state and reaches incumbents at the moment of arrival.
- **Idempotency:** the transition guard already prevents re-firing on unrelated status changes. A webhook **retry** (same `update_id`) could theoretically double-send, but we return `200` promptly and the cost is one duplicate message. We accept this for v1. (Optional hardening in Open Decisions.)

---

## Change 2 — On-join notice (handle `new_chat_members`)

**What:** when human member(s) join a **bound** group, post one short notice that @mentions them and links the policy.

**Placement (route):** a new service-message branch placed **after** the existing forum-topic/rename service branch and **before** the `if (!rawText && !captionMentionsBot)` bail (service messages have no `.text`, so they'd otherwise be dropped there).

**Mechanics:**
```ts
// Service message: new members joined
if (message && message.chat && Array.isArray(message.new_chat_members) && message.new_chat_members.length > 0) {
  // Only the platform's own bot id is truly "self"; filter all bots out of the notice.
  const joiners = message.new_chat_members.filter((u: any) => u && !u.is_bot);
  if (joiners.length === 0) {
    return NextResponse.json({ ok: true, msg: 'Only bot(s) joined — no notice' });
  }

  const entityId = await resolveEntityIdByChat(message.chat.id);
  if (!entityId) {
    // Group not bound yet → bot isn't logging here → nothing to disclose.
    return NextResponse.json({ ok: true, msg: 'Unbound group — no join notice' });
  }

  // Idempotency: dedup on update_id (same mechanism as step 4b), scoped to the entity.
  const updateId = update.update_id;
  if (updateId) {
    try {
      await withTenantContext(entityId, async (tx) => {
        await tx`insert into processed_updates (update_id, entity_id) values (${updateId}, ${entityId})`;
      });
    } catch {
      return NextResponse.json({ ok: true, msg: 'Duplicate join update ignored' });
    }
  }

  // Build ONE message mentioning all joiners (batch-add safe).
  const mentions = joiners
    .map((u: any) => `<a href="tg://user?id=${u.id}">${escapeHtml(u.first_name || 'there')}</a>`)
    .join(', ');
  const noticeHtml = NOTICE_ON_JOIN(mentions);

  try {
    await sendMessage(bot.telegram_bot_token, message.chat.id, noticeHtml, {
      parseMode: 'HTML',
      // no threadId → General
    });
  } catch (err) {
    console.error('Failed to send on-join notice:', err);
  }
  return NextResponse.json({ ok: true, msg: 'Join notice sent' });
}
```

**Mention mechanics (why `tg://user?id=`):** an inline `<a href="tg://user?id=UID">Name</a>` mention **notifies the user even if they have no @username** (a plain `@username` string silently no-ops for username-less users). It reuses the existing HTML send path (`parseMode: 'HTML'`) and the route's existing `escapeHtml` helper, so no manual entity-offset construction is needed. (Equivalent alternative: a `text_mention` `MessageEntity` keyed by `user.id` via the `entities` array — functionally the same; the HTML form is simpler and consistent with the rest of the handler. Minor caveat: the mention renders reliably because the bot has just "seen" the user in this very event.)

**Batch-add:** `new_chat_members` can list several users (someone adds ten people at once). We send **one** message mentioning all of them, not N messages, to avoid spamming the group.

**Scoping:** posted to General (no `threadId`). We do **not** apply the excluded-thread gate here — a join is a group-level event, and the notice is a one-time group-level disclosure.

---

## Copy (David-adjustable) — add near the existing `STATUS_*` constants

```ts
// Privacy policy URL. Config, NOT a secret → no NEXT_PUBLIC_ prefix (used server-side only,
// here in the webhook handler). Surfaced via lib/config with a default (see "Config wiring" +
// "Privacy page hosting" below), so it can never emit an empty link.
import { getPrivacyPolicyUrl } from '@/lib/config';

const PRIVACY_POLICY_URL = getPrivacyPolicyUrl();

// Fires once, when the bot is added to a group (reaches everyone already present).
const ANNOUNCE_FIRST_ADD =
  `👋 Hi everyone — I'm Leguan, an AI assistant that was just added to this group.\n\n` +
  `Once set up, I can answer questions from your team's saved documents (mention me), ` +
  `summarize recent discussion (<code>/recap</code>), and save messages as lasting context (<code>/push</code>).\n\n` +
  `To do that, I log group messages and may send them to AI model providers to generate answers. ` +
  `Here's how your data is handled: <a href="${PRIVACY_POLICY_URL}">Privacy Policy</a>.`;

// Fires per join (kept short — it repeats). {mentions} is pre-built HTML.
const NOTICE_ON_JOIN = (mentions: string) =>
  `👋 Welcome, ${mentions}! This group uses <b>Leguan</b>, an AI assistant that logs messages ` +
  `to power Q&A and recaps and may send them to AI providers to generate answers. ` +
  `How your data is handled: <a href="${PRIVACY_POLICY_URL}">Privacy Policy</a>.`;
```

> If you prefer not to evaluate `getPrivacyPolicyUrl()` at module load, make `ANNOUNCE_FIRST_ADD` / `NOTICE_ON_JOIN` functions that call it at send-time — cost is negligible. Module-load is fine since env is available then.

> **Deliberate wording choice:** the copy points to the **Privacy Policy** for "how your data is handled / your choices" rather than naming a `/optout` command, because `/optout` is a **separate, not-yet-built** feature (see Deferred). The policy page should describe the opt-out/deletion path (even if that path is "contact us" until the command ships). When `/optout` lands, add one sentence to each string. This keeps today's copy truthful.

---

## Config wiring (`PRIVACY_POLICY_URL`)

Add a getter to `lib/config.ts`, matching the existing default-with-override pattern (`getContextMessageHistoryLimit`). **Not** added to `validateConfig()`'s `required` list — it defaults, so a missing env var can't crash startup or emit a broken link:

```ts
// Public URL of the hosted privacy policy page. Config, not a secret. Defaults to the
// canonical URL so a notice link is never empty; override per environment if needed.
export function getPrivacyPolicyUrl(): string {
  const v = process.env.PRIVACY_POLICY_URL;
  return v && v.trim() !== '' ? v.trim() : 'https://leguan.ai/privacy';
}
```

And add to **`.env.example`** (config, not secret — no `NEXT_PUBLIC_` prefix; server-side only):

```
# Public URL of the hosted privacy policy page (linked from the bot's in-chat notices).
# Must match the BotFather "Privacy Policy" field. Defaults to https://leguan.ai/privacy if unset.
PRIVACY_POLICY_URL=https://leguan.ai/privacy
```

---

## Privacy page hosting (the page the notices link to)

The policy content must describe *our actual* processing (message logging to `message_log`; third-party AI model providers described as a **category** rather than named vendors, per the provider-naming decision; retention; opt-out/deletion). A policy "found online" is the wrong document and can't be used. Decisions settled in planning:

- **Store the source in the repo, serve it from Vercel — not from GitHub.** Repo visibility is irrelevant to the public page: Vercel builds the (possibly private) repo and serves the route. "Serving from GitHub" (a `raw.githubusercontent.com` link or Pages on a public repo) is the *only* thing a private repo would break — and we don't do that. Git history is a *bonus* here: it proves what the policy said on any date.
- **Implementation (small, but has one Vercel gotcha):** the policy content already lives in-repo as **`content/legal/privacy.md`** (written as part of this work; prose stays prose). Render it at a static route **`app/privacy/page.tsx`** (a server component):
  - Read the file server-side: `fs.readFileSync(path.join(process.cwd(), 'content/legal/privacy.md'), 'utf8')`.
  - Render markdown → HTML with a lightweight lib. Prefer **`react-markdown`** (no `dangerouslySetInnerHTML`); if a markdown renderer is already a dependency, reuse it. Strip the leading HTML comment (the internal "draft/review" note) so it never renders — `react-markdown` ignores raw HTML by default, so this is automatic unless `rehype-raw` is enabled (don't enable it).
  - **Ensure the `.md` is bundled** into the serverless output, or `process.cwd()` reads will 404 in production: add to `next.config.ts` → `outputFileTracingIncludes: { '/privacy': ['./content/legal/privacy.md'] }`.
  - Minimal styling only (a centered prose container; reuse `manage.css` or a small scoped block). This is a legal page, not a design surface.
  - Updating the policy = edit the markdown + redeploy. At a 1–3x/year cadence, redeploy-on-update is a non-issue — do **not** build a CMS.
  - *(Zero-dependency alternative: inline the prose in the page component. Chosen against — editing legal text in JSX is error-prone; one markdown dependency is worth it.)*
- **Domain / canonical URL:** the one Vercel project already serves all domains, so `app/privacy/page.tsx` is automatically live at `api.kenntnis.ai/privacy` **and** `app.leguan.ai/privacy` with no extra config. For the canonical `https://leguan.ai/privacy`, add the apex `leguan.ai` domain in Vercel + DNS (the route already exists). Set `PRIVACY_POLICY_URL` and the BotFather **Privacy Policy** field to whichever canonical URL is chosen — they must match.
- **Content drafting: DONE (draft).** The policy is written to **`content/legal/privacy.md`** — provider language kept generic ("third-party AI model providers", no named vendors), with an international-transfers clause, the controller (Workspace Administrator) / processor (Leguan) split, rights + opt-out/deletion, and CCPA language. It carries `[BRACKETED]` placeholders (legal entity name, address, contact email, dates, children's age) and a leading HTML-comment note that it is a **draft pending legal review** — both must be resolved before publishing. If a tenant DPA ever needs a *named* sub-processor list, that list lives in the DPA, not this public notice (the policy points readers to request it).

> **The page (route + markdown render) is a small, separable deliverable** from the notice-sending code in Changes 1–2. It can ship as its own step; the notices only need `PRIVACY_POLICY_URL` to resolve. Sequence the page **before** enabling notices in production (otherwise the link 404s).

---

## BotFather profile fields (manual — mirror into DEPLOYMENT)

Set once via `@BotFather` → `Edit @leguan_the_bot info` (the screenshot's menu). These are the durable backstop; they do **not** replace the in-chat notices (availability ≠ provision), but they carry depth and can't be unpinned.

- **Privacy Policy** (currently unset): set to the same URL as `PRIVACY_POLICY_URL` (e.g. `https://leguan.ai/privacy`). Telegram surfaces this natively on the bot's profile. (Confirmed via the profile screenshot that **About** renders on the profile card for group members; **Description** does not — it only shows in an empty private chat before Start, so nothing load-bearing lives only there.)
- **About** (≤ 120 chars; shows on the bot's profile card when a group member taps the bot):
  ```
  AI assistant for group Q&A and chat recaps, grounded in your team's docs. Logs messages — see the Privacy Policy.
  ```
- **Description** (≤ 512 chars; shows in an empty private chat before Start — group members usually don't see it, so keep nothing load-bearing *only* here):
  ```
  Leguan adds an AI assistant to your Telegram group. Mention it with a question to get answers from your team's saved documents, use /recap to summarize recent messages, and /push to save a message as lasting context.

  To power these features, Leguan logs group messages and may send them to AI model providers to generate answers — used only for these features. See the Privacy Policy below for how your data is handled and your choices.
  ```

> **[VERIFY on device]** Where each field surfaces when a group member taps `@leguan_the_bot` has shifted across Telegram client versions. Before finalizing, tap the bot from inside a group and confirm the About text and Privacy Policy link render where expected. Adjust which field carries the summary if needed.

---

## Tests (`scripts/test-privacy-notices.ts`, deterministic mocks)

Mock the Telegram send helper; assert on the calls (no real network). Feed synthetic update payloads.

1. **First-add fires on the added transition:** `my_chat_member` with `old=left`, `new=member`, `chat.type=supergroup` → exactly one `sendMessage` with `ANNOUNCE_FIRST_ADD` to `chat.id`, no `message_thread_id`.
2. **First-add is silent on non-add transitions:** `member→administrator`, `administrator→member`, `member→left`, `member→kicked` → **no** send.
3. **First-add ignores private/channel:** `chat.type=private` (user pressed Start) → no send.
4. **On-join, single human:** `message.new_chat_members=[{id, first_name, is_bot:false}]` in a **bound** group → one send; body contains `tg://user?id=<id>` and the policy link.
5. **On-join, batch:** three humans in one event → **one** send mentioning all three (comma-joined), not three sends.
6. **On-join filters bots:** `new_chat_members` containing only `is_bot:true` (incl. our own bot) → no send.
7. **On-join skips unbound group:** `resolveEntityIdByChat → null` → no send.
8. **On-join dedup:** same `update_id` delivered twice → exactly one send (second insert into `processed_updates` conflicts → skip).
9. **HTML safety:** a joiner whose `first_name` contains `<`/`&` → name is escaped in the emitted HTML (no broken markup / injection).
10. **`/privacy` route renders:** a request to `/privacy` returns 200 and the rendered policy (assert a known heading like "Privacy Policy" is present, and that the internal HTML-comment draft note is **not** in the output).

---

## What this does NOT do (deferred — by design)

- **No `/optout` command and no ingestion suppression.** Honoring objection (skip logging a user at the webhook boundary + support deletion) is the **separate opt-out spec**. This spec's copy references the policy for "your choices," not a command, until that ships.
- **No consent gate, no `restrictChatMember`/`banChatMember`, no admin-permission requirement.** Explicitly out of scope (rejected in planning).
- **No per-entity toggle** to disable notices (see Open Decisions — add only if we decide to now).
- **No allowed_updates change** (defaults already deliver both signals).

---

## Open decisions to confirm before build

1. **`/optout` wording:** ship notice copy that references only the policy now (recommended — truthful today), and add a `/optout` line when that command lands? Or sequence the opt-out spec first so the notices can name it on day one?
2. **`notify_on_join` toggle:** add a `entities.notify_on_join boolean not null default true` seam now (lets a noisy/high-join tenant mute the per-join notice; the first-add announcement + profile still cover transparency), or defer until a tenant asks? Lean: defer (build only what's needed).
3. **First-add idempotency:** accept the rare retry-duplicate (recommended, v1), or add a bot-scoped `bot_group_announcements (bot_slug, telegram_chat_id, announced_at)` table with a unique key for hard once-only? (Note: can't reuse `processed_updates` here — the chat is unbound pre-`/auth`, and that table requires `entity_id`.)
4. **`PRIVACY_POLICY_URL` final value + domain + page:** confirm the canonical URL (apex `leguan.ai/privacy` vs the zero-setup `app.leguan.ai/privacy`), stand up the page (see Privacy page hosting), and publish before enabling notices in prod. The `lib/config` getter defaults to `https://leguan.ai/privacy`; change the default if a different canonical URL is chosen.
