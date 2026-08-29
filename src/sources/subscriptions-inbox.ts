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
}

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
    auth: { user: email, pass: appPassword },
    logger: false,
  });

  const messages: InboxMessage[] = [];
  const since = new Date(Date.now() - (options.sinceDays ?? 7) * 86_400_000);
  const limit = options.limit ?? 25;

  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Could not connect to ${options.host ?? 'imap.gmail.com'} as ${email}: ${(error as Error).message}\n` +
        'Check GMAIL_APP_PASSWORD (a 16-character app password, not your account password) ' +
        'and that IMAP is enabled in Gmail settings.',
    );
  }

  let lock: { release: () => void } | undefined;
  try {
    const mailbox = await resolveMailbox(client, label);
    if (!mailbox) {
      throw new Error(
        `Gmail label "${label}" not found for ${email}. Create the label, or change ` +
          'sources.subscriptions_inbox.label in tenant.yaml.',
      );
    }

    lock = await client.getMailboxLock(mailbox);
    const uids = await client.search({ since }, { uid: true });
    const recent = (uids || []).slice(-limit);

    for await (const message of client.fetch(recent, { source: true, envelope: true }, { uid: true })) {
      if (!message.source) continue;
      const parsed = await simpleParser(message.source);
      const body = (parsed.text ?? stripHtml(parsed.html || '')).trim();
      if (!body) continue;
      messages.push({
        subject: parsed.subject ?? '(no subject)',
        body,
        from: parsed.from?.text ?? '(unknown sender)',
        messageId: parsed.messageId ?? `uid:${message.uid}`,
        date: (parsed.date ?? new Date()).toISOString().slice(0, 10),
      });
    }
  } finally {
    lock?.release();
    await client.logout().catch(() => undefined);
  }

  return messages;
}

/** Gmail nests custom labels differently across accounts; try the variants. */
async function resolveMailbox(client: ImapFlow, label: string): Promise<string | null> {
  const list = await client.list();
  const names = list.map((box) => box.path);
  const candidates = [label, `[Gmail]/${label}`, `INBOX/${label}`];
  for (const candidate of candidates) {
    if (names.includes(candidate)) return candidate;
  }
  // Fall back to a case-insensitive match on the leaf name.
  const leaf = label.toLowerCase();
  const found = list.find((box) => (box.name ?? '').toLowerCase() === leaf);
  return found?.path ?? null;
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

export function toSourceDocuments(messages: readonly InboxMessage[]): SourceDocument[] {
  return messages.map((m) => ({
    kind: 'email',
    reference: m.messageId,
    title: m.subject,
    content: `From: ${m.from}\nDate: ${m.date}\n\n${m.body}`,
  }));
}
