/**
 * Gmail source — newsletters and clippings filed under a label (#Postideas).
 *
 * Read over IMAP with an app password. Gmail exposes labels as IMAP mailboxes,
 * so the label name is the mailbox path. Messages are left unread; the oracle
 * dedupes on Message-ID via the vault's Source Ref column instead of mutating
 * your inbox.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { SourceDocument } from './types.js';

export interface InboxOptions {
  email: string;
  appPassword: string;
  label: string;
  /** Only messages newer than this many days. */
  sinceDays?: number;
  host?: string;
  port?: number;
  limit?: number;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
  /** Drop messages with fewer prose words than this after cleaning. */
  minWords?: number;
  /** Substring matches against the From header; matches are dropped. */
  excludeSenders?: string[];
  /** Called with one line per dropped message, for logging. */
  onSkip?: (reason: string) => void;
}

/**
 * Word floor for a message to be worth an LLM call. Set from a real inbox:
 * platform digests land at 30-150 words after cleaning, the thinnest genuine
 * newsletter at ~600.
 */
export const DEFAULT_MIN_WORDS = 200;

export interface InboxMessage {
  subject: string;
  body: string;
  from: string;
  messageId: string;
  date: string;
}

/**
 * Fetch messages carrying the configured label.
 * Matches CLAUDE_CODE_BRIEF.md § src/sources, widened to take the label and
 * lookback window from tenant config rather than hardcoding them.
 */
export async function fetchPostIdeasEmails(options: InboxOptions): Promise<InboxMessage[]> {
  const { email, appPassword, label } = options;
  if (!email || !appPassword) return [];

  const client = new ImapFlow({
    host: options.host ?? 'imap.gmail.com',
    port: options.port ?? 993,
    secure: true,
    // Spaces stripped here as well as in env loading: this function is also
    // called directly from tests and scripts.
    auth: { user: email, pass: appPassword.replace(/\s+/g, '') },
    logger: false,
    // Without these, a stalled connection hangs the oracle indefinitely
    // instead of failing with something you can act on.
    connectionTimeout: options.connectionTimeoutMs ?? 15_000,
    greetingTimeout: options.greetingTimeoutMs ?? 10_000,
    socketTimeout: options.socketTimeoutMs ?? 60_000,
  });

  const messages: InboxMessage[] = [];
  const skipped: string[] = [];
  const since = new Date(Date.now() - (options.sinceDays ?? 7) * 86_400_000);
  const limit = options.limit ?? 25;

  try {
    await client.connect();
  } catch (error) {
    throw new Error(describeConnectFailure(error, email, options.host ?? 'imap.gmail.com'));
  }

  let lock: { release: () => void } | undefined;
  try {
    const mailbox = await resolveMailbox(client, label);
    if (!mailbox) {
      const available = userLabels((await client.list()).map((box) => box.path));
      throw new Error(
        `Gmail label "${label}" not found for ${email}.\n` +
          (available.length
            ? `Labels in this account: ${available.join(', ')}\n` +
              'Set sources.subscriptions_inbox.label in tenant.yaml to one of these.'
            : 'This account has no custom labels yet — create one and file some mail under it.'),
      );
    }

    lock = await client.getMailboxLock(mailbox);
    const uids = await client.search({ since }, { uid: true });
    const recent = (uids || []).slice(-limit);

    // An empty label is normal — nothing filed this week. Fetching an empty
    // UID set is an invalid range, so return early rather than let it throw.
    if (recent.length === 0) return [];

    const minWords = options.minWords ?? DEFAULT_MIN_WORDS;
    const excluded = (options.excludeSenders ?? []).map((s) => s.toLowerCase());

    for await (const message of client.fetch(recent, { source: true, envelope: true }, { uid: true })) {
      if (!message.source) continue;
      const parsed = await simpleParser(message.source);
      const from = parsed.from?.text ?? '(unknown sender)';

      if (excluded.some((pattern) => from.toLowerCase().includes(pattern))) {
        skipped.push(`${parsed.subject ?? '(no subject)'} — excluded sender`);
        continue;
      }

      const body = cleanEmailBody((parsed.text ?? stripHtml(parsed.html || '')).trim());
      if (!body) continue;

      // Platform digests and notification mail carry almost no prose once the
      // chrome is stripped; they are not worth a call.
      if (!isSubstantive(body, minWords)) {
        skipped.push(`${parsed.subject ?? '(no subject)'} — only ${wordCount(body)} words after cleaning`);
        continue;
      }

      messages.push({
        subject: parsed.subject ?? '(no subject)',
        body,
        from,
        messageId: parsed.messageId ?? `uid:${message.uid}`,
        date: (parsed.date ?? new Date()).toISOString().slice(0, 10),
      });
    }
  } finally {
    lock?.release();
    await client.logout().catch(() => undefined);
  }

  // Report what was dropped rather than silently shrinking the batch.
  if (options.onSkip) for (const reason of skipped) options.onSkip(reason);

  return messages;
}

/**
 * Separate the failure modes, because the remedies have nothing in common.
 * Blaming the password for a network timeout sends people to re-generate a
 * credential that was never the problem.
 */
export function describeConnectFailure(error: unknown, email: string, host: string): string {
  const err = error as { responseText?: string; message?: string; code?: string };
  const detail = err?.responseText ?? err?.message ?? String(error);
  const lower = detail.toLowerCase();

  if (lower.includes('invalid credentials') || lower.includes('authenticationfailed')) {
    return (
      `Gmail rejected the credentials for ${email}: ${detail}\n` +
      'Most common causes, in order:\n' +
      '  1. GMAIL_APP_PASSWORD is your account password, not an app password.\n' +
      '  2. The app password was revoked, or belongs to a different account.\n' +
      '  3. 2-Step Verification is off — app passwords do not exist without it.\n' +
      'Generate one at: Google Account → Security → 2-Step Verification → App passwords.\n' +
      'Spaces in the value are fine; they are stripped automatically.'
    );
  }

  if (lower.includes('timeout') || lower.includes('timed out') || err?.code === 'ETIMEDOUT') {
    return (
      `Timed out connecting to ${host} as ${email}: ${detail}\n` +
      'This is a network problem, not a credential problem — the password is never sent.\n' +
      '  • Port 993 outbound may be blocked (corporate network, VPN, or ISP).\n' +
      `  • Test the path directly:  openssl s_client -connect ${host}:993 -crlf\n` +
      '  • If that also hangs, no change to authentication will help.'
    );
  }

  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') {
    return `Could not resolve ${host} (${err.code}). Check DNS and your network connection.`;
  }

  return `Could not connect to ${host} as ${email}: ${detail}`;
}

/**
 * Find the mailbox for a label.
 *
 * Gmail nests custom labels differently across accounts, and a label written
 * as "#Postideas" is stored as "Postideas" — the hash is how people write
 * labels, not part of the name. Both forms are accepted.
 */
async function resolveMailbox(client: ImapFlow, label: string): Promise<string | null> {
  const list = await client.list();
  const names = new Set(list.map((box) => box.path));

  // Try the label as given and with a leading #/ stripped.
  const forms = [label, label.replace(/^[#/]+/, '')].filter(
    (form, i, all) => form !== '' && all.indexOf(form) === i,
  );

  for (const form of forms) {
    for (const candidate of [form, `[Gmail]/${form}`, `INBOX/${form}`]) {
      if (names.has(candidate)) return candidate;
    }
  }

  // Case-insensitive match on the leaf name.
  for (const form of forms) {
    const leaf = form.toLowerCase();
    const found = list.find(
      (box) => (box.name ?? '').toLowerCase() === leaf || box.path.toLowerCase() === leaf,
    );
    if (found) return found.path;
  }
  return null;
}

/** Labels a person could plausibly have meant, for the not-found error. */
export function userLabels(paths: readonly string[]): string[] {
  return paths.filter((path) => path !== 'INBOX' && !path.startsWith('[Gmail]')).sort();
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Strip newsletter chrome so what reaches the oracle is mostly prose.
 *
 * Tracking pixels, bare URLs and "View this post on the web at …" preambles
 * are a large share of a typical Substack email's extracted text. Left in,
 * they consume the per-document truncation budget and give the model URL
 * fragments to reason about instead of argument.
 */
export function cleanEmailBody(text: string): string {
  return (
    text
      // Bracketed image/tracking URLs: [https://…]
      .replace(/\[\s*https?:\/\/[^\]]*\]/gi, ' ')
      // Substack/Beehiiv web-view preamble, plus the one URL that follows it.
      // Deliberately bounded: an earlier version matched to end of line, and
      // because stripHtml collapses HTML mail onto a single line that deleted
      // the whole body of every HTML-only newsletter.
      .replace(
        /view (?:this )?(?:post|email|issue)?\s*(?:on|in)\s+(?:the\s+)?(?:web|browser)(?:\s+at)?\s*(?:https?:\/\/\S+)?/gi,
        ' ',
      )
      // Bare URLs. Keep the domain — it is a useful provenance hint — drop the
      // query strings and tracking tokens that make up most of the length.
      .replace(/https?:\/\/([^\s<>)\]]+)/gi, (_match, rest: string) => {
        const domain = String(rest).split('/')[0] ?? '';
        return domain ? `(${domain})` : ' ';
      })
      // Common unsubscribe / preference footers.
      .replace(/unsubscribe[^\n]*/gi, ' ')
      .replace(/©\s*\d{4}[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Is there enough prose here to be worth an LLM call?
 *
 * Platform digests ("X and 3 others posted new notes") survive HTML stripping
 * as a few hundred words of teaser wrapped around tracking links. After
 * cleaning they fall well below any real newsletter, so a word floor separates
 * them without needing a sender blocklist.
 */
export function isSubstantive(body: string, minWords: number): boolean {
  return wordCount(body) >= minWords;
}

export function toSourceDocuments(messages: readonly InboxMessage[]): SourceDocument[] {
  return messages.map((m) => ({
    kind: 'email',
    reference: m.messageId,
    title: m.subject,
    content: `From: ${m.from}\nDate: ${m.date}\n\n${m.body}`,
  }));
}
