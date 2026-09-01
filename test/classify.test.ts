/**
 * Boundary ruling formatting.
 *
 * The ruling text is what the oracle and critic actually read, so it has to
 * carry the reason and the concrete example, not just a verdict.
 */

import { describe, expect, it } from 'vitest';
import { formatRuling } from '../src/skills/classify.js';

const base = {
  topic: 'Retrospective taxation creating execution uncertainty',
  angle: 'Unpredictable tax treatment makes multi-year commitments impossible',
  spikeId: 'SPIKE-20260901-002',
  date: '2026-09-01',
};

describe('formatRuling', () => {
  it('leads with the verdict and the topic', () => {
    const entry = formatRuling({ ...base, verdict: 'ALLOWED', reason: 'Consequences, not a verdict.' });
    expect(entry.split('\n')[0]).toBe(`### ALLOWED — ${base.topic}`);
  });

  it('carries the reason, which is the part that teaches', () => {
    const entry = formatRuling({ ...base, verdict: 'ALLOWED', reason: 'Consequences, not a verdict.' });
    expect(entry).toContain('**Why:** Consequences, not a verdict.');
  });

  it('records the concrete example and the spike it came from', () => {
    const entry = formatRuling({ ...base, verdict: 'BLOCKED', reason: 'Takes a side.' });
    expect(entry).toContain(base.angle);
    expect(entry).toContain(base.spikeId);
    expect(entry).toContain('2026-09-01');
  });

  it('distinguishes the two verdicts', () => {
    expect(formatRuling({ ...base, verdict: 'BLOCKED', reason: 'x' })).toContain('### BLOCKED');
    expect(formatRuling({ ...base, verdict: 'ALLOWED', reason: 'x' })).toContain('### ALLOWED');
  });

  it('ends with a blank line so entries append cleanly', () => {
    expect(formatRuling({ ...base, verdict: 'ALLOWED', reason: 'x' })).toMatch(/\n$/);
  });
});
