/**
 * Gmail app-password handling and connection diagnostics.
 *
 * Regression coverage: Google displays app passwords as four space-separated
 * groups, people paste them verbatim, and the loader only trimmed the ends.
 * IMAP sent the literal 19-character string, Gmail answered "Invalid
 * credentials", and the error text blamed the password — which was correct all
 * along. The symptom read as a timeout, so the investigation went to the
 * network and to OAuth rather than to four spaces.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { describeConnectFailure } from '../src/sources/subscriptions-inbox.js';

describe('GMAIL_APP_PASSWORD normalisation', () => {
  const original = process.env.GMAIL_APP_PASSWORD;

  beforeEach(() => {
    delete process.env.GMAIL_APP_PASSWORD;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.GMAIL_APP_PASSWORD;
    else process.env.GMAIL_APP_PASSWORD = original;
  });

  it('strips the spaces Google puts in the display form', () => {
    process.env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
    expect(loadEnv().gmailAppPassword).toBe('abcdefghijklmnop');
  });

  it('leaves an already-stripped password alone', () => {
    process.env.GMAIL_APP_PASSWORD = 'abcdefghijklmnop';
    expect(loadEnv().gmailAppPassword).toBe('abcdefghijklmnop');
  });

  it('handles tabs, newlines and runs of spaces from a sloppy paste', () => {
    process.env.GMAIL_APP_PASSWORD = '  abcd\tefgh\n ijkl   mnop  ';
    expect(loadEnv().gmailAppPassword).toBe('abcdefghijklmnop');
  });

  it('treats a whitespace-only value as unset rather than an empty password', () => {
    process.env.GMAIL_APP_PASSWORD = '    ';
    expect(loadEnv().gmailAppPassword).toBeUndefined();
  });

  it('reports unset when absent', () => {
    expect(loadEnv().gmailAppPassword).toBeUndefined();
  });
});

describe('describeConnectFailure', () => {
  const email = 'someone@gmail.com';
  const host = 'imap.gmail.com';

  it('routes an auth rejection to credential remedies', () => {
    const message = describeConnectFailure(
      { responseText: 'Invalid credentials (Failure)' },
      email,
      host,
    );
    expect(message).toMatch(/rejected the credentials/i);
    expect(message).toContain('App passwords');
    expect(message).toMatch(/spaces .* stripped automatically/i);
    // Must not send someone to debug their network for a bad password.
    expect(message).not.toMatch(/port 993/i);
  });

  it('routes a timeout to network remedies and says the password is irrelevant', () => {
    const message = describeConnectFailure({ message: 'Socket timeout' }, email, host);
    expect(message).toMatch(/network problem, not a credential problem/i);
    expect(message).toContain('993');
    expect(message).not.toMatch(/app password/i);
  });

  it('recognises ETIMEDOUT by code', () => {
    expect(describeConnectFailure({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, email, host))
      .toMatch(/network problem/i);
  });

  it('reports DNS failures as DNS failures', () => {
    const message = describeConnectFailure({ code: 'ENOTFOUND', message: 'getaddrinfo' }, email, host);
    expect(message).toMatch(/could not resolve/i);
    expect(message).toContain('ENOTFOUND');
  });

  it('falls back without inventing a cause it cannot support', () => {
    const message = describeConnectFailure({ message: 'something odd happened' }, email, host);
    expect(message).toContain('something odd happened');
    expect(message).not.toMatch(/app password|port 993/i);
  });
});
