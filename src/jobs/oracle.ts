/**
 * `content-engine oracle` — headless daily job. SCAN + ID only.
 *
 * Reads the configured sources, extracts candidate spikes, scores them, and
 * appends the new ones to the VAULT with status NEW. It never writes drafts and
 * never touches an existing spike.
 *
 * Source failures are logged and skipped: one broken IMAP connection must not
 * stop the transcript scan.
 */

import { createContext, type RunContext } from '../config/context.js';
import { heartbeatLine } from '../io/logger.js';
import { notify } from '../io/notify.js';
import { TenantPaths } from '../io/storage.js';
import { nextSpikeIds } from '../engine/ids.js';
import { createLlmClient } from '../engine/llm.js';
import { rankSpikes, topSpikes, vaultTopics, type CandidateSpike, type ScoredSpike } from '../engine/scoring.js';
import { extractSpikesPrompt, oracleSystemPrompt, type SourceItem } from '../prompts/oracle.js';
import { SCHEMA_VERSION, assertValid, validateSpikeRecord, type SpikeRecord } from '../schemas/contracts.js';
import { fetchPostIdeasEmails, toSourceDocuments as emailDocs } from '../sources/subscriptions-inbox.js';
import {
  fetchFirefliesTranscripts,
  fetchTranscriptsFolder,
  toSourceDocuments as transcriptDocs,
} from '../sources/transcripts.js';
import { fetchDossierMentions, toSourceDocuments as dossierDocs } from '../sources/dossiers.js';
import type { SourceDocument } from '../sources/types.js';
import { getAuthor } from '../config/tenant.js';
import { heading, info, step, style, success, warn } from '../ui/console.js';
import YAML from 'yaml';

export interface OracleOptions {
  tenant: string;
  /** Extract and score, but write nothing. */
  dryRun?: boolean;
  /** Lookback window for email and Fireflies. */
  sinceDays?: number;
}

export interface OracleResult {
  scanned: number;
  found: number;
  appended: number;
  spikes: SpikeRecord[];
}

/** Returns the count of new spikes, per CLAUDE_CODE_BRIEF.md § src/jobs/oracle.ts */
export async function dailyOracle(options: OracleOptions): Promise<OracleResult> {
  const ctx = await createContext(options.tenant, { job: 'oracle', echo: true });
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  try {
    heading(`Oracle — ${ctx.tenant} — ${today}`);

    const vault = await ctx.sheet.readVault();
    const seenRefs = new Set(vault.map((s) => s.source_ref.trim()).filter(Boolean));

    // 1. Gather.
    const documents = await gatherSources(ctx, options, seenRefs);
    ctx.log.info(`scanned ${documents.length} new source documents`);

    if (documents.length === 0) {
      success('No new source material.');
      await finish(ctx, now, { scanned: 0, found: 0, appended: 0, spikes: [] }, vault);
      return { scanned: 0, found: 0, appended: 0, spikes: [] };
    }
    step(`${documents.length} new documents: ${summariseKinds(documents)}`);

    // 2. Extract.
    const llm = createLlmClient(ctx.env, 'run the oracle');
    const candidates = await extractCandidates(ctx, documents, vault, llm);
    ctx.log.info(`extracted ${candidates.length} candidate spikes`);

    if (candidates.length === 0) {
      success('Nothing worth writing about in this batch.');
      await finish(ctx, now, { scanned: documents.length, found: 0, appended: 0, spikes: [] }, vault);
      return { scanned: documents.length, found: 0, appended: 0, spikes: [] };
    }

    // 3. Score and rank — deterministic, in engine/scoring.ts.
    const seasonal = await loadSeasonalKeywords(ctx, now);
    const ranked = rankSpikes(candidates, vaultTopics(vault), seasonal);
    step(`Scored ${ranked.length} candidates${seasonal.length ? ` (seasonal: ${seasonal.join(', ')})` : ''}`);

    // 4. Append.
    const author = ctx.config.default_author;
    const ids = nextSpikeIds(vault, now, ranked.length);
    const records = ranked.map((scored, i) => toSpikeRecord(scored, ids[i]!, today, author));

    if (options.dryRun) {
      warn('Dry run — nothing written to the sheet.');
      records.forEach((r, i) => info(`  ${r.score.toFixed(1).padStart(4)}  ${r.brand.padEnd(6)} ${r.topic}  ${style.dim(ranked[i]!.rationale)}`));
      await finish(ctx, now, { scanned: documents.length, found: records.length, appended: 0, spikes: records }, vault);
      return { scanned: documents.length, found: records.length, appended: 0, spikes: records };
    }

    let appended = 0;
    for (const record of records) {
      const validation = validateSpikeRecord(record);
      if (!validation.ok) {
        // Skip the bad row, keep the rest of the batch.
        ctx.log.warn(`skipping invalid spike "${record.topic}": ${validation.errors.join('; ')}`);
        continue;
      }
      await ctx.sheet.appendVaultRow(record);
      appended++;
    }
    success(`Appended ${appended} new spikes to VAULT (status NEW)`);
    records.slice(0, 10).forEach((r) => info(`  ${r.score.toFixed(1).padStart(4)}  ${r.brand.padEnd(6)} ${r.topic}`));

    const result = { scanned: documents.length, found: records.length, appended, spikes: records };
    await finish(ctx, now, result, [...vault, ...records]);
    return result;
  } catch (error) {
    ctx.log.error(`oracle failed: ${(error as Error).message}`);
    throw error;
  } finally {
    await ctx.log.flush();
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

async function gatherSources(
  ctx: RunContext,
  options: OracleOptions,
  seenRefs: Set<string>,
): Promise<SourceDocument[]> {
  const sinceDays = options.sinceDays ?? 7;
  const documents: SourceDocument[] = [];

  const readers: { name: string; enabled: boolean; run: () => Promise<SourceDocument[]> }[] = [
    {
      name: 'subscriptions-inbox',
      enabled: ctx.config.sources.subscriptions_inbox.enabled,
      run: async () => {
        const { email, label } = ctx.config.sources.subscriptions_inbox;
        const password = ctx.env.gmailAppPassword;
        if (!password) {
          throw new Error('GMAIL_APP_PASSWORD is not set');
        }
        return emailDocs(await fetchPostIdeasEmails({ email, appPassword: password, label, sinceDays }));
      },
    },
    {
      name: 'transcripts',
      enabled: ctx.config.sources.transcripts.enabled,
      run: async () => {
        if (ctx.config.sources.transcripts.type === 'fireflies') {
          const key = ctx.env.firefliesApiKey;
          if (!key) throw new Error('FIREFLIES_API_KEY is not set');
          return transcriptDocs(await fetchFirefliesTranscripts(key, sinceDays));
        }
        return transcriptDocs(await fetchTranscriptsFolder(ctx.storage, ctx.tenant));
      },
    },
    {
      name: 'dossiers',
      enabled: ctx.config.sources.dossiers.enabled,
      run: async () => {
        const { folder_id, keywords } = ctx.config.sources.dossiers;
        return dossierDocs(
          await fetchDossierMentions(ctx.storage, ctx.tenant, folder_id || 'dossiers', keywords),
        );
      },
    },
  ];

  for (const reader of readers) {
    if (!reader.enabled) {
      ctx.log.info(`source ${reader.name}: disabled`);
      continue;
    }
    try {
      const docs = await reader.run();
      const fresh = docs.filter((d) => !seenRefs.has(d.reference.trim()));
      ctx.log.info(`source ${reader.name}: ${docs.length} found, ${fresh.length} new`);
      documents.push(...fresh);
    } catch (error) {
      // One dead source must not kill the run.
      ctx.log.warn(`source ${reader.name} failed: ${(error as Error).message}`);
      warn(`Source "${reader.name}" failed: ${(error as Error).message}`);
    }
  }

  return documents;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface ExtractionPayload {
  spikes?: unknown;
}

/** Batch documents so one oversized prompt cannot swallow the whole run. */
const DOCS_PER_CALL = 4;

async function extractCandidates(
  ctx: RunContext,
  documents: SourceDocument[],
  vault: SpikeRecord[],
  llm: ReturnType<typeof createLlmClient>,
): Promise<CandidateSpike[]> {
  const reference = await loadOracleReference(ctx);
  const existingTopics = vaultTopics(vault);
  const system = oracleSystemPrompt(ctx.config);
  const candidates: CandidateSpike[] = [];

  for (let i = 0; i < documents.length; i += DOCS_PER_CALL) {
    const batch = documents.slice(i, i + DOCS_PER_CALL);
    const items: SourceItem[] = batch.map((d) => ({
      kind: d.kind,
      reference: d.reference,
      title: d.title,
      content: d.content,
    }));

    try {
      const payload = await llm.json<ExtractionPayload>(
        extractSpikesPrompt(items, ctx.config, reference, existingTopics),
        system,
        { temperature: 0.4 },
      );
      candidates.push(...normaliseCandidates(payload.spikes, batch, ctx.config.active_brands));
    } catch (error) {
      ctx.log.warn(`extraction failed for batch ${i / DOCS_PER_CALL + 1}: ${(error as Error).message}`);
    }
  }
  return candidates;
}

function normaliseCandidates(
  value: unknown,
  batch: SourceDocument[],
  activeBrands: string[],
): CandidateSpike[] {
  if (!Array.isArray(value)) return [];
  const fallbackBrand = activeBrands[0]!;
  // The model is not asked to echo which document a spike came from, so
  // attribute the batch: one document batches are exact, larger ones are a
  // pointer to the right handful.
  const reference = batch.map((d) => d.reference).join('; ');
  const kind = [...new Set(batch.map((d) => d.kind))].join('+');

  return value
    .map((raw): CandidateSpike | null => {
      if (typeof raw !== 'object' || raw === null) return null;
      const e = raw as Record<string, unknown>;
      const topic = String(e.topic ?? '').trim();
      const angle = String(e.angle ?? '').trim();
      if (!topic || !angle) return null;

      const proposed = String(e.brand ?? '').trim();
      const brand = activeBrands.find((b) => b.toLowerCase() === proposed.toLowerCase()) ?? fallbackBrand;

      return {
        brand,
        topic,
        angle,
        story_evidence: String(e.story_evidence ?? '').trim(),
        persona: String(e.persona ?? '').trim(),
        pillar: String(e.pillar ?? '').trim(),
        timeliness: String(e.timeliness ?? '').trim(),
        novelty: Number(e.novelty ?? 0),
        specificity: Number(e.specificity ?? 0),
        relevance: Number(e.relevance ?? 0),
        source: kind,
        source_ref: reference,
      };
    })
    .filter((c): c is CandidateSpike => c !== null);
}

function toSpikeRecord(scored: ScoredSpike, spikeId: string, date: string, author: string): SpikeRecord {
  return {
    spike_id: spikeId,
    date,
    brand: scored.brand,
    author,
    source: scored.source,
    source_ref: scored.source_ref,
    topic: scored.topic,
    angle: scored.angle,
    story_evidence: scored.story_evidence,
    persona: scored.persona,
    pillar: scored.pillar,
    timeliness: scored.timeliness,
    score: scored.score,
    status: 'NEW',
    used_in: '',
    notes: scored.rationale,
  };
}

// ---------------------------------------------------------------------------
// Reference material
// ---------------------------------------------------------------------------

async function loadOracleReference(
  ctx: RunContext,
): Promise<{ audiences: string; positioning: string; seasonality: string }> {
  const read = async (file: string): Promise<string> => {
    if (!file) return '';
    const path = TenantPaths.reference(ctx.tenant, file);
    if (!(await ctx.storage.exists(path))) return '';
    return (await ctx.storage.readFile(path)).trim();
  };

  // Concatenate across active brands — the oracle works across the portfolio.
  const audiences: string[] = [];
  const positioning: string[] = [];
  for (const brand of Object.values(ctx.config.brands)) {
    const a = await read(brand.audiences_file);
    const p = await read(brand.positioning_file);
    if (a) audiences.push(`### ${brand.key}\n${a}`);
    if (p) positioning.push(`### ${brand.key}\n${p}`);
  }

  return {
    audiences: audiences.join('\n\n'),
    positioning: positioning.join('\n\n'),
    seasonality: await read(ctx.config.seasonality_file),
  };
}

/** Keywords from seasonal.yaml windows that are live this month. */
async function loadSeasonalKeywords(ctx: RunContext, now: Date): Promise<string[]> {
  const path = TenantPaths.reference(ctx.tenant, ctx.config.seasonality_file);
  if (!(await ctx.storage.exists(path))) return [];

  try {
    const parsed = YAML.parse(await ctx.storage.readFile(path)) as
      | { windows?: { name?: string; months?: number[]; keywords?: string[] }[] }
      | null;
    const month = now.getMonth() + 1;
    return (parsed?.windows ?? [])
      .filter((w) => !Array.isArray(w.months) || w.months.length === 0 || w.months.includes(month))
      .flatMap((w) => w.keywords ?? [])
      .map((k) => String(k).trim())
      .filter(Boolean);
  } catch (error) {
    ctx.log.warn(`could not parse ${ctx.config.seasonality_file}: ${(error as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Wrap-up
// ---------------------------------------------------------------------------

async function finish(
  ctx: RunContext,
  now: Date,
  result: { scanned: number; found: number; appended: number; spikes: SpikeRecord[] },
  vaultAfter: SpikeRecord[],
): Promise<void> {
  // The heartbeat the watchdog looks for. Written last, so it only appears
  // when the run actually completed.
  ctx.log.info(heartbeatLine('oracle'));

  const top = topSpikes(vaultAfter, ctx.config.oracle.top_n);
  const lines = [
    `Oracle found ${result.appended} new spikes (${result.scanned} documents scanned).`,
    '',
    `Top ${top.length} refreshed:`,
    ...top.map((s, i) => `${i + 1}. [${s.brand}] ${s.topic} — ${s.angle} (${s.score.toFixed(1)})`),
    '',
    `Sheet: ${ctx.sheet.label}`,
    `Log:   ${ctx.log.logPath}`,
  ];

  const author = getAuthor(ctx.config, ctx.config.default_author);
  await notify(ctx.env, ctx.log, {
    subject: `Oracle: ${result.appended} new spikes, top ${top.length} refreshed`,
    body: lines.join('\n'),
    ...(author.email ? { to: author.email } : {}),
  });
}

function summariseKinds(documents: SourceDocument[]): string {
  const counts = new Map<string, number>();
  for (const doc of documents) counts.set(doc.kind, (counts.get(doc.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, n]) => `${n} ${kind}`).join(', ');
}
