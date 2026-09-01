/**
 * Adaptive interview — the pure parts.
 *
 * The critical property is that what `interview` writes, `session` reads:
 * the transcript must round-trip through parseInterviewQA with the same pairs
 * and usable line numbers, because the writer cites "Interview line N".
 */

import { describe, expect, it } from 'vitest';
import { buildTranscript, parseCommand, type TranscriptMeta } from '../src/skills/interview.js';
import { parseInterviewQA, parseInterviewTranscript } from '../src/schemas/markdown.js';
import { validateInterviewTranscript } from '../src/schemas/contracts.js';
import { nextQuestionPrompt } from '../src/prompts/interview.js';
import { parseTenantConfig } from '../src/config/tenant.js';
import type { BrandContext } from '../src/config/tenant.js';
import { validSpike } from './contracts.test.js';

const meta: TranscriptMeta = {
  spike_id: 'SPIKE-20260815-001',
  tenant: 'harish',
  brand: 'ABD',
  author: 'harish',
  date: '2026-08-15',
};

const exchanges = [
  { question: 'What actually happened?', answer: 'They cut three layers of management.' },
  { question: 'And the result?', answer: 'Cycle time did not move in nine months.' },
];

describe('buildTranscript', () => {
  it('produces a Contract 2 transcript that validates', () => {
    const parsed = parseInterviewTranscript(buildTranscript(exchanges, meta));
    expect(validateInterviewTranscript(parsed).ok).toBe(true);
  });

  it('round-trips every pair back through the session parser', () => {
    const qa = parseInterviewQA(parseInterviewTranscript(buildTranscript(exchanges, meta)).body);
    expect(qa.map((p) => ({ question: p.question, answer: p.answer }))).toEqual(exchanges);
  });

  it('writes frontmatter the session relies on', () => {
    const parsed = parseInterviewTranscript(buildTranscript(exchanges, meta));
    expect(parsed).toMatchObject({
      spike_id: meta.spike_id,
      tenant: meta.tenant,
      brand: meta.brand,
      author: meta.author,
      date: meta.date,
      schema_version: 1,
    });
  });

  it('gives each answer a distinct, citable line number', () => {
    const qa = parseInterviewQA(parseInterviewTranscript(buildTranscript(exchanges, meta)).body);
    const lines = qa.map((p) => p.line);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.every((l) => l > 0)).toBe(true);
  });

  it('survives answers containing colons, quotes and Q:/A: text', () => {
    const tricky = [
      { question: 'What did they say?', answer: 'He said: "Q: why bother?" and left.' },
    ];
    const qa = parseInterviewQA(parseInterviewTranscript(buildTranscript(tricky, meta)).body);
    expect(qa).toHaveLength(1);
    expect(qa[0]!.answer).toBe('He said: "Q: why bother?" and left.');
  });

  it('keeps multi-line answers intact', () => {
    const multi = [{ question: 'Walk me through it.', answer: 'First this.\nThen that.' }];
    const qa = parseInterviewQA(parseInterviewTranscript(buildTranscript(multi, meta)).body);
    expect(qa[0]!.answer).toBe('First this.\nThen that.');
  });

  it('is resumable — parsing its own output yields the same exchanges', () => {
    const first = buildTranscript(exchanges, meta);
    const reloaded = parseInterviewQA(first).map((p) => ({ question: p.question, answer: p.answer }));
    expect(buildTranscript(reloaded, meta)).toBe(first);
  });

  it('handles an empty interview without producing a broken file', () => {
    const parsed = parseInterviewTranscript(buildTranscript([], meta));
    expect(parsed.qa).toEqual([]);
    expect(parsed.spike_id).toBe(meta.spike_id);
  });
});

describe('parseCommand', () => {
  it.each(['done', 'DONE', '  done  '])('recognises %s as finish', (line) => {
    expect(parseCommand(line)?.command).toBe('done');
  });

  it('recognises skip and quit', () => {
    expect(parseCommand('skip')?.command).toBe('skip');
    expect(parseCommand('quit')?.command).toBe('quit');
    expect(parseCommand('exit')?.command).toBe('quit');
  });

  it('treats ordinary answers as answers, not commands', () => {
    expect(parseCommand('We were done by March')).toBeNull();
    expect(parseCommand('I had to skip that meeting')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('nextQuestionPrompt', () => {
  const config = parseTenantConfig(
    'harish',
    'tenant: harish\nactive_brands: [ABD]\nauthors:\n  harish:\n    name: Harish\n',
  );
  const ctx: BrandContext = {
    brand: config.brands.ABD!,
    author: config.authors.harish!,
    channel: config.channels['website-article']!,
    voice: '',
    redlines: '',
    redline_lessons: '',
    positioning: 'Operating model consultancy.',
    audiences: 'COOs.',
    ctas: '',
    lessons: '',
    seasonality: '',
  };

  it('tells the model it is the opening question when nothing has been asked', () => {
    const prompt = nextQuestionPrompt(validSpike, ctx, [], 12);
    expect(prompt).toContain('this is the opening question');
    expect(prompt).toContain(validSpike.topic);
  });

  it('includes the transcript so far', () => {
    const prompt = nextQuestionPrompt(validSpike, ctx, exchanges, 10);
    expect(prompt).toContain('They cut three layers of management.');
    expect(prompt).toContain('Q2: And the result?');
  });

  it('switches to closing guidance near the end', () => {
    expect(nextQuestionPrompt(validSpike, ctx, exchanges, 2)).toContain('Close the gaps');
    expect(nextQuestionPrompt(validSpike, ctx, exchanges, 8)).toContain('room to open new ground');
  });
});
