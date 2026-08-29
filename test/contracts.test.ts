/**
 * Contract validation — one describe per contract.
 *
 * Each contract gets: a valid fixture that passes, and targeted invalid cases
 * that must fail. The point is that a bad row from the sheet or a bad payload
 * from the model can never be mistaken for a good one.
 */

import { describe, expect, it } from 'vitest';
import {
  ASSET_TYPES,
  CRITIC_CHECKS,
  EDITIONS_COLUMNS,
  EDITIONS_FIELDS,
  REPURPOSING_COLUMNS,
  REPURPOSING_FIELDS,
  SCHEMA_VERSION,
  SPIKE_STATUSES,
  VAULT_COLUMNS,
  VAULT_FIELDS,
  assertValid,
  overallCriticScore,
  validateCriticReport,
  validateDerivedAsset,
  validateDraftArtefact,
  validateEditionRecord,
  validateInterviewTranscript,
  validateSpikeRecord,
  type CriticReport,
  type DerivedAsset,
  type DraftArtefact,
  type EditionRecord,
  type InterviewTranscript,
  type SpikeRecord,
} from '../src/schemas/contracts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const validSpike: SpikeRecord = {
  spike_id: 'SPIKE-20260815-001',
  date: '2026-08-15',
  brand: 'ABD',
  author: 'harish',
  source: 'email',
  source_ref: '<msg-123@example.com>',
  topic: 'Operating model drift',
  angle: 'Reorgs fail because the operating model never moved',
  story_evidence: 'Client cut 3 layers, cycle time unchanged after 9 months',
  persona: 'COO',
  pillar: 'operating model',
  timeliness: 'Planning season starts next month',
  score: 8.2,
  status: 'NEW',
  used_in: '',
  notes: '',
};

export const validInterview: InterviewTranscript = {
  spike_id: 'SPIKE-20260815-001',
  tenant: 'harish',
  brand: 'ABD',
  author: 'harish',
  date: '2026-08-15',
  schema_version: SCHEMA_VERSION,
  qa: [{ question: 'What happened?', answer: 'They cut three layers.', line: 2 }],
  body: 'Q: What happened?\nA: They cut three layers.',
};

export const validDraft: DraftArtefact = {
  anchor_id: 'ABD-ARTICLE-20260815-001',
  spike_id: 'SPIKE-20260815-001',
  brand: 'ABD',
  author: 'harish',
  channel: 'website-article',
  version: 1,
  schema_version: SCHEMA_VERSION,
  title: 'The reorg that changed nothing',
  body: 'They cut three layers and cycle time did not move.',
  provenance: [{ claim: 'They cut three layers', passage_ref: 'Interview line 2' }],
  chosen_cta: 'Book a diagnostic',
};

export const validReport: CriticReport = {
  anchor_id: 'ABD-ARTICLE-20260815-001',
  version: 1,
  schema_version: SCHEMA_VERSION,
  checks: [
    { name: 'boundary', score: 8.5, passed: 'no redline violations', flags: [] },
    { name: 'voice', score: 7.2, passed: 'sounds like Harish', flags: ['"unlock the potential" — banned phrase'] },
    { name: 'traceability', score: 9, passed: 'all claims mapped', flags: [] },
    { name: 'claims_scope', score: 8.1, passed: 'no overgeneralizations', flags: [] },
  ],
  verdict: 'REVISE',
  outstanding_criticisms: ['[voice] "unlock the potential" — banned phrase'],
};

export const validEdition: EditionRecord = {
  edition: 'ABD-ARTICLE-20260815-001',
  date_published: '',
  brand: 'ABD',
  author: 'harish',
  topic: 'Operating model drift',
  issue_number: '12',
  status: 'DRAFT',
  newsletter_link: '',
  metrics_30d: '',
  notes: '',
};

export const validAsset: DerivedAsset = {
  anchor_id: 'ABD-ARTICLE-20260815-001',
  asset_type: 'linkedin-post',
  text: 'They cut three layers. Cycle time did not move.',
  status: 'PROPOSED',
  passage_ref: 'Article section: The reorg that changed nothing',
  published_link: '',
  metrics_30d: '',
  notes: 'Narrative angle',
};

// ---------------------------------------------------------------------------

describe('Contract 1 — SpikeRecord', () => {
  it('accepts a valid record', () => {
    expect(validateSpikeRecord(validSpike)).toEqual({ ok: true, errors: [] });
  });

  it('column headers and field keys stay in lockstep', () => {
    expect(VAULT_COLUMNS).toHaveLength(VAULT_FIELDS.length);
    expect(VAULT_FIELDS).toEqual(Object.keys(validSpike));
  });

  it.each(SPIKE_STATUSES)('accepts status %s', (status) => {
    expect(validateSpikeRecord({ ...validSpike, status }).ok).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = validateSpikeRecord({ ...validSpike, status: 'IN_PROGRESS' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('status');
  });

  it('rejects a malformed spike ID', () => {
    expect(validateSpikeRecord({ ...validSpike, spike_id: 'SPIKE-1' }).ok).toBe(false);
  });

  it('rejects a non-ISO date', () => {
    expect(validateSpikeRecord({ ...validSpike, date: '15/08/2026' }).ok).toBe(false);
  });

  it('rejects a score outside 0-10', () => {
    expect(validateSpikeRecord({ ...validSpike, score: 11 }).ok).toBe(false);
    expect(validateSpikeRecord({ ...validSpike, score: -1 }).ok).toBe(false);
  });

  it('rejects a score that arrived as a string', () => {
    expect(validateSpikeRecord({ ...validSpike, score: '8.2' }).ok).toBe(false);
  });

  it('requires topic and angle but allows empty optional columns', () => {
    expect(validateSpikeRecord({ ...validSpike, topic: '   ' }).ok).toBe(false);
    expect(validateSpikeRecord({ ...validSpike, notes: '', used_in: '' }).ok).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(validateSpikeRecord(null).ok).toBe(false);
    expect(validateSpikeRecord('SPIKE-20260815-001').ok).toBe(false);
  });
});

describe('Contract 2 — InterviewTranscript', () => {
  it('accepts a valid transcript', () => {
    expect(validateInterviewTranscript(validInterview).ok).toBe(true);
  });

  it('rejects a transcript with no Q/A pairs', () => {
    const result = validateInterviewTranscript({ ...validInterview, qa: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('no Q:/A: pairs');
  });

  it('reports the index of a malformed pair', () => {
    const result = validateInterviewTranscript({
      ...validInterview,
      qa: [validInterview.qa[0], { question: 'Why?', answer: '', line: 4 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('qa[1].answer');
  });

  it('rejects a zero or negative line number', () => {
    const result = validateInterviewTranscript({
      ...validInterview,
      qa: [{ question: 'Q', answer: 'A', line: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  it('requires the spike ID to be well formed', () => {
    expect(validateInterviewTranscript({ ...validInterview, spike_id: 'nope' }).ok).toBe(false);
  });
});

describe('Contract 3 — DraftArtefact', () => {
  it('accepts a valid draft', () => {
    expect(validateDraftArtefact(validDraft).ok).toBe(true);
  });

  it('rejects a malformed anchor ID', () => {
    expect(validateDraftArtefact({ ...validDraft, anchor_id: 'ABD-2026-1' }).ok).toBe(false);
  });

  it('rejects version 0', () => {
    expect(validateDraftArtefact({ ...validDraft, version: 0 }).ok).toBe(false);
  });

  it('requires a title and a body', () => {
    expect(validateDraftArtefact({ ...validDraft, title: '' }).ok).toBe(false);
    expect(validateDraftArtefact({ ...validDraft, body: '  ' }).ok).toBe(false);
  });

  it('allows an empty provenance list but not a malformed entry', () => {
    expect(validateDraftArtefact({ ...validDraft, provenance: [] }).ok).toBe(true);
    const result = validateDraftArtefact({
      ...validDraft,
      provenance: [{ claim: 'x', passage_ref: '' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('provenance[0].passage_ref');
  });
});

describe('Contract 4 — CriticReport', () => {
  it('accepts a valid report', () => {
    expect(validateCriticReport(validReport).ok).toBe(true);
  });

  it('rejects a report missing a check', () => {
    const result = validateCriticReport({
      ...validReport,
      checks: validReport.checks.filter((c) => c.name !== 'boundary'),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('missing required check "boundary"');
  });

  it('rejects a duplicated check', () => {
    const result = validateCriticReport({
      ...validReport,
      checks: [...validReport.checks, validReport.checks[0]],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('duplicate check "boundary"');
  });

  it('requires all four named checks', () => {
    expect(CRITIC_CHECKS).toEqual(['boundary', 'voice', 'traceability', 'claims_scope']);
  });

  it('rejects an unknown verdict', () => {
    expect(validateCriticReport({ ...validReport, verdict: 'MAYBE' }).ok).toBe(false);
  });

  it('rejects flags that are not an array', () => {
    const result = validateCriticReport({
      ...validReport,
      checks: validReport.checks.map((c) => (c.name === 'voice' ? { ...c, flags: 'one flag' } : c)),
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('flags');
  });

  it('averages the four scores', () => {
    // (8.5 + 7.2 + 9 + 8.1) / 4 = 8.2
    expect(overallCriticScore(validReport)).toBe(8.2);
  });
});

describe('Contract 5 — EditionRecord', () => {
  it('accepts a valid row', () => {
    expect(validateEditionRecord(validEdition).ok).toBe(true);
  });

  it('column headers and field keys stay in lockstep', () => {
    expect(EDITIONS_COLUMNS).toHaveLength(EDITIONS_FIELDS.length);
    expect(EDITIONS_FIELDS).toEqual(Object.keys(validEdition));
  });

  it('rejects an unknown status', () => {
    expect(validateEditionRecord({ ...validEdition, status: 'PUBLISHED' }).ok).toBe(false);
  });

  it('allows an empty publish date while still in DRAFT', () => {
    expect(validateEditionRecord({ ...validEdition, date_published: '' }).ok).toBe(true);
  });
});

describe('Contract 6 — DerivedAsset', () => {
  it('accepts a valid row', () => {
    expect(validateDerivedAsset(validAsset).ok).toBe(true);
  });

  it('column headers and field keys stay in lockstep', () => {
    expect(REPURPOSING_COLUMNS).toHaveLength(REPURPOSING_FIELDS.length);
    expect(REPURPOSING_FIELDS).toEqual(Object.keys(validAsset));
  });

  it.each(ASSET_TYPES)('accepts asset type %s', (assetType) => {
    expect(validateDerivedAsset({ ...validAsset, asset_type: assetType }).ok).toBe(true);
  });

  it('rejects an unknown asset type', () => {
    expect(validateDerivedAsset({ ...validAsset, asset_type: 'instagram-reel' }).ok).toBe(false);
  });

  it('requires a passage ref — every asset must trace to the anchor', () => {
    const result = validateDerivedAsset({ ...validAsset, passage_ref: '' });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toContain('passage_ref');
  });

  it('rejects empty text', () => {
    expect(validateDerivedAsset({ ...validAsset, text: '' }).ok).toBe(false);
  });
});

describe('assertValid', () => {
  it('passes through when valid', () => {
    expect(() => assertValid(validateSpikeRecord(validSpike), 'Spike')).not.toThrow();
  });

  it('throws with the label and every error listed', () => {
    expect(() => assertValid(validateSpikeRecord({ ...validSpike, score: 99 }), 'Spike X')).toThrow(
      /Spike X failed contract validation[\s\S]*score/,
    );
  });
});
