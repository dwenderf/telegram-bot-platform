// Unit tests for the webhook secret gate (issue #11). Pure; no database access.
// Run: npx tsx --test scripts/test-webhook-secret.ts
import { test } from 'node:test';
import assert from 'assert';
import {
  isValidTelegramSecretToken,
  rejectUnlessValidTelegramSecret,
  TELEGRAM_SECRET_HEADER,
} from '../lib/webhookAuth';

const SECRET = 'Abc123_secret-token';

function reqWith(header?: string): { headers: Headers } {
  const headers = new Headers();
  if (header !== undefined) headers.set(TELEGRAM_SECRET_HEADER, header);
  return { headers };
}

test('missing stored secret never matches', () => {
  for (const stored of [null, undefined, '']) {
    assert.strictEqual(isValidTelegramSecretToken(stored, null), false);
    assert.strictEqual(isValidTelegramSecretToken(stored, undefined), false);
    assert.strictEqual(isValidTelegramSecretToken(stored, ''), false);
    assert.strictEqual(isValidTelegramSecretToken(stored, SECRET), false);
  }
});

test('missing or empty header is rejected', () => {
  assert.strictEqual(isValidTelegramSecretToken(SECRET, null), false);
  assert.strictEqual(isValidTelegramSecretToken(SECRET, undefined), false);
  assert.strictEqual(isValidTelegramSecretToken(SECRET, ''), false);
});

test('wrong values are rejected', () => {
  assert.strictEqual(isValidTelegramSecretToken(SECRET, SECRET.slice(0, -1)), false); // prefix
  assert.strictEqual(isValidTelegramSecretToken(SECRET, SECRET + 'x'), false); // extension
  assert.strictEqual(isValidTelegramSecretToken(SECRET, SECRET.toUpperCase()), false); // case
  assert.strictEqual(isValidTelegramSecretToken(SECRET, SECRET.toLowerCase()), false); // case
  assert.strictEqual(isValidTelegramSecretToken(SECRET, 'something-else'), false);
});

test('correct value is accepted', () => {
  assert.strictEqual(isValidTelegramSecretToken(SECRET, SECRET), true);
});

test('rejectUnlessValidTelegramSecret returns bare 401 or null', async () => {
  for (const [stored, header] of [
    [null, undefined],
    [undefined, undefined],
    ['', ''],
    [SECRET, undefined],
    [SECRET, 'wrong'],
  ] as const) {
    const res = rejectUnlessValidTelegramSecret(reqWith(header), stored);
    assert.ok(res, `expected 401 for stored=${String(stored)} header=${String(header)}`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(await res.text(), '');
  }
  assert.strictEqual(rejectUnlessValidTelegramSecret(reqWith(SECRET), SECRET), null);
});
