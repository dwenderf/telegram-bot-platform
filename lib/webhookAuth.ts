import { createHash, timingSafeEqual } from 'crypto';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Fail-closed, constant-time check of Telegram's webhook secret token.
 *
 * Returns true only when both the stored and provided values are non-empty
 * strings and they match. A missing stored secret (e.g. an unreadable Vault
 * entry) never matches, even against a missing header. Both sides are hashed
 * first so timingSafeEqual always compares equal-length buffers and the
 * comparison does not leak the secret's length.
 */
export function isValidTelegramSecretToken(
  stored: string | null | undefined,
  provided: string | null | undefined
): boolean {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  if (typeof provided !== 'string' || provided.length === 0) return false;
  return timingSafeEqual(sha256(stored), sha256(provided));
}

/**
 * Returns a bare 401 response when the request's secret header does not match
 * the stored secret, or null when the request is authorized.
 */
export function rejectUnlessValidTelegramSecret(
  req: { headers: Headers },
  stored: string | null | undefined
): Response | null {
  const provided = req.headers.get(TELEGRAM_SECRET_HEADER);
  if (isValidTelegramSecretToken(stored, provided)) return null;
  return new Response(null, { status: 401 });
}
