import { createHmac } from 'crypto';

/**
 * Records which scope contract produced a model_calls row. Static "group" today
 * ("requires a group for now"). When the DM / purpose-bot future changes the resolver
 * contract to allow another scope, this tag lets historical rows stay self-describing
 * instead of being inferred from row age.
 */
export const ISOLATION_SCOPE_TYPE = 'group' as const;

/**
 * Shared peppered-HMAC primitive — the single place that reads APP_HMAC_PEPPER, applies
 * the algorithm, and joins the domain tag to the message with a fixed ':' separator.
 *
 * Module-private for now: resolveIsolationScopeId below is the only caller. When the
 * message_log PII hasher lands (its own spec), promote this to a shared module then — do
 * NOT add a second wrapper here ahead of that spec.
 *
 * Fail-fast: throws if the pepper is unset. Never returns an unpeppered hash.
 *
 * Domain separation via `${domain}:${message}` is injective ONLY because `domain` values
 * are fixed internal constants that never contain a ':'. NEVER pass a user-controlled
 * string as `domain` (that would need length-prefixing to stay unambiguous); `message`
 * may be arbitrary, as it is the trailing field.
 */
function pepperedHmac(domain: string, message: string): string {
  const pepper = process.env.APP_HMAC_PEPPER;
  if (!pepper) {
    throw new Error('APP_HMAC_PEPPER is not set; refusing to hash.');
  }
  return createHmac('sha256', pepper).update(`${domain}:${message}`).digest('hex');
}

/**
 * Produce the opaque per-group identifier passed to providers as metadata.user_id.
 *
 * Domain tag 'isolation-scope' — the primitive appends the ':' separator, so the tag
 * carries no colon. Do NOT change the tag string: it is baked into every historical hash;
 * changing it silently orphans every previously-issued id (new cache partitions, new
 * content-safety identities, and logged ids that no longer match live output).
 *
 * Throws (via the primitive on missing pepper, or the guard on missing groupId) — never
 * returns null/empty. A missing pepper or groupId is a misconfiguration we refuse to paper
 * over by sending an unscoped (empty-user_id) call; the throw aborts before any provider
 * request goes out.
 *
 * Output: 64-char lowercase hex. Satisfies DeepSeek's user_id constraint
 * ([a-zA-Z0-9\-_]+, length <= 512) and Anthropic's opaque-id / no-PII guidance.
 */
export function resolveIsolationScopeId(groupId: string): string {
  if (!groupId) {
    throw new Error(
      'resolveIsolationScopeId: groupId is required (isolation is group-scoped).'
    );
  }
  return pepperedHmac('isolation-scope', groupId);
}
