/**
 * Bundler — approved draft in, Contract 6 derived assets out.
 *
 * Bundle composition comes from tenant.yaml (`bundle:`), defaulting to seven
 * assets across the five Contract-6 asset types.
 */

import {
  assertValid,
  validateDerivedAsset,
  type DerivedAsset,
  type DraftArtefact,
  type InterviewTranscript,
} from '../schemas/contracts.js';
import type { BrandContext, BundleItem, TenantConfig } from '../config/tenant.js';
import { bundleAssetPrompt, bundlerSystemPrompt } from '../prompts/bundler.js';
import type { LlmClient } from './llm.js';

interface BundlePayload {
  assets?: unknown;
}

/**
 * Generate the full bundle. Signature follows CLAUDE_CODE_BRIEF.md § src/engine,
 * with the LLM client injected in place of a raw API key.
 */
export async function bundleAssets(
  draft: DraftArtefact,
  interview: InterviewTranscript,
  tenant: TenantConfig,
  ctx: BrandContext,
  llm: LlmClient,
): Promise<DerivedAsset[]> {
  const system = bundlerSystemPrompt(ctx);

  // One call per asset type, concurrently. A format that fails does not take
  // the rest of the bundle down — the session reports what came back short.
  const groups = await Promise.all(
    tenant.bundle.map(async (item): Promise<DerivedAsset[]> => {
      const payload = await llm.json<BundlePayload>(
        bundleAssetPrompt(item, draft, interview, ctx),
        system,
        { temperature: 0.8 },
      );
      return toAssets(payload, item, draft);
    }),
  );

  const assets = groups.flat();
  assets.forEach((asset, i) => assertValid(validateDerivedAsset(asset), `Derived asset ${i + 1} (${asset.asset_type})`));
  return assets;
}

function toAssets(payload: BundlePayload, item: BundleItem, draft: DraftArtefact): DerivedAsset[] {
  const raw = Array.isArray(payload.assets) ? payload.assets : [];

  const assets = raw
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null;
      const e = entry as Record<string, unknown>;
      const text = String(e.text ?? '').trim();
      if (!text) return null;
      const asset: DerivedAsset = {
        anchor_id: draft.anchor_id,
        asset_type: item.asset_type,
        text,
        status: 'PROPOSED',
        // Traceability is a contract requirement; fall back to the anchor
        // itself rather than emitting an empty ref.
        passage_ref: String(e.passage_ref ?? e.passageRef ?? '').trim() || `Anchor ${draft.anchor_id}`,
        published_link: '',
        metrics_30d: '',
        notes: String(e.notes ?? '').trim(),
      };
      return asset;
    })
    .filter((a): a is DerivedAsset => a !== null);

  // Trim overshoot; undershoot is surfaced by the caller via bundleShortfall().
  return assets.slice(0, item.count);
}

/** Which asset types came back short, for the session summary. */
export function bundleShortfall(
  tenant: TenantConfig,
  assets: readonly DerivedAsset[],
): { asset_type: string; expected: number; got: number }[] {
  return tenant.bundle
    .map((item) => ({
      asset_type: item.asset_type,
      expected: item.count,
      got: assets.filter((a) => a.asset_type === item.asset_type).length,
    }))
    .filter((row) => row.got < row.expected);
}
