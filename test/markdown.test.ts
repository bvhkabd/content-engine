/**
 * Markdown round-trips for contracts 2, 3 and 4.
 *
 * The on-disk shape is the interoperability surface with a human editing files
 * in Drive, so these tests pin both directions: what we write, and what we can
 * read back after someone has edited it by hand.
 */

import { describe, expect, it } from 'vitest';
import {
  parseCriticReport,
  parseDraftArtefact,
  parseFrontmatter,
  parseInterviewQA,
  parseInterviewTranscript,
  serialiseCriticReport,
  serialiseDraftArtefact,
  serialiseFrontmatter,
  serialiseInterviewTranscript,
} from '../src/schemas/markdown.js';
import { validDraft, validInterview, validReport } from './contracts.test.js';

describe('frontmatter', () => {
  it('round-trips data and body', () => {
    const text = serialiseFrontmatter({ a: 1, b: 'two' }, '# Hello\n\nBody');
    const parsed = parseFrontmatter(text);
    expect(parsed.data).toEqual({ a: 1, b: 'two' });
    expect(parsed.body).toBe('# Hello\n\nBody');
  });

  it('treats a file with no frontmatter as all body', () => {
    const parsed = parseFrontmatter('Just some text');
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('Just some text');
  });

  it('tolerates a BOM and CRLF line endings', () => {
    const parsed = parseFrontmatter('﻿---\r\nspike_id: SPIKE-20260815-001\r\n---\r\nBody here');
    expect(parsed.data).toEqual({ spike_id: 'SPIKE-20260815-001' });
    expect(parsed.body).toBe('Body here');
  });

  it('does not treat a horizontal rule in the body as frontmatter', () => {
    const parsed = parseFrontmatter('Intro\n\n---\n\nMore');
    expect(parsed.data).toEqual({});
    expect(parsed.body).toContain('Intro');
  });
});

describe('Contract 2 — interview transcript', () => {
  it('round-trips', () => {
    const parsed = parseInterviewTranscript(serialiseInterviewTranscript(validInterview));
    expect(parsed.spike_id).toBe(validInterview.spike_id);
    expect(parsed.qa).toEqual(validInterview.qa);
    expect(parsed.body).toBe(validInterview.body);
  });

  it('parses multi-line answers and cites the answer line', () => {
    const qa = parseInterviewQA(
      ['Q: What happened?', 'A: They cut three layers.', 'Then nothing changed.', '', 'Q: Why?', 'A: The model never moved.'].join('\n'),
    );
    expect(qa).toHaveLength(2);
    expect(qa[0]!.answer).toBe('They cut three layers.\nThen nothing changed.');
    expect(qa[0]!.line).toBe(2); // the A: line, 1-based
    expect(qa[1]!.line).toBe(6);
  });

  it('drops a question with no answer', () => {
    const qa = parseInterviewQA('Q: Unanswered?\n\nQ: Answered?\nA: Yes.');
    expect(qa).toHaveLength(1);
    expect(qa[0]!.question).toBe('Answered?');
  });

  it('handles leading whitespace and a missing space after the marker', () => {
    const qa = parseInterviewQA('  Q:What happened?\n  A:Something did.');
    expect(qa).toEqual([{ question: 'What happened?', answer: 'Something did.', line: 2 }]);
  });

  it('returns no pairs for prose with no markers', () => {
    expect(parseInterviewQA('Just some notes about a topic.')).toEqual([]);
  });
});

describe('Contract 3 — draft artefact', () => {
  it('round-trips', () => {
    const parsed = parseDraftArtefact(serialiseDraftArtefact(validDraft));
    expect(parsed).toMatchObject({
      anchor_id: validDraft.anchor_id,
      spike_id: validDraft.spike_id,
      brand: validDraft.brand,
      channel: validDraft.channel,
      version: validDraft.version,
      title: validDraft.title,
      body: validDraft.body,
      provenance: validDraft.provenance,
      chosen_cta: validDraft.chosen_cta,
    });
  });

  it('writes the Working Notes block in the specified shape', () => {
    const text = serialiseDraftArtefact(validDraft);
    expect(text).toContain('## Working Notes');
    expect(text).toContain('claim→provenance map (Passage Ref format):');
    expect(text).toContain('- "They cut three layers" → Interview line 2');
    expect(text).toContain('chosen CTA: Book a diagnostic');
  });

  it('keeps a horizontal rule inside the article out of the Working Notes split', () => {
    const draft = { ...validDraft, body: 'Part one.\n\n---\n\nPart two.' };
    const parsed = parseDraftArtefact(serialiseDraftArtefact(draft));
    expect(parsed.body).toContain('Part one.');
    expect(parsed.body).toContain('Part two.');
    expect(parsed.provenance).toEqual(validDraft.provenance);
  });

  it('accepts a hand-edited plain -> arrow', () => {
    const text = serialiseDraftArtefact(validDraft).replace('→', '->');
    expect(parseDraftArtefact(text).provenance).toEqual(validDraft.provenance);
  });

  it('round-trips an empty provenance map and no CTA', () => {
    const draft = { ...validDraft, provenance: [], chosen_cta: '' };
    const parsed = parseDraftArtefact(serialiseDraftArtefact(draft));
    expect(parsed.provenance).toEqual([]);
    expect(parsed.chosen_cta).toBe('');
  });
});

describe('Contract 4 — critic report', () => {
  it('round-trips', () => {
    const parsed = parseCriticReport(serialiseCriticReport(validReport));
    expect(parsed.anchor_id).toBe(validReport.anchor_id);
    expect(parsed.version).toBe(validReport.version);
    expect(parsed.verdict).toBe(validReport.verdict);
    expect(parsed.checks).toEqual(validReport.checks);
    expect(parsed.outstanding_criticisms).toEqual(validReport.outstanding_criticisms);
  });

  it('writes the section headings from the spec', () => {
    const text = serialiseCriticReport(validReport);
    expect(text).toContain('## Boundary Check');
    expect(text).toContain('## Voice Check');
    expect(text).toContain('## Traceability Check');
    expect(text).toContain('## Claims Scope Check');
    expect(text).toContain('## Verdict');
    expect(text).toContain('Flags: none');
  });

  it('reads FAIL-AUTOMATIC without mistaking it for anything else', () => {
    const report = { ...validReport, verdict: 'FAIL-AUTOMATIC' as const };
    expect(parseCriticReport(serialiseCriticReport(report)).verdict).toBe('FAIL-AUTOMATIC');
  });

  it('round-trips a clean PASS with no flags', () => {
    const report = {
      ...validReport,
      verdict: 'PASS' as const,
      checks: validReport.checks.map((c) => ({ ...c, flags: [] })),
      outstanding_criticisms: [],
    };
    const parsed = parseCriticReport(serialiseCriticReport(report));
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.checks.every((c) => c.flags.length === 0)).toBe(true);
    expect(parsed.outstanding_criticisms).toEqual([]);
  });

  it('parses the numbered flag format from the spec example', () => {
    const text = [
      '---',
      'anchor_id: ABD-ARTICLE-20260815-001',
      'version: 1',
      'schema_version: 1',
      '---',
      '',
      '## Boundary Check',
      'Score: 8.5',
      'Passed: no redline violations, brand correct',
      'Flags: none',
      '',
      '## Voice Check',
      'Score: 7.2',
      'Passed: sounds like Harish',
      'Flags: 1. "unlock the potential" — banned phrase (lessons-harish.md)',
      '',
      '## Traceability Check',
      'Score: 9.0',
      'Passed: all claims mapped',
      'Flags: none',
      '',
      '## Claims Scope Check',
      'Score: 8.1',
      'Passed: no overgeneralizations',
      'Flags: none',
      '',
      '---',
      '## Verdict',
      'REVISE',
      'Outstanding criticisms: none',
    ].join('\n');

    const parsed = parseCriticReport(text);
    expect(parsed.checks).toHaveLength(4);
    expect(parsed.checks[0]).toEqual({
      name: 'boundary',
      score: 8.5,
      passed: 'no redline violations, brand correct',
      flags: [],
    });
    expect(parsed.checks[1]!.flags).toEqual(['"unlock the potential" — banned phrase (lessons-harish.md)']);
    expect(parsed.verdict).toBe('REVISE');
  });
});
