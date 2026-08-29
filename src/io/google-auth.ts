/**
 * Google service-account auth, shared by the Drive and Sheets adapters.
 *
 * GOOGLE_CREDENTIALS_JSON may be either a path to the service-account JSON
 * file or the JSON itself (handy for CI secrets).
 */

import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import type { GoogleAuth } from 'google-auth-library';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  [key: string]: unknown;
}

export function parseCredentials(credentialsJson: string): ServiceAccountCredentials {
  const raw = credentialsJson.trim();
  let text = raw;
  if (!raw.startsWith('{')) {
    try {
      text = readFileSync(raw, 'utf8');
    } catch {
      throw new Error(
        `GOOGLE_CREDENTIALS_JSON points at "${raw}" but that file could not be read. ` +
          'Give it either a path to your service-account JSON or the JSON itself.',
      );
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('GOOGLE_CREDENTIALS_JSON is not valid JSON.');
  }
  const creds = parsed as ServiceAccountCredentials;
  if (!creds.client_email || !creds.private_key) {
    throw new Error(
      'Service-account JSON is missing client_email / private_key. ' +
        'Download a fresh key from Google Cloud Console → IAM → Service Accounts → Keys.',
    );
  }
  return creds;
}

const authCache = new Map<string, GoogleAuth>();

export function getAuth(credentials: string | ServiceAccountCredentials): GoogleAuth {
  const creds = typeof credentials === 'string' ? parseCredentials(credentials) : credentials;
  const key = creds.client_email;
  const cached = authCache.get(key);
  if (cached) return cached;
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: GOOGLE_SCOPES });
  authCache.set(key, auth);
  return auth;
}

export function driveClient(credentials: string | ServiceAccountCredentials) {
  return google.drive({ version: 'v3', auth: getAuth(credentials) });
}

export function sheetsClient(credentials: string | ServiceAccountCredentials) {
  return google.sheets({ version: 'v4', auth: getAuth(credentials) });
}

/** Turn Google's verbose API errors into something a human can act on. */
export function explainGoogleError(error: unknown, context: string): Error {
  const err = error as { code?: number | string; message?: string; errors?: { message?: string }[] };
  const code = Number(err?.code);
  const detail = err?.errors?.[0]?.message ?? err?.message ?? String(error);

  if (code === 404) {
    return new Error(
      `${context}: not found (404). Check the ID is right AND that the Drive folder / Sheet ` +
        'is shared with your service-account email as Editor.',
    );
  }
  if (code === 403) {
    return new Error(
      `${context}: permission denied (403). Share the Drive folder / Sheet with your ` +
        `service-account email as Editor, and make sure the Drive and Sheets APIs are enabled. (${detail})`,
    );
  }
  if (code === 401) {
    return new Error(`${context}: authentication failed (401). Check GOOGLE_CREDENTIALS_JSON. (${detail})`);
  }
  return new Error(`${context}: ${detail}`);
}
