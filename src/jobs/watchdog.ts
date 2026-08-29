/**
 * `content-engine watchdog` — headless daily job.
 *
 * Checks that the scheduled jobs actually ran and that nothing is stuck
 * waiting on a human. Emits one email listing every problem it found, or stays
 * quiet when everything is healthy.
 */

import { createContext, type RunContext } from '../config/context.js';
import { HEARTBEAT, isoDate, logFileName } from '../io/logger.js';
import { notify } from '../io/notify.js';
import { TenantPaths } from '../io/storage.js';
import { getAuthor } from '../config/tenant.js';
import { failure, heading, info, style, success } from '../ui/console.js';

export interface WatchdogOptions {
  tenant: string;
  /** Override the notification recipient. */
  email?: string;
  /** Jobs that must have logged a heartbeat today. */
  jobs?: string[];
}

export interface WatchdogAlert {
  kind: 'missing-heartbeat' | 'stale-draft' | 'stale-proposal';
  message: string;
}

export interface WatchdogResult {
  alerts: WatchdogAlert[];
  healthy: boolean;
}

const DEFAULT_JOBS = ['oracle'];

export async function watchdog(options: WatchdogOptions): Promise<WatchdogResult> {
  const ctx = await createContext(options.tenant, { job: 'watchdog', echo: true });
  const now = new Date();
  const today = isoDate(now);

  try {
    heading(`Watchdog — ${ctx.tenant} — ${today}`);
    const alerts: WatchdogAlert[] = [];

    alerts.push(...(await checkHeartbeats(ctx, options.jobs ?? DEFAULT_JOBS, now)));
    alerts.push(...(await checkStaleDrafts(ctx, now)));
    alerts.push(...(await checkStaleProposals(ctx)));

    if (alerts.length === 0) {
      success('All checks healthy.');
      ctx.log.info('watchdog: healthy');
      return { alerts: [], healthy: true };
    }

    for (const alert of alerts) {
      failure(alert.message);
      ctx.log.warn(`watchdog alert [${alert.kind}]: ${alert.message}`);
    }

    const author = getAuthor(ctx.config, ctx.config.default_author);
    const to = options.email || author.email;
    await notify(ctx.env, ctx.log, {
      subject: `Watchdog: ${alerts.length} issue${alerts.length === 1 ? '' : 's'} for ${ctx.tenant}`,
      body: [
        `Watchdog run ${today} for tenant "${ctx.tenant}".`,
        '',
        ...alerts.map((a, i) => `${i + 1}. [${a.kind}] ${a.message}`),
        '',
        `Sheet: ${ctx.sheet.label}`,
        `Log:   ${ctx.log.logPath}`,
      ].join('\n'),
      ...(to ? { to } : {}),
    });

    return { alerts, healthy: false };
  } finally {
    await ctx.log.flush();
  }
}

/** Did each job write a completion heartbeat to today's log? */
async function checkHeartbeats(
  ctx: RunContext,
  jobs: string[],
  now: Date,
): Promise<WatchdogAlert[]> {
  const alerts: WatchdogAlert[] = [];

  for (const job of jobs) {
    const path = TenantPaths.log(ctx.tenant, logFileName(job, now));
    if (!(await ctx.storage.exists(path))) {
      alerts.push({
        kind: 'missing-heartbeat',
        message: `Daily ${job} did not run — no log at ${path}`,
      });
      continue;
    }
    const contents = await ctx.storage.readFile(path);
    if (!contents.includes(HEARTBEAT)) {
      alerts.push({
        kind: 'missing-heartbeat',
        message: `Daily ${job} started but did not complete — no heartbeat in ${path}`,
      });
      continue;
    }
    info(`${style.green('✔')} ${job} heartbeat present`);
  }
  return alerts;
}

/** EDITIONS rows sitting in DRAFT longer than the configured window. */
async function checkStaleDrafts(ctx: RunContext, now: Date): Promise<WatchdogAlert[]> {
  const limitDays = ctx.config.oracle.stale_draft_days;
  const editions = await ctx.sheet.readEditions();
  const alerts: WatchdogAlert[] = [];

  for (const edition of editions) {
    if (edition.status !== 'DRAFT') continue;
    // Date-Published is empty for a draft, so age comes from the anchor ID's
    // date segment — the day the draft was created.
    const created = dateFromAnchorId(edition.edition);
    if (!created) continue;
    const ageDays = Math.floor((now.getTime() - created.getTime()) / 86_400_000);
    if (ageDays > limitDays) {
      alerts.push({
        kind: 'stale-draft',
        message: `Stale draft needs approval: ${edition.edition} "${edition.topic}" — ${ageDays} days in DRAFT`,
      });
    }
  }
  if (alerts.length === 0) info(`${style.green('✔')} no drafts stuck over ${limitDays} days`);
  return alerts;
}

/** Derived assets nobody has triaged. */
async function checkStaleProposals(ctx: RunContext): Promise<WatchdogAlert[]> {
  const assets = await ctx.sheet.readRepurposing();
  const proposed = assets.filter((a) => a.status === 'PROPOSED');
  if (proposed.length === 0) {
    info(`${style.green('✔')} no untriaged asset proposals`);
    return [];
  }

  const byAnchor = new Map<string, number>();
  for (const asset of proposed) byAnchor.set(asset.anchor_id, (byAnchor.get(asset.anchor_id) ?? 0) + 1);

  // Only worth an alert once it has genuinely piled up.
  if (byAnchor.size < 3) {
    info(`${style.green('✔')} ${proposed.length} proposed assets across ${byAnchor.size} anchors`);
    return [];
  }

  return [
    {
      kind: 'stale-proposal',
      message:
        `${proposed.length} derived assets still PROPOSED across ${byAnchor.size} anchors — ` +
        'review REPURPOSING and mark them APPROVED or drop them',
    },
  ];
}

/** ABD-ARTICLE-20260815-001 -> 2026-08-15 */
export function dateFromAnchorId(anchorId: string): Date | null {
  const match = /-(\d{4})(\d{2})(\d{2})-\d+$/.exec(anchorId.trim());
  if (!match) return null;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
