/**
 * Outbound notifications (oracle summary, watchdog alerts).
 *
 * With no SMTP configured, notifications go to the log and the terminal rather
 * than failing — a missing mail server should never break a job that otherwise
 * worked.
 */

import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';
import type { Logger } from './logger.js';

export interface Notification {
  subject: string;
  body: string;
  /** Overrides NOTIFY_TO — e.g. the author's email from tenant.yaml. */
  to?: string;
}

export function notificationsEnabled(env: Env): boolean {
  return Boolean(env.notify.host && env.notify.user && env.notify.pass);
}

export async function notify(env: Env, log: Logger, message: Notification): Promise<boolean> {
  const to = message.to || env.notify.to;

  if (!notificationsEnabled(env) || !to) {
    log.info(`NOTIFY (not sent, no SMTP configured): ${message.subject}`);
    console.log(`\n📬 ${message.subject}\n${message.body}\n`);
    return false;
  }

  try {
    const transport = nodemailer.createTransport({
      host: env.notify.host,
      port: env.notify.port,
      secure: env.notify.port === 465,
      auth: { user: env.notify.user!, pass: env.notify.pass! },
    });
    await transport.sendMail({
      from: env.notify.user!,
      to,
      subject: message.subject,
      text: message.body,
    });
    log.info(`NOTIFY sent to ${to}: ${message.subject}`);
    return true;
  } catch (error) {
    // Report, do not throw: the job's real work already succeeded.
    log.warn(`NOTIFY failed (${(error as Error).message}) — falling back to console`);
    console.log(`\n📬 ${message.subject}\n${message.body}\n`);
    return false;
  }
}
