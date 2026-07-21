// lib/config.ts

function parsePositiveInteger(val: string | undefined, defaultVal: number): number {
  if (val === undefined || val === null || val.trim() === '') return defaultVal;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed <= 0) {
    return defaultVal;
  }
  return parsed;
}

let isConfigValidated = false;

export function validateConfig(): void {
  if (isConfigValidated) return;

  const required = ['MODEL_IDENTIFIER'];
  const missing = required.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(`Required configuration environment variable(s) missing: ${missing.join(', ')}`);
  }

  isConfigValidated = true;
}

export function getModelIdentifier(): string {
  validateConfig();
  return process.env.MODEL_IDENTIFIER!;
}

export function getModelMaxOutputTokens(): number {
  return parsePositiveInteger(process.env.MODEL_MAX_OUTPUT_TOKENS, 2048);
}

export function getContextMessageHistoryLimit(): number {
  return parsePositiveInteger(process.env.CONTEXT_MESSAGE_HISTORY_LIMIT, 30);
}

// Model for document reads (Anthropic-only capability). Not an operator preference —
// hardcoded, not an env var. Update here on deprecation; flagged in the README.
export const ANTHROPIC_DOCUMENT_MODEL = 'claude-sonnet-5';

// Public URL of the hosted privacy policy page. Config, not a secret. Defaults to the
// canonical URL so a notice link is never empty; override per environment if needed.
export function getPrivacyPolicyUrl(): string {
  const v = process.env.PRIVACY_POLICY_URL;
  return v && v.trim() !== '' ? v.trim() : 'https://leguan.ai/privacy';
}

