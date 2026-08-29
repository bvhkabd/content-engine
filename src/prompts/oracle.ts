/**
 * Oracle prompts — turn raw source material into candidate spikes.
 *
 * The model extracts and proposes; scoring and ranking happen in
 * engine/scoring.ts so the ordering is deterministic and auditable.
 */

import type { TenantConfig } from '../config/tenant.js';
import { jsonOnlyInstruction, joinSections, optionalSection, section } from './shared.js';

const SPIKE_SHAPE = `{
  "spikes": [
    {
      "brand": "string — one of the active brands listed above",
      "topic": "string — 3 to 10 words, the subject itself, not a headline",
      "angle": "string — one sentence: the specific argument or claim to make",
      "story_evidence": "string — the concrete detail, quote, number or example from the source that anchors it",
      "persona": "string — which audience this is for, from the audience reference",
      "pillar": "string — which content pillar, from the pillars listed above",
      "timeliness": "string — one line on why this is worth writing now",
      "novelty": 0.0,
      "specificity": 0.0,
      "relevance": 0.0
    }
  ]
}`;

export function oracleSystemPrompt(config: TenantConfig): string {
  return joinSections(
    'You scan raw source material and identify spikes: specific, defensible things worth writing about now.',
    [
      'What is a spike:',
      '- A concrete angle with evidence attached, not a topic area.',
      '- Something the author is positioned to say and most people are not.',
      '- Narrow enough that one article can actually settle it.',
      '',
      'What is not a spike:',
      '- "The importance of X." "Why X matters." Anything that could have been written last year.',
      '- Anything with no evidence in the source material.',
      '- Restating what the source already said.',
    ].join('\n'),
    'Return nothing rather than pad the list. Zero spikes is a valid and common answer.',
  );
}

export interface SourceItem {
  kind: string;
  reference: string;
  title: string;
  content: string;
}

export function extractSpikesPrompt(
  items: SourceItem[],
  config: TenantConfig,
  reference: { audiences: string; positioning: string; seasonality: string },
  existingTopics: string[],
): string {
  const pillars = [...new Set(Object.values(config.brands).flatMap((b) => b.pillars))];

  const sourceBlock = items
    .map((item, i) =>
      [
        `### Source ${i + 1} — ${item.kind}: ${item.title}`,
        `Reference: ${item.reference}`,
        '',
        truncate(item.content, 6000),
      ].join('\n'),
    )
    .join('\n\n---\n\n');

  return joinSections(
    'Read the source material and extract every spike worth writing about.',
    section('Active brands', config.active_brands.join(', ')),
    pillars.length ? section('Content pillars', pillars.join(', ')) : '',
    optionalSection('Audiences', reference.audiences),
    optionalSection('Positioning', reference.positioning),
    optionalSection('Seasonality — what is timely right now', reference.seasonality),
    existingTopics.length
      ? section(
          'Already in the vault — do not propose these again',
          existingTopics.slice(0, 200).map((t) => `- ${t}`).join('\n'),
        )
      : '',
    section('Source material', sourceBlock),
    [
      'Score each spike 0-10 on three axes, judged independently:',
      '- novelty: how much this differs from what is already in the vault and from the obvious take.',
      '- specificity: how concrete the evidence is. A named number or a real incident scores high; a general observation scores low.',
      '- relevance: fit with the positioning, audiences and pillars.',
      '',
      'Assign each spike to exactly one active brand.',
      'At most 3 spikes per source. If a source yields nothing, skip it.',
    ].join('\n'),
    jsonOnlyInstruction(SPIKE_SHAPE),
  );
}

function truncate(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}\n…[truncated]`;
}
