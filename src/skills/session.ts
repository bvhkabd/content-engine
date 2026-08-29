/**
 * `content-engine session` — one full session: interview → write → critic →
 * approve → bundle.
 *
 * Workflow per CLAUDE_CODE_BRIEF.md § src/skills/session.ts. Every artefact is
 * written to the data layer as soon as it exists, so a crash or a Ctrl-C after
 * the writer never loses the draft.
 */

import { createContext, type RunContext } from '../config/context.js';
import { createLlmClient, type LlmClient } from '../engine/llm.js';
import { criticizeArticle } from '../engine/critic.js';
import { generateInterviewGuide, reviseArticle, writeArticle } from '../engine/writer.js';
import { interviewFileName, isoDate, nextAnchorId } from '../engine/ids.js';
import { loadBrandContext, type BrandContext } from '../config/tenant.js';
import { TenantPaths } from '../io/storage.js';
import {
  SCHEMA_VERSION,
  overallCriticScore,
  type CriticReport,
  type DraftArtefact,
  type InterviewTranscript,
  type SpikeRecord,
} from '../schemas/contracts.js';
import { serialiseCriticReport, serialiseDraftArtefact, serialiseFrontmatter } from '../schemas/markdown.js';
import {
  askMultiline,
  choose,
  confirm,
  failure,
  heading,
  info,
  isInteractive,
  renderCriticReport,
  step,
  style,
  success,
  warn,
} from '../ui/console.js';
import {
  loadInterview,
  loadSpike,
  saveCriticReport,
  saveDraft,
  saveInterview,
} from './shared.js';
import { runBundleStep } from './bundle-step.js';

export interface SessionOptions {
  tenant: string;
  spikeId: string;
  author?: string;
  brand?: string;
  channel?: string;
  /** Generate an interview guide and stop. */
  guide?: boolean;
  /** Skip the bundle step; run `approve` later. */
  noBundle?: boolean;
  /** Accept the first draft without prompting (for unattended runs). */
  yes?: boolean;
}

export interface SessionResult {
  draft: DraftArtefact;
  criticReport: CriticReport;
  outcome: 'approved' | 'rejected' | 'exhausted' | 'guide-only';
  bundled: boolean;
}

export async function runSession(options: SessionOptions): Promise<SessionResult> {
  const ctx = await createContext(options.tenant, { job: 'session' });
  const now = new Date();

  try {
    // 1-2. Config and spike.
    const spike = await loadSpike(ctx, options.spikeId);
    const brandKey = options.brand ?? spike.brand ?? ctx.config.active_brands[0]!;
    const authorKey = options.author ?? spike.author ?? ctx.config.default_author;
    const channelKey = options.channel ?? ctx.config.default_channel;
    const brandContext = await loadBrandContext(ctx.config, ctx.storage, brandKey, authorKey, channelKey);

    heading(`Session — ${spike.spike_id}`);
    info(`${style.dim('Topic: ')}${spike.topic}`);
    info(`${style.dim('Angle: ')}${spike.angle}`);
    info(
      `${style.dim('Brand: ')}${brandContext.brand.name}  ${style.dim('Author: ')}${brandContext.author.name}  ` +
        `${style.dim('Channel: ')}${brandContext.channel.name}`,
    );
    warnOnThinReferences(brandContext);

    const llm = createLlmClient(ctx.env, 'run a session');
    info(`${style.dim('Model: ')}${llm.model}\n`);

    // 3. Interview ready?
    if (options.guide) {
      await writeInterviewGuide(ctx, spike, brandContext, llm, now);
      return guideOnlyResult();
    }

    const haveInterview = await interviewExists(ctx, spike.spike_id);
    if (!haveInterview) {
      warn(`No interview transcript found for ${spike.spike_id}.`);
      if (isInteractive() && (await confirm('Generate an interview guide to answer?', true))) {
        await writeInterviewGuide(ctx, spike, brandContext, llm, now);
        return guideOnlyResult();
      }
      throw new Error(
        `No interview transcript for ${spike.spike_id}. Add one at ` +
          `${TenantPaths.interviews(ctx.tenant)}/${spike.spike_id}-${authorKey}-${isoDate(now)}.md, ` +
          'or re-run with --guide to generate the questions first.',
      );
    }

    if (!options.yes && isInteractive()) {
      const ready = await confirm('Interview ready?', true);
      if (!ready) {
        info('Stopping. Finish the transcript and re-run this command.');
        return guideOnlyResult();
      }
    }

    // 4. Read the transcript.
    const { interview, filename } = await loadInterview(ctx, spike.spike_id);
    step(`Interview: ${filename} (${interview.qa.length} Q/A pairs)`);

    // 5. Write.
    const anchorId = nextAnchorId(
      await ctx.storage.list(TenantPaths.drafts(ctx.tenant)),
      brandContext.brand,
      brandContext.channel,
      now,
    );
    step(`Writing draft ${anchorId} v1…`);
    let draft = await writeArticle(interview, ctx.config, spike, brandContext, llm, {
      anchorId,
      version: 1,
    });
    await saveDraft(ctx, draft, serialiseDraftArtefact(draft));
    success(`Draft v1: ${style.bold(draft.title)} (${wordCount(draft.body)} words)`);

    // 6-12. Critic and the approve/revise/reject loop.
    const loop = await criticLoop(ctx, draft, interview, spike, brandContext, llm, options);
    draft = loop.draft;

    if (loop.outcome === 'rejected') {
      await ctx.sheet.updateVaultRow(spike.spike_id, {
        status: 'KILLED',
        notes: appendNote(spike.notes, `Killed at session ${ctx.log.runId}`),
      });
      ctx.log.info(`spike ${spike.spike_id} -> KILLED`);
      failure(`Spike ${spike.spike_id} marked KILLED. Draft kept at ${TenantPaths.draft(ctx.tenant, draft.anchor_id, draft.version)}.`);
      return { draft, criticReport: loop.report, outcome: 'rejected', bundled: false };
    }

    if (loop.outcome === 'exhausted') {
      await ctx.sheet.updateVaultRow(spike.spike_id, {
        status: 'INTERVIEWED',
        used_in: draft.anchor_id,
        notes: appendNote(spike.notes, `Revise limit reached at v${draft.version}`),
      });
      warn(
        `Hit the revise limit (${ctx.config.critic.max_revise_cycles}) without a PASS. ` +
          `Draft v${draft.version} and its critic report are saved — edit by hand, then run \`approve\`.`,
      );
      return { draft, criticReport: loop.report, outcome: 'exhausted', bundled: false };
    }

    // 10. Approved.
    await ctx.sheet.updateVaultRow(spike.spike_id, {
      status: 'DRAFTED',
      used_in: draft.anchor_id,
      notes: appendNote(spike.notes, `Drafted ${isoDate(now)} as ${draft.anchor_id} v${draft.version}`),
    });
    ctx.log.info(`spike ${spike.spike_id} -> DRAFTED (${draft.anchor_id} v${draft.version})`);
    success(`Spike ${spike.spike_id} → DRAFTED`);

    // 13-15. Bundle.
    if (options.noBundle) {
      info(
        style.dim(
          `Skipping bundle. Run: npm run cli -- approve --tenant ${ctx.tenant} --draft ${draft.anchor_id}`,
        ),
      );
      return { draft, criticReport: loop.report, outcome: 'approved', bundled: false };
    }

    heading('Bundle');
    await runBundleStep(ctx, draft, interview, brandContext, llm, spike.topic, now);
    printWhereThingsAre(ctx, draft);

    return { draft, criticReport: loop.report, outcome: 'approved', bundled: true };
  } finally {
    await ctx.log.flush();
  }
}

// ---------------------------------------------------------------------------
// The critic / revise loop
// ---------------------------------------------------------------------------

interface LoopResult {
  draft: DraftArtefact;
  report: CriticReport;
  outcome: 'approved' | 'rejected' | 'exhausted';
}

async function criticLoop(
  ctx: RunContext,
  initialDraft: DraftArtefact,
  interview: InterviewTranscript,
  spike: SpikeRecord,
  brandContext: BrandContext,
  llm: LlmClient,
  options: SessionOptions,
): Promise<LoopResult> {
  const maxCycles = Math.max(1, ctx.config.critic.max_revise_cycles);
  let draft = initialDraft;
  let report: CriticReport;

  for (let cycle = 0; ; cycle++) {
    step(`Running critic on v${draft.version}…`);
    report = await criticizeArticle(draft, ctx.config, interview, brandContext, llm);
    await saveCriticReport(ctx, report, serialiseCriticReport(report));

    heading(`Critic report — ${draft.anchor_id} v${draft.version}`);
    info(renderCriticReport(report, ctx.config.critic.pass_score));
    ctx.log.info(
      `critic v${draft.version}: ${report.verdict} overall=${overallCriticScore(report)} ` +
        `flags=${report.outstanding_criticisms.length}`,
    );

    // A redline breach is not a revise-loop problem.
    if (report.verdict === 'FAIL-AUTOMATIC') {
      failure('FAIL-AUTOMATIC — boundary breach. This does not go to revision.');
      const kill = options.yes ? true : await confirm('Mark the spike KILLED?', true);
      if (kill) return { draft, report, outcome: 'rejected' };
    }

    // Unattended: accept a PASS, stop on anything else.
    if (options.yes || !isInteractive()) {
      if (report.verdict === 'PASS') return { draft, report, outcome: 'approved' };
      if (cycle >= maxCycles - 1) return { draft, report, outcome: 'exhausted' };
      step(`Auto-revising (cycle ${cycle + 1}/${maxCycles})…`);
      draft = await reviseAndSave(ctx, draft, report, interview, spike, brandContext, llm, '');
      continue;
    }

    console.log('');
    const decision = await choose('Approve?', ['yes', 'revise', 'reject'] as const, 'revise');

    if (decision === 'yes') return { draft, report, outcome: 'approved' };
    if (decision === 'reject') return { draft, report, outcome: 'rejected' };

    if (cycle >= maxCycles - 1) {
      warn(`Revise limit reached (${maxCycles} cycles).`);
      return { draft, report, outcome: 'exhausted' };
    }

    info(
      style.dim(
        `You can also edit ${TenantPaths.draft(ctx.tenant, draft.anchor_id, draft.version)} directly, ` +
          'then re-run with `approve`.',
      ),
    );
    const notes = await askMultiline('Notes for the rewrite (blank = just fix the critic flags):');
    step(`Revising to v${draft.version + 1} (cycle ${cycle + 1}/${maxCycles})…`);
    draft = await reviseAndSave(ctx, draft, report, interview, spike, brandContext, llm, notes);
  }
}

async function reviseAndSave(
  ctx: RunContext,
  draft: DraftArtefact,
  report: CriticReport,
  interview: InterviewTranscript,
  spike: SpikeRecord,
  brandContext: BrandContext,
  llm: LlmClient,
  notes: string,
): Promise<DraftArtefact> {
  const revised = await reviseArticle(
    draft,
    report,
    interview,
    ctx.config,
    spike,
    brandContext,
    llm,
    notes,
  );
  await saveDraft(ctx, revised, serialiseDraftArtefact(revised));
  success(`Draft v${revised.version} written (${wordCount(revised.body)} words)`);
  return revised;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function interviewExists(ctx: RunContext, spikeId: string): Promise<boolean> {
  const files = await ctx.storage.list(TenantPaths.interviews(ctx.tenant));
  return files.some((f) => f.startsWith(`${spikeId}-`) && f.endsWith('.md'));
}

/** Write a question-only transcript stub for the author to answer. */
async function writeInterviewGuide(
  ctx: RunContext,
  spike: SpikeRecord,
  brandContext: BrandContext,
  llm: LlmClient,
  now: Date,
): Promise<void> {
  step('Generating interview guide…');
  const guide = await generateInterviewGuide(spike, ctx.config, brandContext, llm);

  const filename = interviewFileName(spike.spike_id, brandContext.author.key, now);
  const content = serialiseFrontmatter(
    {
      spike_id: spike.spike_id,
      tenant: ctx.tenant,
      brand: brandContext.brand.key,
      author: brandContext.author.key,
      date: isoDate(now),
      schema_version: SCHEMA_VERSION,
    },
    `${guide.trim()}\n`,
  );

  const path = TenantPaths.interview(ctx.tenant, filename);
  if (await ctx.storage.exists(path)) {
    warn(`${path} already exists — not overwriting. Guide printed below instead.\n`);
    console.log(guide);
    return;
  }

  await saveInterview(ctx, filename, content);
  await ctx.sheet.updateVaultRow(spike.spike_id, { status: 'SHORTLISTED' });

  success(`Interview guide: ${path}`);
  info('');
  info('Next: answer each question by adding an `A:` line under it (Wispr, typing, whatever), then run:');
  info(`  npm run cli -- session --tenant ${ctx.tenant} --spike ${spike.spike_id}`);
}

function guideOnlyResult(): SessionResult {
  // The caller only reads `outcome` on this path.
  return {
    draft: null as unknown as DraftArtefact,
    criticReport: null as unknown as CriticReport,
    outcome: 'guide-only',
    bundled: false,
  };
}

function warnOnThinReferences(ctx: BrandContext): void {
  const missing: string[] = [];
  if (!ctx.voice) missing.push(ctx.brand.voice_file);
  if (!ctx.redlines) missing.push(ctx.brand.redlines_file);
  if (!ctx.ctas) missing.push(ctx.brand.ctas_file);
  if (missing.length) {
    warn(`Running with thin guidance — empty or missing: ${missing.join(', ')}`);
  }
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function appendNote(existing: string, note: string): string {
  return existing.trim() ? `${existing.trim()} | ${note}` : note;
}

function printWhereThingsAre(ctx: RunContext, draft: DraftArtefact): void {
  heading('Done');
  info(`Draft          ${TenantPaths.draft(ctx.tenant, draft.anchor_id, draft.version)}`);
  info(`Critic report  ${TenantPaths.criticReport(ctx.tenant, draft.anchor_id, draft.version)}`);
  info(`Sheet          ${ctx.sheet.label}`);
  info(`Log            ${ctx.log.logPath}`);
}
