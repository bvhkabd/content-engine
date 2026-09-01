/**
 * `content-engine classify` — record a boundary ruling.
 *
 * The redlines file states policy; this appends case law. A ruling names a real
 * spike and the reason, and both the oracle and the critic read the accumulated
 * file with instructions that it overrides the policy where they disagree.
 *
 * This is how the system learns where the line actually sits: the operator
 * disagrees with a call once, records why, and the reasoning is in front of the
 * model on every subsequent run.
 */

import { createContext, type RunContext } from '../config/context.js';
import { getBrand } from '../config/tenant.js';
import { isoDate } from '../engine/ids.js';
import { TenantPaths } from '../io/storage.js';
import { heading, info, style, success } from '../ui/console.js';
import { loadSpike } from './shared.js';

export interface ClassifyOptions {
  tenant: string;
  spikeId: string;
  /** Exactly one of these. */
  allow?: string;
  block?: string;
  /** Override the brand whose rulings file is written. */
  brand?: string;
}

export interface ClassifyResult {
  verdict: 'ALLOWED' | 'BLOCKED';
  path: string;
}

export async function runClassify(options: ClassifyOptions): Promise<ClassifyResult> {
  const ctx = await createContext(options.tenant, { job: 'classify' });

  try {
    const reason = (options.allow ?? options.block ?? '').trim();
    if (!reason) {
      throw new Error(
        'A ruling needs a reason. The reason is the whole point — it is what the model reads.\n' +
          `  npm run cli -- classify --tenant ${options.tenant} --spike ${options.spikeId} --allow "why this is fine"`,
      );
    }
    if (options.allow && options.block) {
      throw new Error('Pass --allow or --block, not both.');
    }

    const spike = await loadSpike(ctx, options.spikeId);
    const brand = getBrand(ctx.config, options.brand ?? spike.brand);
    const verdict = options.allow ? 'ALLOWED' : 'BLOCKED';
    const path = TenantPaths.reference(ctx.tenant, brand.redline_lessons_file);

    const entry = formatRuling({
      verdict,
      topic: spike.topic,
      angle: spike.angle,
      spikeId: spike.spike_id,
      reason,
      date: isoDate(new Date()),
    });

    await appendRuling(ctx, path, brand.key, entry);

    heading(`Ruling recorded — ${verdict}`);
    info(`${style.dim('Spike:  ')}${spike.spike_id}  ${spike.topic}`);
    info(`${style.dim('Reason: ')}${reason}`);
    success(`Appended to ${path}`);
    info('');
    info(style.dim('The oracle and the critic both read this file, and it overrides the'));
    info(style.dim('general policy in redlines-*.md wherever the two disagree.'));

    ctx.log.info(`classify ${spike.spike_id} -> ${verdict} (${brand.key}): ${reason}`);
    return { verdict, path };
  } finally {
    await ctx.log.flush();
  }
}

export interface RulingInput {
  verdict: 'ALLOWED' | 'BLOCKED';
  topic: string;
  angle: string;
  spikeId: string;
  reason: string;
  date: string;
}

/** Pure — the markdown for one ruling. Exported for tests. */
export function formatRuling(input: RulingInput): string {
  return [
    `### ${input.verdict} — ${input.topic}`,
    `**Ruled:** ${input.date}  ·  **Spike:** ${input.spikeId}`,
    `**Example:** ${input.angle}`,
    `**Why:** ${input.reason}`,
    '',
  ].join('\n');
}

/** Create the file with a header on first use, then append. */
async function appendRuling(
  ctx: RunContext,
  path: string,
  brandKey: string,
  entry: string,
): Promise<void> {
  const existing = (await ctx.storage.exists(path)) ? await ctx.storage.readFile(path) : '';
  const body = existing.trim() ? `${existing.trimEnd()}\n\n${entry}` : `${header(brandKey)}\n${entry}`;
  await ctx.storage.writeFile(path, body);
}

function header(brandKey: string): string {
  return [
    `# Redline rulings — ${brandKey}`,
    '',
    'Read by: oracle (boundary flagging), critic (Boundary Check).',
    '',
    `The policy in redlines-${brandKey.toLowerCase()}.md states the rule. This file is the case`,
    'law: actual calls made on real spikes, with reasons. **Where the two disagree,',
    'this file wins** — a ruling on a real example beats a general principle.',
    '',
    '---',
    '',
  ].join('\n');
}
