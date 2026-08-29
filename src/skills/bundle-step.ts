/**
 * The bundle step, shared by `session` (inline, after approval) and
 * `approve` (standalone, for a draft approved earlier).
 *
 * Writes Contract 6 rows to REPURPOSING (PROPOSED) and a Contract 5 row to
 * EDITIONS (DRAFT).
 */

import type { RunContext } from '../config/context.js';
import { bundleAssets, bundleShortfall } from '../engine/bundler.js';
import { isoDate } from '../engine/ids.js';
import type { LlmClient } from '../engine/llm.js';
import { assertValid, validateEditionRecord } from '../schemas/contracts.js';
import type { BrandContext } from '../config/tenant.js';
import type {
  DerivedAsset,
  DraftArtefact,
  EditionRecord,
  InterviewTranscript,
} from '../schemas/contracts.js';
import { renderAssetSummary, step, style, success, warn } from '../ui/console.js';

export interface BundleResult {
  assets: DerivedAsset[];
  edition: EditionRecord;
  shortfall: { asset_type: string; expected: number; got: number }[];
}

export async function runBundleStep(
  ctx: RunContext,
  draft: DraftArtefact,
  interview: InterviewTranscript,
  brandContext: BrandContext,
  llm: LlmClient,
  topic: string,
  now: Date,
): Promise<BundleResult> {
  const expected = ctx.config.bundle.reduce((sum, item) => sum + item.count, 0);
  step(`Generating ${expected} derived assets…`);

  const assets = await bundleAssets(draft, interview, ctx.config, brandContext, llm);
  const shortfall = bundleShortfall(ctx.config, assets);

  await ctx.sheet.appendRepurposingRows(assets);
  ctx.log.info(`appended ${assets.length} REPURPOSING rows for ${draft.anchor_id}`);
  success(`${assets.length} assets → REPURPOSING (PROPOSED): ${renderAssetSummary(assets)}`);

  if (shortfall.length) {
    const detail = shortfall.map((s) => `${s.asset_type} ${s.got}/${s.expected}`).join(', ');
    warn(`Bundle came back short: ${detail}`);
    ctx.log.warn(`bundle shortfall for ${draft.anchor_id}: ${detail}`);
  }

  const edition = await upsertEdition(ctx, draft, topic, now);
  success(`EDITIONS row ${style.bold(edition.edition)} (${edition.status})`);

  return { assets, edition, shortfall };
}

/** One EDITIONS row per anchor. Re-bundling updates rather than duplicates. */
async function upsertEdition(
  ctx: RunContext,
  draft: DraftArtefact,
  topic: string,
  now: Date,
): Promise<EditionRecord> {
  const editions = await ctx.sheet.readEditions();
  const existing = editions.find((e) => e.edition.trim() === draft.anchor_id);

  if (existing) {
    const updates: Partial<EditionRecord> = {
      topic,
      notes: `Re-bundled ${isoDate(now)} from ${draft.anchor_id} v${draft.version}`,
    };
    await ctx.sheet.updateEditionRow(existing.edition, updates);
    ctx.log.info(`updated EDITIONS row ${existing.edition}`);
    return { ...existing, ...updates };
  }

  const edition: EditionRecord = {
    edition: draft.anchor_id,
    date_published: '', // filled in when it actually ships
    brand: draft.brand,
    author: draft.author,
    topic,
    issue_number: String(editions.length + 1),
    status: 'DRAFT',
    newsletter_link: '',
    metrics_30d: '',
    notes: `Bundled ${isoDate(now)} from ${draft.anchor_id} v${draft.version}`,
  };

  assertValid(validateEditionRecord(edition), `Edition ${edition.edition}`);
  await ctx.sheet.appendEditionRow(edition);
  ctx.log.info(`appended EDITIONS row ${edition.edition}`);
  return edition;
}
