/**
 * `content-engine approve` — approve an existing draft and generate its bundle.
 *
 * Use when a session ended without bundling, or after editing a draft by hand.
 * Re-running is safe: the EDITIONS row is updated rather than duplicated.
 */

import { createContext } from '../config/context.js';
import { createLlmClient } from '../engine/llm.js';
import { isoDate } from '../engine/ids.js';
import { loadBrandContext } from '../config/tenant.js';
import { overallCriticScore, type DerivedAsset, type DraftArtefact } from '../schemas/contracts.js';
import {
  confirm,
  heading,
  info,
  isInteractive,
  renderCriticReport,
  step,
  style,
  success,
  warn,
} from '../ui/console.js';
import { loadCriticReport, loadDraft, loadInterview, loadSpike } from './shared.js';
import { runBundleStep } from './bundle-step.js';

export interface ApproveOptions {
  tenant: string;
  anchorId: string;
  version?: number;
  /** Skip confirmation prompts. */
  yes?: boolean;
}

export interface ApproveResult {
  draft: DraftArtefact;
  assets: DerivedAsset[];
}

export async function runApprove(options: ApproveOptions): Promise<ApproveResult> {
  const ctx = await createContext(options.tenant, { job: 'approve' });
  const now = new Date();

  try {
    const { draft, version, path } = await loadDraft(ctx, options.anchorId, options.version);
    heading(`Approve — ${draft.anchor_id} v${version}`);
    info(`${style.dim('Title: ')}${draft.title}`);
    info(`${style.dim('File:  ')}${path}`);

    const spike = await loadSpike(ctx, draft.spike_id);
    const { interview } = await loadInterview(ctx, draft.spike_id);
    const brandContext = await loadBrandContext(
      ctx.config,
      ctx.storage,
      draft.brand,
      draft.author,
      draft.channel,
    );

    // Show the critic verdict before committing, if one exists for this version.
    const report = await loadCriticReport(ctx, draft.anchor_id, version);
    if (report) {
      console.log('');
      info(renderCriticReport(report, ctx.config.critic.pass_score));
      if (report.verdict === 'FAIL-AUTOMATIC') {
        warn('This version was a FAIL-AUTOMATIC (boundary breach) when it was last critiqued.');
      }
    } else {
      warn(`No critic report on file for v${version} — approving an uncritiqued draft.`);
    }

    if (!options.yes && isInteractive()) {
      console.log('');
      const proceed = await confirm(`Approve v${version} and generate the bundle?`, report?.verdict === 'PASS');
      if (!proceed) {
        info('Nothing changed.');
        return { draft, assets: [] };
      }
    }

    const llm = createLlmClient(ctx.env, 'generate the asset bundle');
    step(`Model: ${llm.model}`);

    if (spike.status !== 'DRAFTED' && spike.status !== 'USED') {
      await ctx.sheet.updateVaultRow(spike.spike_id, {
        status: 'DRAFTED',
        used_in: draft.anchor_id,
      });
      ctx.log.info(`spike ${spike.spike_id} -> DRAFTED`);
      success(`Spike ${spike.spike_id} → DRAFTED`);
    }

    heading('Bundle');
    const result = await runBundleStep(ctx, draft, interview, brandContext, llm, spike.topic, now);

    ctx.log.info(
      `approve complete: ${draft.anchor_id} v${version}, ${result.assets.length} assets, ` +
        `critic=${report ? `${report.verdict}/${overallCriticScore(report)}` : 'none'}`,
    );

    heading('Done');
    info(`Sheet  ${ctx.sheet.label}`);
    info(`Log    ${ctx.log.logPath}`);
    info(style.dim(`Review the PROPOSED rows in REPURPOSING, then mark the ones you want APPROVED.`));
    info(style.dim(`Bundled ${isoDate(now)}.`));

    return { draft, assets: result.assets };
  } finally {
    await ctx.log.flush();
  }
}
