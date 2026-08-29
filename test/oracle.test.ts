/**
 * Oracle source deduplication.
 *
 * Regression coverage for a bug that only appeared with real sources: spikes
 * extracted from a multi-document batch stored their Source Ref as the whole
 * batch joined together, while the dedupe check compared one document's
 * reference at a time. Nothing ever matched, so every run re-created the same
 * spikes. A single-document batch hid it, which is why the first end-to-end
 * test passed.
 */

import { describe, expect, it } from 'vitest';
import { REF_SEPARATOR, expandSourceRefs } from '../src/jobs/oracle.js';
import type { SpikeRecord } from '../src/schemas/contracts.js';
import { validSpike } from './contracts.test.js';

const spikeWithRef = (source_ref: string): SpikeRecord => ({ ...validSpike, source_ref });

/** The check the oracle performs per incoming document. */
const isFresh = (seen: Set<string>, reference: string) => !seen.has(reference.trim());

describe('expandSourceRefs', () => {
  it('collects a single reference', () => {
    expect(expandSourceRefs([spikeWithRef('<a@mail>')])).toEqual(new Set(['<a@mail>']));
  });

  it('splits a joined batch back into individual references', () => {
    const seen = expandSourceRefs([spikeWithRef(['<a@mail>', '<b@mail>', '<c@mail>'].join(REF_SEPARATOR))]);
    expect(seen).toEqual(new Set(['<a@mail>', '<b@mail>', '<c@mail>']));
  });

  it('ignores blank and whitespace-only references', () => {
    expect(expandSourceRefs([spikeWithRef(''), spikeWithRef('   '), spikeWithRef('; ; ')]).size).toBe(0);
  });

  it('trims each part', () => {
    expect(expandSourceRefs([spikeWithRef('  <a@mail>  ;   <b@mail>  ')])).toEqual(
      new Set(['<a@mail>', '<b@mail>']),
    );
  });

  it('merges references across many vault rows', () => {
    const seen = expandSourceRefs([
      spikeWithRef('<a@mail>'),
      spikeWithRef(['<b@mail>', '<c@mail>'].join(REF_SEPARATOR)),
      spikeWithRef('transcript-1.md'),
    ]);
    expect(seen.size).toBe(4);
    expect(seen.has('<c@mail>')).toBe(true);
  });
});

describe('deduplication behaviour', () => {
  it('recognises every document of a batched row as already seen', () => {
    // The bug: this row was written from a 4-document batch.
    const vault = [spikeWithRef(['<a@mail>', '<b@mail>', '<c@mail>', '<d@mail>'].join(REF_SEPARATOR))];
    const seen = expandSourceRefs(vault);

    for (const ref of ['<a@mail>', '<b@mail>', '<c@mail>', '<d@mail>']) {
      expect(isFresh(seen, ref)).toBe(false);
    }
  });

  it('still lets genuinely new documents through', () => {
    const seen = expandSourceRefs([spikeWithRef(['<a@mail>', '<b@mail>'].join(REF_SEPARATOR))]);
    expect(isFresh(seen, '<new@mail>')).toBe(true);
  });

  it('handles the single-document case that used to pass by accident', () => {
    const seen = expandSourceRefs([spikeWithRef('<only@mail>')]);
    expect(isFresh(seen, '<only@mail>')).toBe(false);
    expect(isFresh(seen, '<other@mail>')).toBe(true);
  });

  it('treats an empty vault as everything being new', () => {
    const seen = expandSourceRefs([]);
    expect(isFresh(seen, '<a@mail>')).toBe(true);
  });

  it('does not partially match a longer reference', () => {
    // "<a@mail>" must not suppress "<a@mail>.uk"
    const seen = expandSourceRefs([spikeWithRef('<a@mail>')]);
    expect(isFresh(seen, '<a@mail>.uk')).toBe(true);
  });
});
