/**
 * Writer — interview transcript in, Contract 3 draft out.
 */

import { SCHEMA_VERSION, assertValid, validateDraftArtefact } from '../schemas/contracts.js';
import type {
  CriticReport,
  DraftArtefact,
  InterviewTranscript,
  ProvenanceEntry,
  SpikeRecord,
} from '../schemas/contracts.js';
import type { BrandContext, TenantConfig } from '../config/tenant.js';
import { interviewPrompt, revisePrompt, systemPrompt, writeDraftPrompt } from '../prompts/writer.js';
import type { LlmClient } from './llm.js';

interface DraftPayload {
  title?: unknown;
  body?: unknown;
  provenance?: unknown;
  chosen_cta?: unknown;
}

export interface WriteOptions {
  anchorId: string;
  version: number;
  temperature?: number;
}

/**
 * Generate the first draft.
 *
 * Signature follows CLAUDE_CODE_BRIEF.md § src/engine, with the brand context
 * and LLM client passed in rather than constructed here — the engine does no
 * I/O of its own.
 */
export async function writeArticle(
  interview: InterviewTranscript,
  tenant: TenantConfig,
  spike: SpikeRecord,
  ctx: BrandContext,
  llm: LlmClient,
  options: WriteOptions,
): Promise<DraftArtefact> {
  const payload = await llm.json<DraftPayload>(
    writeDraftPrompt(interview, spike, ctx),
    systemPrompt(tenant, ctx),
    { temperature: options.temperature ?? 0.7 },
  );
  return toDraft(payload, spike, ctx, options);
}

/** Apply critic feedback plus any operator notes, producing version n+1. */
export async function reviseArticle(
  draft: DraftArtefact,
  report: CriticReport,
  interview: InterviewTranscript,
  tenant: TenantConfig,
  spike: SpikeRecord,
  ctx: BrandContext,
  llm: LlmClient,
  operatorNotes: string,
): Promise<DraftArtefact> {
  const payload = await llm.json<DraftPayload>(
    revisePrompt(draft, report, interview, ctx, operatorNotes),
    systemPrompt(tenant, ctx),
    { temperature: 0.6 }, // tighter than first draft: this is repair, not invention
  );
  return toDraft(payload, spike, ctx, { anchorId: draft.anchor_id, version: draft.version + 1 });
}

/** Generate an interview guide for a spike (used by `session --guide`). */
export async function generateInterviewGuide(
  spike: SpikeRecord,
  tenant: TenantConfig,
  ctx: BrandContext,
  llm: LlmClient,
): Promise<string> {
  return llm.complete(interviewPrompt(spike, tenant, ctx), systemPrompt(tenant, ctx), {
    temperature: 0.8,
  });
}

// ---------------------------------------------------------------------------

function toDraft(
  payload: DraftPayload,
  spike: SpikeRecord,
  ctx: BrandContext,
  options: WriteOptions,
): DraftArtefact {
  const draft: DraftArtefact = {
    anchor_id: options.anchorId,
    spike_id: spike.spike_id,
    brand: ctx.brand.key,
    author: ctx.author.key,
    channel: ctx.channel.key,
    version: options.version,
    schema_version: SCHEMA_VERSION,
    title: String(payload.title ?? '').trim(),
    body: stripLeadingH1(String(payload.body ?? '').trim()),
    provenance: normaliseProvenance(payload.provenance),
    chosen_cta: String(payload.chosen_cta ?? '').trim(),
  };

  assertValid(validateDraftArtefact(draft), `Draft ${options.anchorId} v${options.version}`);
  return draft;
}

/** Models often repeat the title as an H1 despite being told not to. */
function stripLeadingH1(body: string): string {
  return body.replace(/^#\s+.+\n+/, '').trim();
}

function normaliseProvenance(value: unknown): ProvenanceEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ProvenanceEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const claim = String(entry.claim ?? '').trim();
    const ref = String(entry.passage_ref ?? entry.passageRef ?? '').trim();
    if (claim && ref) entries.push({ claim, passage_ref: ref });
  }
  return entries;
}
