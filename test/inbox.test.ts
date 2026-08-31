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
import {
  DEFAULT_MIN_WORDS,
  cleanEmailBody,
  describeConnectFailure,
  isSubstantive,
  userLabels,
  wordCount,
} from '../src/sources/subscriptions-inbox.js';

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

describe('cleanEmailBody', () => {
  it('removes bracketed tracking pixels', () => {
    const body = '[https://eotrx.substackcdn.com/o/abc/p.gif?token=eyJtIjoiPDIw] Real content here.';
    const cleaned = cleanEmailBody(body);
    expect(cleaned).toBe('Real content here.');
    expect(cleaned).not.toContain('substackcdn');
  });

  it('removes the "View this post on the web" preamble', () => {
    const cleaned = cleanEmailBody(
      'View this post on the web at https://example.substack.com/p/x Agency is the initiative to act.',
    );
    expect(cleaned).toContain('Agency is the initiative to act.');
    expect(cleaned).not.toMatch(/view this post/i);
  });

  it('keeps a URL domain as a provenance hint but drops the tracking tail', () => {
    const cleaned = cleanEmailBody('Discussed at https://oneusefulthing.org/p/agency?utm_source=abc&token=xyz today.');
    expect(cleaned).toContain('(oneusefulthing.org)');
    expect(cleaned).not.toContain('utm_source');
    expect(cleaned).not.toContain('token=xyz');
  });

  it('strips unsubscribe and copyright footers', () => {
    const cleaned = cleanEmailBody('Real argument. Unsubscribe here to stop these emails © 2026 Substack Inc');
    expect(cleaned).toContain('Real argument.');
    expect(cleaned).not.toMatch(/unsubscribe|©/i);
  });

  it('collapses whitespace', () => {
    expect(cleanEmailBody('one\n\n\n   two\t\tthree')).toBe('one two three');
  });

  it('does not eat the body of single-line HTML mail', () => {
    // Regression: the preamble pattern once ran to end of line, and stripHtml
    // collapses HTML mail onto one line, so the entire article vanished.
    const oneLine =
      'View this post on the web at https://x.substack.com/p/y The argument starts here ' +
      'and continues for a long while with several sentences of real content.';
    const cleaned = cleanEmailBody(oneLine);
    expect(cleaned).toContain('The argument starts here');
    expect(cleaned).toContain('real content');
    expect(wordCount(cleaned)).toBeGreaterThan(15);
  });

  it('leaves clean prose untouched', () => {
    const prose = 'Eighty-three small reactor designs exist. Two are running.';
    expect(cleanEmailBody(prose)).toBe(prose);
  });

  it('does not crash on an empty body', () => {
    expect(cleanEmailBody('')).toBe('');
  });
});

describe('isSubstantive', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

  it('keeps a real newsletter', () => {
    expect(isSubstantive(words(600), DEFAULT_MIN_WORDS)).toBe(true);
  });

  it('drops a platform digest', () => {
    // Measured from the live inbox: digests land at 30-150 words after cleaning.
    expect(isSubstantive(words(96), DEFAULT_MIN_WORDS)).toBe(false);
    expect(isSubstantive(words(149), DEFAULT_MIN_WORDS)).toBe(false);
  });

  it('is exact at the boundary', () => {
    expect(isSubstantive(words(200), 200)).toBe(true);
    expect(isSubstantive(words(199), 200)).toBe(false);
  });

  it('honours a per-tenant override', () => {
    expect(isSubstantive(words(50), 10)).toBe(true);
  });

  it('counts words, not characters — a wall of URLs is not substance', () => {
    const urls = Array.from({ length: 20 }, () => 'https://example.com/a/very/long/tracking/path').join(' ');
    expect(urls.length).toBeGreaterThan(800);
    expect(isSubstantive(cleanEmailBody(urls), DEFAULT_MIN_WORDS)).toBe(false);
  });
});

describe('wordCount', () => {
  it('ignores runs of whitespace', () => {
    expect(wordCount('  one   two \n three  ')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});

describe('userLabels', () => {
  it('hides INBOX and Gmail system folders', () => {
    const labels = userLabels([
      'INBOX',
      '[Gmail]/All Mail',
      '[Gmail]/Sent Mail',
      '[Gmail]',
      'Postideas',
      'Clients',
    ]);
    expect(labels).toEqual(['Clients', 'Postideas']);
  });

  it('returns nothing when the account has no custom labels', () => {
    expect(userLabels(['INBOX', '[Gmail]/Spam'])).toEqual([]);
  });
});
