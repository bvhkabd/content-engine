/**
 * Loading helpers shared by the skills. These sit between the raw storage
 * adapters and the skills, and are the only place that knows how to find a
 * spike, an interview or a draft by ID.
 */

import type { RunContext } from '../config/context.js';
import { TenantPaths } from '../io/storage.js';
import { findInterviewFiles, latestVersion } from '../engine/ids.js';
import { parseCriticReport, parseDraftArtefact, parseInterviewTranscript } from '../schemas/markdown.js';
import {
  assertValid,
  validateInterviewTranscript,
  validateSpikeRecord,
  type CriticReport,
  type DraftArtefact,
  type InterviewTranscript,
  type SpikeRecord,
} from '../schemas/contracts.js';

export async function loadSpike(ctx: RunContext, spikeId: string): Promise<SpikeRecord> {
  const vault = await ctx.sheet.readVault();
  const spike = vault.find((s) => s.spike_id.trim() === spikeId.trim());
  if (!spike) {
    const available = vault
      .filter((s) => s.status !== 'KILLED' && s.status !== 'USED')
      .slice(-8)
      .map((s) => `  ${s.spike_id}  ${s.status.padEnd(12)} ${s.topic}`)
      .join('\n');
    throw new Error(
      `Spike "${spikeId}" not found in ${ctx.sheet.label} VAULT.` +
        (available ? `\n\nRecent live spikes:\n${available}` : '\n\nThe VAULT is empty — run `oracle` first.'),
    );
  }
  const validation = validateSpikeRecord(spike);
  if (!validation.ok) {
    // A malformed row still names a real idea; warn rather than refuse to work.
    ctx.log.warn(`Spike ${spikeId} has contract problems: ${validation.errors.join('; ')}`);
  }
  return spike;
}

export interface LoadedInterview {
  interview: InterviewTranscript;
  filename: string;
}

/**
 * Find the interview transcript for a spike. Multiple files for one spike
 * (a re-interview) resolve to the newest by filename, which sorts by date.
 */
export async function loadInterview(ctx: RunContext, spikeId: string): Promise<LoadedInterview> {
  const dir = TenantPaths.interviews(ctx.tenant);
  const files = findInterviewFiles(await ctx.storage.list(dir), spikeId);

  if (files.length === 0) {
    throw new Error(
      `No interview transcript found for ${spikeId}.\n` +
        `Expected a file matching ${dir}/${spikeId}-{author}-{date}.md in ${ctx.storage.label}.\n` +
        `Run \`session --tenant ${ctx.tenant} --spike ${spikeId} --guide\` to generate an interview guide to answer.`,
    );
  }

  const filename = files[files.length - 1]!;
  const raw = await ctx.storage.readFile(`${dir}/${filename}`);
  const interview = parseInterviewTranscript(raw, `${dir}/${filename}`);

  // Frontmatter is often omitted when a transcript is pasted in by hand.
  if (!interview.spike_id) interview.spike_id = spikeId;
  if (!interview.tenant) interview.tenant = ctx.tenant;

  assertValid(validateInterviewTranscript(interview), `Interview ${filename}`);
  if (files.length > 1) {
    ctx.log.info(`${files.length} transcripts for ${spikeId}; using the newest (${filename})`);
  }
  return { interview, filename };
}

export async function saveInterview(
  ctx: RunContext,
  filename: string,
  content: string,
): Promise<string> {
  const path = TenantPaths.interview(ctx.tenant, filename);
  await ctx.storage.writeFile(path, content);
  ctx.log.info(`wrote interview ${path}`);
  return path;
}

export async function saveDraft(ctx: RunContext, draft: DraftArtefact, content: string): Promise<string> {
  const path = TenantPaths.draft(ctx.tenant, draft.anchor_id, draft.version);
  await ctx.storage.writeFile(path, content);
  ctx.log.info(`wrote draft ${path}`);
  return path;
}

export async function saveCriticReport(
  ctx: RunContext,
  report: CriticReport,
  content: string,
): Promise<string> {
  const path = TenantPaths.criticReport(ctx.tenant, report.anchor_id, report.version);
  await ctx.storage.writeFile(path, content);
  ctx.log.info(`wrote critic report ${path}`);
  return path;
}

export interface LoadedDraft {
  draft: DraftArtefact;
  version: number;
  path: string;
}

/** Load a draft by anchor ID, defaulting to the highest version on disk. */
export async function loadDraft(
  ctx: RunContext,
  anchorId: string,
  version?: number,
): Promise<LoadedDraft> {
  const dir = TenantPaths.drafts(ctx.tenant);
  const files = await ctx.storage.list(dir);
  const resolved = version ?? latestVersion(files, anchorId);

  if (resolved === 0) {
    const known = [...new Set(files.map((f) => f.replace(/-v\d+\.md$/, '')))].slice(-8);
    throw new Error(
      `No draft found for "${anchorId}" in ${dir}.` +
        (known.length ? `\n\nDrafts on hand:\n${known.map((k) => `  ${k}`).join('\n')}` : ''),
    );
  }

  const path = TenantPaths.draft(ctx.tenant, anchorId, resolved);
  if (!(await ctx.storage.exists(path))) {
    throw new Error(`Draft ${anchorId} v${resolved} not found at ${path}`);
  }
  return { draft: parseDraftArtefact(await ctx.storage.readFile(path), path), version: resolved, path };
}

/** The critic report matching a draft version, if one was written. */
export async function loadCriticReport(
  ctx: RunContext,
  anchorId: string,
  version: number,
): Promise<CriticReport | null> {
  const path = TenantPaths.criticReport(ctx.tenant, anchorId, version);
  if (!(await ctx.storage.exists(path))) return null;
  return parseCriticReport(await ctx.storage.readFile(path), path);
}
