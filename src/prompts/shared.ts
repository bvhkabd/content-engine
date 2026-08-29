/**
 * Prompt building blocks shared by writer / critic / bundler / oracle.
 *
 * Nothing in src/prompts/ contains a tenant fact. Brand voice, redlines,
 * audiences and CTAs arrive as text loaded from the data layer and are pasted
 * in verbatim under labelled headings.
 */

import type { BrandContext } from '../config/tenant.js';
import type { InterviewTranscript, SpikeRecord } from '../schemas/contracts.js';

/** Render a labelled reference block, or a clear placeholder when absent. */
export function section(title: string, content: string): string {
  const body = content.trim();
  if (!body) return `## ${title}\n(none supplied — do not invent one)`;
  return `## ${title}\n${body}`;
}

/** Only include the section if there is something in it. */
export function optionalSection(title: string, content: string): string {
  return content.trim() ? `## ${title}\n${content.trim()}` : '';
}

export function joinSections(...parts: (string | undefined)[]): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The interview with 1-based line numbers, which is what makes
 * "Interview line 15" a checkable reference rather than a guess.
 */
export function numberedTranscript(interview: InterviewTranscript): string {
  // Numbers are padded on the right, not the left: these blocks get trimmed
  // when they are pasted into a section, which would strip the first line's
  // leading spaces and knock the whole column out of alignment.
  return interview.body
    .split(/\r?\n/)
    .map((line, i) => `${String(i + 1).padEnd(4, ' ')} | ${line}`)
    .join('\n');
}

export function spikeBlock(spike: SpikeRecord): string {
  return [
    `Spike ID: ${spike.spike_id}`,
    `Topic: ${spike.topic}`,
    `Angle: ${spike.angle}`,
    `Story / evidence: ${spike.story_evidence || '(none recorded)'}`,
    `Target persona: ${spike.persona || '(unspecified)'}`,
    `Content pillar: ${spike.pillar || '(unspecified)'}`,
    `Why now: ${spike.timeliness || '(unspecified)'}`,
    `Source: ${spike.source}${spike.source_ref ? ` (${spike.source_ref})` : ''}`,
  ].join('\n');
}

/** The brand/voice reference stack, in the order the model should weigh it. */
export function brandReference(ctx: BrandContext): string {
  return joinSections(
    section(`Brand: ${ctx.brand.name} (${ctx.brand.key})`, ctx.positioning),
    section('Audiences', ctx.audiences),
    section('Voice', ctx.voice),
    section('Redlines — never violate these', ctx.redlines),
    optionalSection('Accumulated lessons (past corrections; these override general voice guidance)', ctx.lessons),
  );
}

/** Standing rule set applied to every generation call. */
export const PROVENANCE_RULES = [
  'Every factual claim, statistic, anecdote, client detail and opinion must come from the interview transcript.',
  'You may rephrase for clarity and flow. You may not introduce facts that are not in the transcript.',
  'If the transcript does not support a point you want to make, leave the point out.',
  'Cite provenance as "Interview line N", using the line numbers shown in the transcript.',
].join('\n');

export function jsonOnlyInstruction(shape: string): string {
  return [
    'Respond with a single JSON object and nothing else.',
    'No prose before or after. No markdown code fences.',
    '',
    'Shape:',
    shape,
  ].join('\n');
}
