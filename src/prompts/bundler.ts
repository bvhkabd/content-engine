/**
 * Bundler prompts — derive social/audio/video assets from an approved draft.
 *
 * One call per asset type. Each asset must carry a Passage Ref back into the
 * anchor article, so Contract 6 rows stay traceable.
 */

import type { BrandContext, BundleItem } from '../config/tenant.js';
import type { DraftArtefact, InterviewTranscript } from '../schemas/contracts.js';
import { brandReference, jsonOnlyInstruction, joinSections, numberedTranscript, optionalSection, section } from './shared.js';

const BUNDLE_SHAPE = `{
  "assets": [
    {
      "text": "string — the complete asset, ready to publish as-is",
      "passage_ref": "string — where in the anchor this came from, e.g. \\"Article section: The cost of drift\\" or \\"Interview line 22\\"",
      "notes": "string — one line on the intended use or hook angle"
    }
  ]
}`;

export function bundlerSystemPrompt(ctx: BrandContext): string {
  return joinSections(
    `You repurpose long-form work into channel-native assets for ${ctx.brand.name}, in ${ctx.author.name}'s voice.`,
    brandReference(ctx),
    [
      'Standing rules:',
      '- Every asset must stand alone. A reader who never opens the article must still get something whole.',
      '- Never introduce a fact that is not in the anchor article or the interview.',
      '- Do not write engagement bait, "thread 🧵" theatre, or "hot take:" openers.',
      '- No hashtags unless the voice reference explicitly asks for them.',
      '- Each asset needs a Passage Ref pointing at what it was derived from.',
    ].join('\n'),
  );
}

/** Per-format craft guidance. Tenant `notes` are appended and take priority. */
const FORMAT_GUIDANCE: Record<string, string> = {
  'linkedin-post': [
    '150-250 words. First line is the hook and must work as a truncated preview.',
    'Short paragraphs, one idea each. A concrete story or number in the first third.',
    'Close with a question or an invitation, not a summary.',
  ].join('\n'),
  'x-thread': [
    '5-8 posts, each under 280 characters.',
    'Number them "1/", "2/" and so on. Post 1 must earn the click on its own.',
    'Return the whole thread as one string with a blank line between posts.',
  ].join('\n'),
  tweet: [
    'Under 280 characters. One idea, quotable on its own, no thread.',
    'No preamble, no "I\'ve been thinking about".',
  ].join('\n'),
  'podcast-clip': [
    '60-90 seconds of spoken talking points — roughly 150-220 words.',
    'Written to be said out loud: contractions, short clauses, no bullet syntax.',
    'Open on the sharpest line, not on context.',
  ].join('\n'),
  'shorts-script': [
    '30-45 seconds of vertical video — roughly 80-120 words.',
    'Format as: HOOK (first 3 seconds), then the beats, then the payoff.',
    'Include a bracketed visual cue per beat, e.g. [on screen: the three-column chart].',
  ].join('\n'),
};

export function bundleAssetPrompt(
  item: BundleItem,
  draft: DraftArtefact,
  interview: InterviewTranscript,
  ctx: BrandContext,
): string {
  const guidance = FORMAT_GUIDANCE[item.asset_type] ?? '';
  const plural = item.count === 1 ? 'asset' : 'assets';

  return joinSections(
    `Produce exactly ${item.count} ${item.asset_type} ${plural} from the anchor article below.`,
    section('Anchor article', `# ${draft.title}\n\n${draft.body}`),
    section('Interview transcript (line-numbered, for extra detail and provenance)', numberedTranscript(interview)),
    optionalSection('CTAs — use at most one, and only where it fits the format', ctx.ctas),
    section(`Format rules — ${item.asset_type}`, guidance),
    optionalSection('Tenant notes for this asset type — these override the format rules', item.notes),
    item.count > 1
      ? 'The assets must take genuinely different angles on the article. Two variations of one idea is a failure.'
      : '',
    jsonOnlyInstruction(BUNDLE_SHAPE),
  );
}
