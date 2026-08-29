/**
 * Engine unit tests: IDs, scoring, verdict logic, and the writer / critic /
 * bundler driven by a stub LLM (no network).
 */

import { describe, expect, it } from 'vitest';
import {
  buildAnchorId,
  compactDate,
  findInterviewFiles,
  interviewFileName,
  latestVersion,
  nextAnchorId,
  nextSpikeId,
  nextSpikeIds,
} from '../src/engine/ids.js';
import {
  DUPLICATE_PENALTY,
  bestSimilarity,
  rankSpikes,
  scoreSpike,
  similarity,
  topSpikes,
  vaultTopics,
  type CandidateSpike,
} from '../src/engine/scoring.js';
import { criticizeArticle, decideVerdict } from '../src/engine/critic.js';
import { bundleAssets, bundleShortfall } from '../src/engine/bundler.js';
import { reviseArticle, writeArticle } from '../src/engine/writer.js';
import { parseJsonReply } from '../src/engine/openrouter.js';
import { dateFromAnchorId } from '../src/jobs/watchdog.js';
import { DEFAULT_BUNDLE, parseTenantConfig, type BrandContext, type TenantConfig } from '../src/config/tenant.js';
import type { CriticCheck, SpikeRecord } from '../src/schemas/contracts.js';
import type { LlmClient } from '../src/engine/llm.js';
import { validDraft, validInterview, validReport, validSpike } from './contracts.test.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_YAML = `
tenant: harish
active_brands: [ABD]
brands:
  ABD:
    name: "Align by Design"
    prefix: ABD
    pillars: ["operating model"]
authors:
  harish:
    name: "Harish"
    email: harish@example.com
channels:
  website-article:
    name: "Website article"
    target_words: 1200
    anchor_token: ARTICLE
sheet:
  id: "sheet-123"
`;

const tenantConfig: TenantConfig = parseTenantConfig('harish', TENANT_YAML);

const brandContext: BrandContext = {
  brand: tenantConfig.brands.ABD!,
  author: tenantConfig.authors.harish!,
  channel: tenantConfig.channels['website-article']!,
  voice: 'Blunt. Short sentences.',
  redlines: 'Never name clients.',
  positioning: 'Operating model consultancy.',
  audiences: 'COOs.',
  ctas: '- Book a diagnostic',
  lessons: 'No rhetorical questions.',
  seasonality: '',
};

/** Returns a canned JSON payload per call, in order. */
function stubLlm(payloads: unknown[]): LlmClient & { calls: { prompt: string; system: string }[] } {
  const calls: { prompt: string; system: string }[] = [];
  let index = 0;
  const next = () => {
    if (index >= payloads.length) throw new Error(`stub LLM called ${index + 1} times, only ${payloads.length} payloads`);
    return payloads[index++];
  };
  return {
    model: 'stub/model',
    calls,
    async complete(prompt, system) {
      calls.push({ prompt, system });
      return String(next());
    },
    async json<T>(prompt: string, system: string): Promise<T> {
      calls.push({ prompt, system });
      return next() as T;
    },
  };
}

// ---------------------------------------------------------------------------

describe('ids', () => {
  it('starts a new day at 001', () => {
    expect(nextSpikeId([], '2026-08-15')).toBe('SPIKE-20260815-001');
  });

  it('continues from the highest sequence for that day', () => {
    const existing = [
      { ...validSpike, spike_id: 'SPIKE-20260815-001' },
      { ...validSpike, spike_id: 'SPIKE-20260815-004' },
      { ...validSpike, spike_id: 'SPIKE-20260814-009' }, // different day, ignored
    ];
    expect(nextSpikeId(existing, '2026-08-15')).toBe('SPIKE-20260815-005');
  });

  it('allocates a consecutive block', () => {
    expect(nextSpikeIds([], '2026-08-15', 3)).toEqual([
      'SPIKE-20260815-001',
      'SPIKE-20260815-002',
      'SPIKE-20260815-003',
    ]);
  });

  it('builds the anchor ID shape from the spec', () => {
    expect(buildAnchorId(brandContext.brand, brandContext.channel, '2026-08-15', 1)).toBe(
      'ABD-ARTICLE-20260815-001',
    );
  });

  it('increments the anchor sequence from existing draft files', () => {
    const files = ['ABD-ARTICLE-20260815-001-v1.md', 'ABD-ARTICLE-20260815-001-v2.md'];
    expect(nextAnchorId(files, brandContext.brand, brandContext.channel, '2026-08-15')).toBe(
      'ABD-ARTICLE-20260815-002',
    );
  });

  it('ignores other days and brands when picking the next anchor', () => {
    const files = ['ABD-ARTICLE-20260814-007-v1.md', 'CTQ-ARTICLE-20260815-003-v1.md'];
    expect(nextAnchorId(files, brandContext.brand, brandContext.channel, '2026-08-15')).toBe(
      'ABD-ARTICLE-20260815-001',
    );
  });

  it('finds the highest draft version', () => {
    const files = ['A-B-20260815-001-v1.md', 'A-B-20260815-001-v3.md', 'A-B-20260815-002-v9.md'];
    expect(latestVersion(files, 'A-B-20260815-001')).toBe(3);
    expect(latestVersion(files, 'A-B-20260815-777')).toBe(0);
  });

  it('names interview files per Contract 2', () => {
    expect(interviewFileName('SPIKE-20260815-001', 'harish', '2026-08-15')).toBe(
      'SPIKE-20260815-001-harish-2026-08-15.md',
    );
  });

  it('matches interview files for a spike only', () => {
    const files = [
      'SPIKE-20260815-001-harish-2026-08-15.md',
      'SPIKE-20260815-001-harish-2026-08-17.md',
      'SPIKE-20260815-002-harish-2026-08-15.md',
    ];
    expect(findInterviewFiles(files, 'SPIKE-20260815-001')).toHaveLength(2);
  });

  it('compacts dates', () => {
    expect(compactDate('2026-08-15')).toBe('20260815');
    expect(compactDate(new Date('2026-08-15T10:00:00Z'))).toBe('20260815');
  });

  it('recovers the date from an anchor ID', () => {
    expect(dateFromAnchorId('ABD-ARTICLE-20260815-001')?.toISOString().slice(0, 10)).toBe('2026-08-15');
    expect(dateFromAnchorId('not-an-anchor')).toBeNull();
  });
});

describe('scoring', () => {
  const candidate: CandidateSpike = {
    brand: 'ABD',
    topic: 'Operating model drift',
    angle: 'Reorgs fail without operating model change',
    story_evidence: 'Three layers cut, no change',
    persona: 'COO',
    pillar: 'operating model',
    timeliness: 'Planning season',
    novelty: 8,
    specificity: 9,
    relevance: 7,
    source: 'email',
    source_ref: 'ref-1',
  };

  it('weights specificity most heavily', () => {
    // 8*0.3 + 9*0.4 + 7*0.3 = 8.1
    expect(scoreSpike(candidate, [], []).score).toBe(8.1);
  });

  it('penalises a near-duplicate of something in the vault', () => {
    const scored = scoreSpike(candidate, ['Operating model drift Reorgs fail without operating model change'], []);
    expect(scored.score).toBe(8.1 - DUPLICATE_PENALTY);
    expect(scored.rationale).toContain('near-duplicate');
  });

  it('does not penalise an unrelated vault topic', () => {
    expect(scoreSpike(candidate, ['Pricing strategy for boutique firms'], []).score).toBe(8.1);
  });

  it('adds a seasonality bonus on a keyword match', () => {
    const scored = scoreSpike(candidate, [], ['drift']);
    expect(scored.score).toBe(9.1);
    expect(scored.rationale).toContain('seasonal');
  });

  it('clamps to 0..10', () => {
    expect(scoreSpike({ ...candidate, novelty: 10, specificity: 10, relevance: 10 }, [], ['drift']).score).toBe(10);
    expect(scoreSpike({ ...candidate, novelty: 0, specificity: 0, relevance: 0 }, ['Operating model drift Reorgs fail without operating model change'], []).score).toBe(0);
  });

  it('treats a missing score as zero rather than NaN', () => {
    const scored = scoreSpike({ ...candidate, novelty: NaN, specificity: 9, relevance: 7 }, [], []);
    expect(Number.isFinite(scored.score)).toBe(true);
    expect(scored.score).toBe(5.7);
  });

  it('penalises the second of two near-identical candidates in one batch', () => {
    const ranked = rankSpikes([candidate, { ...candidate, source_ref: 'ref-2' }], [], []);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('sorts high to low', () => {
    const ranked = rankSpikes(
      [
        { ...candidate, topic: 'Low', novelty: 2, specificity: 2, relevance: 2 },
        { ...candidate, topic: 'High', novelty: 9, specificity: 9, relevance: 9 },
      ],
      [],
      [],
    );
    expect(ranked.map((r) => r.topic)).toEqual(['High', 'Low']);
  });

  it('measures similarity ignoring stopwords', () => {
    expect(similarity('the operating model drift', 'operating model drift')).toBe(1);
    expect(similarity('pricing strategy', 'operating model')).toBe(0);
    expect(bestSimilarity('operating model', ['pricing', 'operating model drift'])).toBeGreaterThan(0.5);
  });

  it('excludes KILLED spikes from the dedupe corpus', () => {
    const spikes: SpikeRecord[] = [
      { ...validSpike, status: 'KILLED', topic: 'Dead idea' },
      { ...validSpike, status: 'NEW', topic: 'Live idea' },
    ];
    expect(vaultTopics(spikes).join()).not.toContain('Dead idea');
  });

  it('topSpikes returns only live statuses, ranked', () => {
    const spikes: SpikeRecord[] = [
      { ...validSpike, spike_id: 'SPIKE-20260815-001', status: 'USED', score: 10 },
      { ...validSpike, spike_id: 'SPIKE-20260815-002', status: 'NEW', score: 6 },
      { ...validSpike, spike_id: 'SPIKE-20260815-003', status: 'SHORTLISTED', score: 9 },
      { ...validSpike, spike_id: 'SPIKE-20260815-004', status: 'KILLED', score: 10 },
      { ...validSpike, spike_id: 'SPIKE-20260815-005', status: 'PARKED', score: 10 },
    ];
    expect(topSpikes(spikes, 6).map((s) => s.spike_id)).toEqual([
      'SPIKE-20260815-003',
      'SPIKE-20260815-002',
    ]);
  });

  it('topSpikes honours the limit', () => {
    const spikes = Array.from({ length: 10 }, (_, i) => ({
      ...validSpike,
      spike_id: `SPIKE-20260815-${String(i + 1).padStart(3, '0')}`,
      score: i,
    }));
    expect(topSpikes(spikes, 6)).toHaveLength(6);
  });
});

describe('decideVerdict', () => {
  const thresholds = { pass_score: 8, boundary_fail_score: 6, max_revise_cycles: 3 };
  const check = (name: CriticCheck['name'], score: number, flags: string[] = []): CriticCheck => ({
    name,
    score,
    passed: '',
    flags,
  });

  it('PASSes when every check clears the bar with no flags', () => {
    const checks = [
      check('boundary', 9),
      check('voice', 8),
      check('traceability', 10),
      check('claims_scope', 8.5),
    ];
    expect(decideVerdict(checks, thresholds)).toBe('PASS');
  });

  it('REVISEs on a flag even when every score clears the bar', () => {
    const checks = [
      check('boundary', 9),
      check('voice', 9, ['banned phrase']),
      check('traceability', 10),
      check('claims_scope', 9),
    ];
    expect(decideVerdict(checks, thresholds)).toBe('REVISE');
  });

  it('REVISEs when one score is below the bar', () => {
    const checks = [
      check('boundary', 9),
      check('voice', 7.9),
      check('traceability', 10),
      check('claims_scope', 9),
    ];
    expect(decideVerdict(checks, thresholds)).toBe('REVISE');
  });

  it('FAIL-AUTOMATICs on a boundary breach regardless of the other scores', () => {
    const checks = [
      check('boundary', 5.9),
      check('voice', 10),
      check('traceability', 10),
      check('claims_scope', 10),
    ];
    expect(decideVerdict(checks, thresholds)).toBe('FAIL-AUTOMATIC');
  });

  it('does not fail automatically exactly at the boundary threshold', () => {
    const checks = [
      check('boundary', 6),
      check('voice', 10),
      check('traceability', 10),
      check('claims_scope', 10),
    ];
    expect(decideVerdict(checks, thresholds)).toBe('REVISE');
  });
});

describe('writer', () => {
  it('builds a contract-valid draft from the model payload', async () => {
    const llm = stubLlm([
      {
        title: 'The reorg that changed nothing',
        body: 'They cut three layers.',
        provenance: [{ claim: 'They cut three layers', passage_ref: 'Interview line 2' }],
        chosen_cta: 'Book a diagnostic',
      },
    ]);

    const draft = await writeArticle(validInterview, tenantConfig, validSpike, brandContext, llm, {
      anchorId: 'ABD-ARTICLE-20260815-001',
      version: 1,
    });

    expect(draft.anchor_id).toBe('ABD-ARTICLE-20260815-001');
    expect(draft.spike_id).toBe(validSpike.spike_id);
    expect(draft.version).toBe(1);
    expect(draft.brand).toBe('ABD');
    expect(draft.channel).toBe('website-article');
    expect(draft.provenance).toHaveLength(1);
  });

  it('strips a duplicated H1 out of the body', async () => {
    const llm = stubLlm([
      {
        title: 'Title',
        body: '# Title\n\nReal body starts here.',
        provenance: [{ claim: 'x', passage_ref: 'Interview line 2' }],
        chosen_cta: 'CTA',
      },
    ]);
    const draft = await writeArticle(validInterview, tenantConfig, validSpike, brandContext, llm, {
      anchorId: 'ABD-ARTICLE-20260815-001',
      version: 1,
    });
    expect(draft.body).toBe('Real body starts here.');
  });

  it('drops malformed provenance entries instead of failing the draft', async () => {
    const llm = stubLlm([
      {
        title: 'Title',
        body: 'Body.',
        provenance: [{ claim: 'good', passage_ref: 'Interview line 2' }, { claim: 'orphan' }, 'nonsense'],
        chosen_cta: 'CTA',
      },
    ]);
    const draft = await writeArticle(validInterview, tenantConfig, validSpike, brandContext, llm, {
      anchorId: 'ABD-ARTICLE-20260815-001',
      version: 1,
    });
    expect(draft.provenance).toEqual([{ claim: 'good', passage_ref: 'Interview line 2' }]);
  });

  it('throws rather than saving a draft with no title', async () => {
    const llm = stubLlm([{ title: '', body: 'Body.', provenance: [], chosen_cta: '' }]);
    await expect(
      writeArticle(validInterview, tenantConfig, validSpike, brandContext, llm, {
        anchorId: 'ABD-ARTICLE-20260815-001',
        version: 1,
      }),
    ).rejects.toThrow(/failed contract validation[\s\S]*title/);
  });

  it('revision bumps the version and keeps the anchor', async () => {
    const llm = stubLlm([{ title: 'Fixed', body: 'Better body.', provenance: [], chosen_cta: 'CTA' }]);
    const revised = await reviseArticle(
      validDraft,
      validReport,
      validInterview,
      tenantConfig,
      validSpike,
      brandContext,
      llm,
      'make it shorter',
    );
    expect(revised.version).toBe(2);
    expect(revised.anchor_id).toBe(validDraft.anchor_id);
    expect(llm.calls[0]!.prompt).toContain('make it shorter');
  });

  it('puts the line-numbered transcript and the redlines in front of the model', async () => {
    const llm = stubLlm([
      { title: 'T', body: 'B', provenance: [{ claim: 'c', passage_ref: 'Interview line 2' }], chosen_cta: 'CTA' },
    ]);
    await writeArticle(validInterview, tenantConfig, validSpike, brandContext, llm, {
      anchorId: 'ABD-ARTICLE-20260815-001',
      version: 1,
    });
    expect(llm.calls[0]!.prompt).toContain('1    | Q: What happened?');
    expect(llm.calls[0]!.system).toContain('Never name clients.');
    expect(llm.calls[0]!.system).toContain('Blunt. Short sentences.');
  });
});

describe('critic', () => {
  const passing = { score: 9, passed: 'fine', flags: [] };

  it('runs four checks and returns a contract-valid report', async () => {
    const llm = stubLlm([passing, passing, passing, passing]);
    const report = await criticizeArticle(validDraft, tenantConfig, validInterview, brandContext, llm);

    expect(report.checks.map((c) => c.name)).toEqual(['boundary', 'voice', 'traceability', 'claims_scope']);
    expect(report.verdict).toBe('PASS');
    expect(report.anchor_id).toBe(validDraft.anchor_id);
    expect(llm.calls).toHaveLength(4);
  });

  it('collects flags into outstanding criticisms, tagged by check', async () => {
    const llm = stubLlm([
      passing,
      { score: 6, passed: 'off', flags: ['"unlock the potential" — banned'] },
      passing,
      passing,
    ]);
    const report = await criticizeArticle(validDraft, tenantConfig, validInterview, brandContext, llm);
    expect(report.verdict).toBe('REVISE');
    expect(report.outstanding_criticisms).toEqual(['[voice] "unlock the potential" — banned']);
  });

  it('treats an unparseable score as 0 rather than a pass', async () => {
    const llm = stubLlm([{ score: 'excellent', passed: 'ok', flags: [] }, passing, passing, passing]);
    const report = await criticizeArticle(validDraft, tenantConfig, validInterview, brandContext, llm);
    expect(report.checks[0]!.score).toBe(0);
    expect(report.verdict).toBe('FAIL-AUTOMATIC');
  });

  it('normalises a flags string of "none" to no flags', async () => {
    const llm = stubLlm([
      { score: 9, passed: 'ok', flags: 'none' },
      passing,
      passing,
      passing,
    ]);
    const report = await criticizeArticle(validDraft, tenantConfig, validInterview, brandContext, llm);
    expect(report.checks[0]!.flags).toEqual([]);
    expect(report.verdict).toBe('PASS');
  });

  it('gives the traceability check the transcript and the provenance map', async () => {
    const llm = stubLlm([passing, passing, passing, passing]);
    await criticizeArticle(validDraft, tenantConfig, validInterview, brandContext, llm);
    const traceability = llm.calls[2]!.prompt;
    expect(traceability).toContain('Interview line 2');
    expect(traceability).toContain('1    | Q: What happened?');
  });
});

describe('bundler', () => {
  const bundleConfig: TenantConfig = { ...tenantConfig, bundle: DEFAULT_BUNDLE };

  it('produces the configured number of assets across the configured types', async () => {
    const llm = stubLlm([
      { assets: [{ text: 'li 1', passage_ref: 'Article' }, { text: 'li 2', passage_ref: 'Article' }] },
      { assets: [{ text: 'thread', passage_ref: 'Article' }] },
      { assets: [{ text: 'tweet 1', passage_ref: 'Article' }, { text: 'tweet 2', passage_ref: 'Article' }] },
      { assets: [{ text: 'clip', passage_ref: 'Article' }] },
      { assets: [{ text: 'short', passage_ref: 'Article' }] },
    ]);

    const assets = await bundleAssets(validDraft, validInterview, bundleConfig, brandContext, llm);
    expect(assets).toHaveLength(7);
    expect(assets.every((a) => a.status === 'PROPOSED')).toBe(true);
    expect(assets.every((a) => a.anchor_id === validDraft.anchor_id)).toBe(true);
    expect(bundleShortfall(bundleConfig, assets)).toEqual([]);
  });

  it('trims overshoot to the configured count', async () => {
    const llm = stubLlm([
      { assets: [1, 2, 3, 4].map((n) => ({ text: `li ${n}`, passage_ref: 'Article' })) },
      { assets: [{ text: 'thread', passage_ref: 'Article' }] },
      { assets: [{ text: 't1', passage_ref: 'A' }, { text: 't2', passage_ref: 'A' }] },
      { assets: [{ text: 'clip', passage_ref: 'A' }] },
      { assets: [{ text: 'short', passage_ref: 'A' }] },
    ]);
    const assets = await bundleAssets(validDraft, validInterview, bundleConfig, brandContext, llm);
    expect(assets.filter((a) => a.asset_type === 'linkedin-post')).toHaveLength(2);
  });

  it('falls back to the anchor when the model omits a passage ref', async () => {
    const config: TenantConfig = { ...tenantConfig, bundle: [{ asset_type: 'tweet', count: 1, notes: '' }] };
    const llm = stubLlm([{ assets: [{ text: 'A tweet.' }] }]);
    const [asset] = await bundleAssets(validDraft, validInterview, config, brandContext, llm);
    expect(asset!.passage_ref).toBe(`Anchor ${validDraft.anchor_id}`);
  });

  it('drops empty assets and reports the shortfall', async () => {
    const config: TenantConfig = { ...tenantConfig, bundle: [{ asset_type: 'tweet', count: 2, notes: '' }] };
    const llm = stubLlm([{ assets: [{ text: 'Only one.', passage_ref: 'A' }, { text: '   ' }] }]);
    const assets = await bundleAssets(validDraft, validInterview, config, brandContext, llm);
    expect(assets).toHaveLength(1);
    expect(bundleShortfall(config, assets)).toEqual([{ asset_type: 'tweet', expected: 2, got: 1 }]);
  });
});

describe('openrouter JSON extraction', () => {
  it('parses a bare object', () => {
    expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block', () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses an object wrapped in prose', () => {
    expect(parseJsonReply('Here you go:\n{"a": 1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('is not fooled by braces inside strings', () => {
    expect(parseJsonReply('prefix {"a":"}{"} suffix')).toEqual({ a: '}{' });
  });

  it('throws with a preview when there is no JSON at all', () => {
    expect(() => parseJsonReply('I cannot help with that.')).toThrow(/Could not parse JSON/);
  });
});
