# Backlog / Known Items

> Running list of known issues, deferred polish, and small follow-ups for the v1 build.
> **Larger deferred features** (write-commands, `/setup`, group-scoped context, web app, public API, etc.) live in `PLANNING.md` §9 "Non-Goals & Future Hooks" — this file is for smaller bugs/polish that surface during the build.
> **Security model** is implemented and verified — see `SECURITY-PROPOSAL.md` (resolved) for the rationale record.

---

## Open — non-security polish

### B1 — Move the model id to per-tenant config (currently hardcoded)
`lib/capabilities.ts` (`answerQuestion`) hardcodes the model:
```ts
const model = 'claude-3-5-sonnet-20241022';
```
`PLANNING.md` §4.2 specifies the model id should live in **per-entity config** (so it's tunable per-tenant and updatable without a code change). Two parts:
- Move the model id into entity config (e.g. an `entities.model` column or a config table) and read it per request.
- The hardcoded value is also an **older Sonnet**; pick a current model when wiring this up.

*Why it matters:* product flexibility (different tenants may want different models/tiers) and avoids a code deploy to change models. Not urgent for a single-tenant POC, but it's a §4.2 requirement and cheap to do.

### B2 — Verify null-thread (General topic) doc resolution in `buildContext`
`lib/capabilities.ts` (`buildContext`) matches topic docs with:
```sql
where m.entity_id = ${entityId}
  and (m.telegram_thread_id is null or m.telegram_thread_id = ${threadIdStr})
```
When a question is asked in the **General topic**, `threadIdStr` is `null`. The `is null` branch still loads the entity-general docs correctly, so this is likely fine — but the `m.telegram_thread_id = ${null}` comparison won't match any topic-specific entries the way `is not distinct from` would. (The recent-messages query in the same function correctly uses `is not distinct from`.)
- **Confirm** a General-topic question resolves the intended docs.
- If General is ever meant to have its *own* topic-specific manifest entries (thread_id null but distinct from "general"), reconcile the semantics — currently "null thread" and "entity-general" are the same thing, which is probably the intended design, but worth an explicit check.

*Why it matters:* correctness of context loading in the General topic. Low risk given the `is null` branch covers the common case, but worth a deliberate confirmation.

---

## Done

- Database security model (RLS + Vault + bootstrap functions + least-privilege role). See `SECURITY-PROPOSAL.md` (resolved).
- `.env.example` corrected to connect as `bot_service` (not superuser); unused `SUPABASE_SERVICE_ROLE_KEY` removed.
