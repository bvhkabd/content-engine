/**
 * `content-engine topics` — show the current top spikes from the VAULT.
 */

import { createContext } from '../config/context.js';
import { topSpikes } from '../engine/scoring.js';
import { info, renderTopSpikes, style } from '../ui/console.js';
import type { SpikeRecord } from '../schemas/contracts.js';

export interface TopicsOptions {
  tenant: string;
  limit?: number;
  brand?: string;
  json?: boolean;
}

export async function showTopics(options: TopicsOptions): Promise<SpikeRecord[]> {
  const ctx = await createContext(options.tenant, { job: 'topics' });
  try {
    const vault = await ctx.sheet.readVault();
    const filtered = options.brand
      ? vault.filter((s) => s.brand.toLowerCase() === options.brand!.toLowerCase())
      : vault;

    const limit = options.limit ?? ctx.config.oracle.top_n;
    const top = topSpikes(filtered, limit);
    ctx.log.info(`topics: ${vault.length} rows in vault, ${top.length} shown`);

    if (options.json) {
      console.log(JSON.stringify(top, null, 2));
      return top;
    }

    console.log('');
    info(renderTopSpikes(top, limit));

    if (top.length > 0) {
      const first = top[0]!;
      info(style.dim('Start a session:'));
      info(`  npm run cli -- session --tenant ${options.tenant} --spike ${first.spike_id}`);
      console.log('');
    }
    return top;
  } finally {
    await ctx.log.flush();
  }
}
