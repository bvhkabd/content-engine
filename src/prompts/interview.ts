/**
 * Adaptive interview prompts.
 *
 * Unlike the static guide in prompts/writer.ts, these generate one question at
 * a time with the whole conversation so far in view. The interviewer's job is
 * to extract evidence the writer can actually cite — numbers, incidents,
 * names of things that happened — and to notice when an answer dodged.
 */

import type { BrandContext } from '../config/tenant.js';
import type { SpikeRecord } from '../schemas/contracts.js';
import { jsonOnlyInstruction, joinSections, optionalSection, section, spikeBlock } from './shared.js';

export interface InterviewExchange {
  question: string;
  answer: string;
}

const NEXT_QUESTION_SHAPE = `{
  "done": false,
  "reason": "string — if done is true, why the interview has enough; otherwise \\"\\"",
  "question": "string — the single next question, asked directly, no preamble",
  "probing": "string — one short line on what this question is trying to surface"
}`;

export function interviewSystemPrompt(ctx: BrandContext): string {
  return joinSections(
    `You are interviewing ${ctx.author.name} to gather raw material for a ${ctx.channel.name} for ${ctx.brand.name}.`,
    'You are the interviewer, not the writer. You never draft prose and you never answer for them.',
    [
      'What you are trying to extract:',
      '- Concrete incidents. What happened, when, to whom, what changed.',
      '- Numbers, durations, counts — anything checkable.',
      '- The specific thing that surprised them, or that they got wrong.',
      '- The strongest argument against their own position.',
      '',
      'How to conduct it:',
      '- Ask ONE question at a time. Never stack two questions into one.',
      '- Build on what they just said. Quote their own words back when you dig in.',
      '- If an answer was vague or general, do not move on — ask for the specific instance.',
      '- If an answer was rich, move to new ground rather than mining it further.',
      '- If they say they lack the data or have not done the thing, accept it and move on.',
      '  Never push someone toward inventing a number. A conceded gap is usable; a fabricated statistic is not.',
      '- Vary the shape of your questions. Not every one should open with "Tell me about".',
      '',
      'Questions must be answerable in a couple of minutes of speech. No essay prompts.',
    ].join('\n'),
  );
}

/**
 * Ask for the next question given everything so far.
 *
 * `remaining` lets the model pace itself — it should be widening early and
 * closing gaps late — and it can end the interview early by returning done.
 */
export function nextQuestionPrompt(
  spike: SpikeRecord,
  ctx: BrandContext,
  exchanges: readonly InterviewExchange[],
  remaining: number,
): string {
  const transcript = exchanges.length
    ? exchanges.map((e, i) => `Q${i + 1}: ${e.question}\nA${i + 1}: ${e.answer}`).join('\n\n')
    : '(nothing yet — this is the opening question)';

  const pacing = exchanges.length === 0
    ? 'This is the first question. Open on the concrete: ask for a specific instance, not a definition or a philosophy.'
    : remaining <= 3
      ? `Only ${remaining} questions left. Close the gaps that matter most for writing this piece. ` +
        'If a counter-argument has not been probed yet, probe it now.'
      : `About ${remaining} questions left. There is room to open new ground.`;

  return joinSections(
    'Decide the next question in this interview.',
    section('The spike being explored', spikeBlock(spike)),
    optionalSection('Audiences this will be written for', ctx.audiences),
    optionalSection('Brand positioning', ctx.positioning),
    section('Interview so far', transcript),
    section('Pacing', pacing),
    [
      'Before you ask, check the transcript:',
      '- Has the last answer left something specific unexplored? Follow it.',
      '- Did the last answer dodge, generalise, or stay abstract? Ask for the instance.',
      '- Have you already asked something close to this? Do not repeat it.',
      '',
      'Set done to true only if the transcript already contains enough concrete material ' +
        'to write the piece — at least one worked example, some checkable detail, and one counter-argument. ' +
        'Otherwise keep going.',
    ].join('\n'),
    jsonOnlyInstruction(NEXT_QUESTION_SHAPE),
  );
}
