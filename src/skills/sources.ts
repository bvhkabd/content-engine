/**
 * `content-engine sources` — probe each oracle source independently.
 *
 * The oracle deliberately swallows a failing source so one dead connection
 * cannot stop the run. That is right for a cron job and useless when you are
 * trying to wire credentials up, so this command does the opposite: it hits
 * each source on its own and reports exactly what came back.
 *
 * Read-only. Never writes to the sheet and never calls the LLM.
 */

import { createContext } from '../config/context.js';
import { expandSourceRefs } from '../jobs/oracle.js';
import { fetchPostIdeasEmails } from '../sources/subscriptions-inbox.js';
import { fetchFirefliesTranscripts, fetchTranscriptsFolder } from '../sources/transcripts.js';
import { fetchDossierMentions } from '../sources/dossiers.js';
import { TenantPaths, joinPath } from '../io/storage.js';
import { failure, heading, info, style, success, truncate, warn } from '../ui/console.js';

export interface SourcesOptions {
  tenant: string;
  sinceDays?: number;
  /** Probe only this source: inbox | transcripts | dossiers */
  only?: string;
}

interface Probe {
  name: string;
  configured: boolean;
  /** Why it is not configured, when it isn't. */
  blocker: string;
  run: () => Promise<{ reference: string; title: string; chars: number }[]>;
}

export async function runSources(options: SourcesOptions): Promise<boolean> {
  const ctx = await createContext(options.tenant, { job: 'sources' });
  const sinceDays = options.sinceDays ?? 7;

  try {
    heading(`Sources — ${ctx.tenant}`);
    info(`${style.dim('Backend: ')}${ctx.env.storageBackend}   ${style.dim('Lookback: ')}${sinceDays} days`);

    const vault = await ctx.sheet.readVault();
    const seen = expandSourceRefs(vault);
    info(`${style.dim('Already in vault: ')}${seen.size} source reference(s)`);

    const probes = buildProbes(ctx, sinceDays);
    const selected = options.only
      ? probes.filter((p) => p.name.toLowerCase().includes(options.only!.toLowerCase()))
      : probes;

    if (selected.length === 0) {
      throw new Error(`No source matches "${options.only}". Try: ${probes.map((p) => p.name).join(', ')}`);
    }

    let anyFailed = false;
    let totalNew = 0;

    for (const probe of selected) {
      console.log('');
      info(style.bold(probe.name));

      if (!probe.configured) {
        warn(`skipped — ${probe.blocker}`);
        continue;
      }

      try {
        const docs = await probe.run();
        const fresh = docs.filter((d) => !seen.has(d.reference.trim()));
        totalNew += fresh.length;

        if (docs.length === 0) {
          info(style.dim('  connected, nothing found in the window'));
        } else {
          success(`  ${docs.length} document(s), ${fresh.length} new to the oracle`);
          for (const doc of docs.slice(0, 5)) {
            const flag = seen.has(doc.reference.trim()) ? style.dim('seen') : style.green('new');
            info(`    ${flag}  ${truncate(doc.title, 58)}  ${style.dim(`${doc.chars} chars`)}`);
            info(`          ${style.dim(truncate(doc.reference, 70))}`);
          }
          if (docs.length > 5) info(style.dim(`    …and ${docs.length - 5} more`));
        }
      } catch (error) {
        anyFailed = true;
        failure(`  ${(error as Error).message}`);
        ctx.log.warn(`source probe ${probe.name} failed: ${(error as Error).message}`);
      }
    }

    console.log('');
    if (anyFailed) {
      warn('At least one source failed. The oracle would skip it and carry on.');
    } else {
      success(`All probed sources reachable. ${totalNew} new document(s) waiting for the oracle.`);
    }
    if (totalNew > 0) {
      info(style.dim(`Next:  npm run cli -- oracle --tenant ${ctx.tenant} --dry-run`));
    }

    return !anyFailed;
  } finally {
    await ctx.log.flush();
  }
}

function buildProbes(ctx: Awaited<ReturnType<typeof createContext>>, sinceDays: number): Probe[] {
  const { sources } = ctx.config;

  return [
    {
      name: 'inbox (Gmail)',
      configured: sources.subscriptions_inbox.enabled && Boolean(ctx.env.gmailAppPassword),
      blocker: !sources.subscriptions_inbox.enabled
        ? 'sources.subscriptions_inbox.enabled is false, or no email set in tenant.yaml'
        : 'GMAIL_APP_PASSWORD is not set in .env',
      run: async () => {
        const { email, label, min_words, exclude_senders } = sources.subscriptions_inbox;
        const messages = await fetchPostIdeasEmails({
          email,
          appPassword: ctx.env.gmailAppPassword!,
          label,
          sinceDays,
          minWords: min_words,
          excludeSenders: exclude_senders,
          onSkip: (reason) => info(`    ${style.dim(`skipped: ${reason}`)}`),
        });
        return messages.map((m) => ({
          reference: m.messageId,
          title: `${m.subject}  ${style.dim(`— ${m.from}`)}`,
          chars: m.body.length,
        }));
      },
    },
    {
      name:
        sources.transcripts.type === 'fireflies'
          ? 'transcripts (Fireflies)'
          : `transcripts (folder: ${TenantPaths.transcriptsIn(ctx.tenant)})`,
      configured:
        sources.transcripts.enabled &&
        (sources.transcripts.type !== 'fireflies' || Boolean(ctx.env.firefliesApiKey)),
      blocker: !sources.transcripts.enabled
        ? 'sources.transcripts.enabled is false in tenant.yaml'
        : 'FIREFLIES_API_KEY is not set in .env',
      run: async () => {
        const items =
          sources.transcripts.type === 'fireflies'
            ? await fetchFirefliesTranscripts(ctx.env.firefliesApiKey!, sinceDays)
            : await fetchTranscriptsFolder(ctx.storage, ctx.tenant);
        return items.map((t) => ({
          reference: t.filename,
          title: t.filename,
          chars: t.content.length,
        }));
      },
    },
    {
      name: `dossiers (${joinPath(ctx.tenant, ctx.config.sources.dossiers.folder_id || 'dossiers')})`,
      configured: sources.dossiers.enabled,
      blocker: 'sources.dossiers.enabled is false in tenant.yaml',
      run: async () => {
        const found = await fetchDossierMentions(
          ctx.storage,
          ctx.tenant,
          sources.dossiers.folder_id || 'dossiers',
          sources.dossiers.keywords,
        );
        return found.map((d) => ({
          reference: d.docName,
          title: `${d.docName}  ${style.dim(`(${d.mentions.length} mention block(s))`)}`,
          chars: d.mentions.join('').length,
        }));
      },
    },
  ];
}
