/**
 * Critic prompts — one focused prompt per check.
 *
 * Four separate calls rather than one combined call: a single prompt asked to
 * do four unrelated jobs reliably under-reports on all four, and the boundary
 * check in particular must not be diluted.
 */

import type { BrandContext } from '../config/tenant.js';
import type { CriticCheckName, DraftArtefact, InterviewTranscript } from '../schemas/contracts.js';
import { brandReference, jsonOnlyInstruction, joinSections, numberedTranscript, optionalSection, section } from './shared.js';

const CHECK_SHAPE = `{
  "score": 0.0,
  "passed": "string — one line stating what the draft got right, or why it failed",
  "flags": ["string — one per problem: quote the offending text, name the rule it breaks, state the fix"]
}`;

export function criticSystemPrompt(ctx: BrandContext): string {
  return joinSections(
    `You are a demanding editorial critic reviewing a ${ctx.channel.name} written for ${ctx.brand.name} in ${ctx.author.name}'s voice.`,
    'You are not the writer and you are not here to be encouraging. Your job is to find what is wrong.',
    [
      'Scoring, 0 to 10:',
      '- 10: nothing to fix.',
      '- 8-9: publishable; only nitpicks remain.',
      '- 6-7: real problems a reader would notice.',
      '- 3-5: substantive failures against the reference material.',
      '- 0-2: unusable.',
      '',
      'Score honestly. An 8 means you would put your own name on it.',
      'Every flag must quote the specific offending text. A flag with no quote is not actionable — do not emit it.',
    ].join('\n'),
  );
}

function draftBlock(draft: DraftArtefact): string {
  return `# ${draft.title}\n\n${draft.body}`;
}

/** Contract 4 § Boundary Check — redlines and brand fit. */
export function boundaryCheckPrompt(draft: DraftArtefact, ctx: BrandContext): string {
  return joinSections(
    'Check this draft against the brand redlines and positioning.',
    section('Draft', draftBlock(draft)),
    section('Redlines — any violation is a hard fail', ctx.redlines),
    optionalSection(
      'Boundary rulings — calls the author has actually made. More specific than the ' +
        'redlines above, and they OVERRIDE the policy wherever the two disagree',
      ctx.redline_lessons,
    ),
    section('Positioning', ctx.positioning),
    optionalSection('Audiences', ctx.audiences),
    [
      'Judge only:',
      '1. Does the draft violate any redline? Quote the text and the redline it breaks.',
      '2. Is this the right brand for this argument, given the positioning?',
      '3. Does it make commitments, promises or claims of authority the brand has not earned?',
      '',
      'Score 5 or below if any redline is violated. Ignore voice and style — other checks cover those.',
    ].join('\n'),
    jsonOnlyInstruction(CHECK_SHAPE),
  );
}

/** Contract 4 § Voice Check — does it sound like the author. */
export function voiceCheckPrompt(draft: DraftArtefact, ctx: BrandContext): string {
  return joinSections(
    `Check whether this draft sounds like ${ctx.author.name}.`,
    section('Draft', draftBlock(draft)),
    section('Voice reference', ctx.voice),
    optionalSection(
      `Accumulated lessons (${ctx.author.lessons_file}) — past corrections, treat as binding`,
      ctx.lessons,
    ),
    [
      'Judge only:',
      '1. Banned phrases and words from the voice reference or the lessons file. Quote each one.',
      '2. Generic LLM cadence: triads, "it\'s not just X, it\'s Y", empty intensifiers, hedging, summary paragraphs that restate.',
      '3. Rhythm and register — does the sentence music match the reference?',
      '',
      'Ignore factual accuracy and structure — other checks cover those.',
    ].join('\n'),
    jsonOnlyInstruction(CHECK_SHAPE),
  );
}

/** Contract 4 § Traceability Check — claims map back to the interview. */
export function traceabilityCheckPrompt(
  draft: DraftArtefact,
  interview: InterviewTranscript,
): string {
  const map = draft.provenance.length
    ? draft.provenance.map((p) => `- "${p.claim}" → ${p.passage_ref}`).join('\n')
    : '(the writer supplied no provenance map)';

  return joinSections(
    'Verify that every claim in this draft traces to the interview transcript.',
    section('Draft', draftBlock(draft)),
    section('Claim → provenance map supplied by the writer', map),
    section('Interview transcript (line-numbered)', numberedTranscript(interview)),
    [
      'Judge only:',
      '1. For each mapped claim: does the cited line actually support it? Flag any citation that does not.',
      '2. Find substantive claims in the body that appear nowhere in the provenance map. Quote each one.',
      '3. Find claims that appear in neither the map nor the transcript — these are fabrications. Flag them first.',
      '',
      'Score 5 or below if the draft contains any claim the transcript does not support.',
    ].join('\n'),
    jsonOnlyInstruction(CHECK_SHAPE),
  );
}

/** Contract 4 § Claims Scope Check — no overgeneralisation. */
export function claimsScopeCheckPrompt(draft: DraftArtefact, ctx: BrandContext): string {
  return joinSections(
    'Check whether this draft overstates the scope of its claims.',
    section('Draft', draftBlock(draft)),
    optionalSection('Positioning', ctx.positioning),
    [
      'Judge only:',
      '1. Single examples generalised into universal rules ("every team", "always", "the only way").',
      '2. Correlation stated as causation.',
      '3. One client\'s or one sector\'s experience presented as an industry-wide truth.',
      '4. Predictions and numbers stated with more confidence than the evidence carries.',
      '',
      'For each, quote the sentence and give the narrower phrasing the evidence actually supports.',
    ].join('\n'),
    jsonOnlyInstruction(CHECK_SHAPE),
  );
}

export const CHECK_PROMPT_BUILDERS: Record<
  CriticCheckName,
  (draft: DraftArtefact, ctx: BrandContext, interview: InterviewTranscript) => string
> = {
  boundary: (draft, ctx) => boundaryCheckPrompt(draft, ctx),
  voice: (draft, ctx) => voiceCheckPrompt(draft, ctx),
  traceability: (draft, _ctx, interview) => traceabilityCheckPrompt(draft, interview),
  claims_scope: (draft, ctx) => claimsScopeCheckPrompt(draft, ctx),
};
