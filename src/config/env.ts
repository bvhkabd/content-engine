/**
 * Environment loading. Every secret enters the process here and nowhere else —
 * no credential is ever read from a tenant file or hardcoded.
 */

import 'dotenv/config';

export type StorageBackend = 'local' | 'google';

export interface Env {
  storageBackend: StorageBackend;
  tenantsDir: string;
  openrouterApiKey: string | undefined;
  openrouterModel: string;
  openrouterSiteUrl: string | undefined;
  openrouterAppName: string;
  /** Override the API base — for a proxy, a gateway, or a local mock. */
  openrouterBaseUrl: string | undefined;
  googleCredentialsJson: string | undefined;
  googleDriveRootFolderId: string | undefined;
  gmailAppPassword: string | undefined;
  firefliesApiKey: string | undefined;
  notify: {
    host: string | undefined;
    port: number;
    user: string | undefined;
    pass: string | undefined;
    to: string | undefined;
  };
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadEnv(): Env {
  const backend = (optional('STORAGE_BACKEND') ?? 'local').toLowerCase();
  if (backend !== 'local' && backend !== 'google') {
    throw new Error(`STORAGE_BACKEND must be "local" or "google" (got "${backend}")`);
  }

  return {
    storageBackend: backend,
    tenantsDir: optional('TENANTS_DIR') ?? './tenants',
    openrouterApiKey: optional('OPENROUTER_API_KEY'),
    openrouterModel: optional('OPENROUTER_MODEL') ?? 'openrouter/auto',
    openrouterSiteUrl: optional('OPENROUTER_SITE_URL'),
    openrouterAppName: optional('OPENROUTER_APP_NAME') ?? 'content-engine',
    openrouterBaseUrl: optional('OPENROUTER_BASE_URL'),
    googleCredentialsJson: optional('GOOGLE_CREDENTIALS_JSON'),
    googleDriveRootFolderId: optional('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
    gmailAppPassword: optional('GMAIL_APP_PASSWORD'),
    firefliesApiKey: optional('FIREFLIES_API_KEY'),
    notify: {
      host: optional('NOTIFY_SMTP_HOST'),
      port: Number(optional('NOTIFY_SMTP_PORT') ?? 465),
      user: optional('NOTIFY_SMTP_USER'),
      pass: optional('NOTIFY_SMTP_PASS'),
      to: optional('NOTIFY_TO'),
    },
  };
}

/**
 * Fetch a required secret with an actionable error. Commands call this only on
 * the paths that actually need the secret, so `topics` works with no LLM key.
 */
export function requireEnv<K extends keyof Env>(env: Env, key: K, why: string): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === null || value === '') {
    const varName = ENV_VAR_NAMES[key] ?? String(key);
    throw new Error(`${varName} is not set, but is required to ${why}. Add it to your .env file.`);
  }
  return value as NonNullable<Env[K]>;
}

const ENV_VAR_NAMES: Partial<Record<keyof Env, string>> = {
  openrouterApiKey: 'OPENROUTER_API_KEY',
  googleCredentialsJson: 'GOOGLE_CREDENTIALS_JSON',
  gmailAppPassword: 'GMAIL_APP_PASSWORD',
  firefliesApiKey: 'FIREFLIES_API_KEY',
};
