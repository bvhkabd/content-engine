/**
 * Writer prompts — draft generation and revision.
 */

import type { BrandContext, TenantConfig } from '../config/tenant.js';
import type { CriticReport, DraftArtefact, InterviewTranscript, SpikeRecord } from '../schemas/contracts.js';
import {
  PROVENANCE_RULES,
  brandReference,
  jsonOnlyInstruction,
  joinSections,
  numberedTranscript,
  optionalSection,
  section,
  spikeBlock,
} from './shared.js';

const DRAFT_SHAPE = `{
  "title": "string — the article headline, no markdown",
  "body": "string — the full article in markdown, WITHOUT the H1 title",
  "provenance": [
    { "claim": "the exact claim sentence as it appears in your body", "passage_ref": "Interview line 15" }
  ],
  "chosen_cta": "string — the CTA you selected, quoted from the CTA reference"
}`;

export function systemPrompt(tenant: TenantConfig, ctx: BrandContext): string {
  return joinSections(
    `You are a ghostwriter for ${ctx.author.name}, writing as ${ctx.brand.name} for the ${ctx.channel.name} channel.`,
    'You write in the author\'s voice, not your own. The reader should never suspect a machine was involved.',
    brandReference(ctx),
    section('Channel', [
      `Channel: ${ctx.channel.name} (${ctx.channel.key})`,
      `Target length: about ${ctx.channel.target_words} words`,
      ctx.channel.structure_notes ? `Structure: ${ctx.channel.structure_notes}` : '',
    ].filter(Boolean).join('\n')),
    section('Provenance rules', PROVENANCE_RULES),
  );
}

export function interviewPrompt(spike: SpikeRecord, tenant: TenantConfig, ctx: BrandContext): string {
  return joinSections(
    `Generate an interview guide that will extract everything needed to write a ${ctx.channel.name} on this spike.`,
    section('Spike', spikeBlock(spike)),
    section('Audiences', ctx.audiences),
    [
      'Rules:',
      '- 8 to 12 questions, ordered so each one builds on the last.',
      '- Ask for specifics: numbers, names, dates, what actually happened, what went wrong.',
      '- At least three questions must dig for a concrete story or worked example.',
      '- At least one question must probe the strongest counter-argument to the angle.',
      '- No question the author can answer with a generality. If it invites a platitude, rewrite it.',
      '',
      `Output the guide as markdown, one "Q: " line per question, ready to paste into an interview file.`,
      `Do not write any answers.`,
    ].join('\n'),
  );
}

export function writeDraftPrompt(
  interview: InterviewTranscript,
  spike: SpikeRecord,
  ctx: BrandContext,
): string {
  return joinSections(
    `Write the ${ctx.channel.name} from the interview below.`,
    section('Spike', spikeBlock(spike)),
    section('Interview transcript (line-numbered)', numberedTranscript(interview)),
    section('Available CTAs — choose exactly one, quoted verbatim', ctx.ctas),
    [
      'Requirements:',
      `- About ${ctx.channel.target_words} words.`,
      '- Open with something concrete from the transcript. No throat-clearing, no "in today\'s fast-paced world".',
      '- Use the author\'s own phrasing where the transcript gives you good phrasing.',
      '- End with exactly one CTA, chosen from the CTA reference above and quoted as written.',
      '- Every claim in the provenance list must appear verbatim in your body text.',
      '- List every substantive claim in the provenance array. A body claim with no provenance entry is a defect.',
    ].join('\n'),
    jsonOnlyInstruction(DRAFT_SHAPE),
  );
}

export function revisePrompt(
  draft: DraftArtefact,
  report: CriticReport,
  interview: InterviewTranscript,
  ctx: BrandContext,
  operatorNotes: string,
): string {
  const criticisms = report.checks
    .flatMap((c) => c.flags.map((f) => `- [${c.name}] ${f}`))
    .concat(report.outstanding_criticisms.map((c) => `- ${c}`))
    .join('\n');

  return joinSections(
    `Revise the draft below. It came back ${report.verdict} from the critic.`,
    section('Current draft', `# ${draft.title}\n\n${draft.body}`),
    section('Criticisms to resolve', criticisms || '(none itemised — improve voice and specificity)'),
    optionalSection('Operator notes — these take priority over the critic', operatorNotes),
    section('Interview transcript (line-numbered)', numberedTranscript(interview)),
    section('Available CTAs — choose exactly one, quoted verbatim', ctx.ctas),
    [
      'Rules:',
      '- Fix every criticism. Do not rewrite parts that were not criticised.',
      '- Do not introduce facts absent from the transcript while fixing anything.',
      '- Return the complete revised article, not a diff or a summary of changes.',
      '- Rebuild the provenance list against your revised body.',
    ].join('\n'),
    jsonOnlyInstruction(DRAFT_SHAPE),
  );
}
