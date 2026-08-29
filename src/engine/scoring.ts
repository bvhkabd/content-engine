/**
 * Spike scoring and ranking. Pure functions, no I/O, no LLM.
 *
 * The model supplies three raw axes per candidate; the ranking that decides
 * what lands in the top 6 is computed here so it is deterministic, tunable and
 * explainable after the fact.
 */

import type { SpikeRecord } from '../schemas/contracts.js';

export interface CandidateSpike {
  brand: string;
  topic: string;
  angle: string;
  story_evidence: string;
  persona: string;
  pillar: string;
  timeliness: string;
  novelty: number;
  specificity: number;
  relevance: number;
  source: string;
  source_ref: string;
}

export interface ScoredSpike extends CandidateSpike {
  score: number;
  /** Human-readable breakdown, written to the Notes column. */
  rationale: string;
}

export const SCORE_WEIGHTS = {
  novelty: 0.3,
  specificity: 0.4, // concrete evidence is what makes a spike writable
  relevance: 0.3,
} as const;

/** Penalty applied when a candidate looks like something already in the vault. */
export const DUPLICATE_PENALTY = 4;
/** Similarity above this counts as a duplicate. */
export const DUPLICATE_THRESHOLD = 0.6;
/** Bonus when the candidate matches a live seasonality keyword. */
export const SEASONALITY_BONUS = 1;

function clamp(value: unknown, min = 0, max = 10): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Text similarity — deliberately crude. It only needs to catch "we already
// have a spike about this", not to do semantic search.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'as',
  'at', 'by', 'from', 'how', 'why', 'what', 'when', 'your', 'you',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/** Jaccard similarity over content words, 0..1. */
export function similarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / (setA.size + setB.size - shared);
}

export function bestSimilarity(text: string, corpus: readonly string[]): number {
  return corpus.reduce((max, entry) => Math.max(max, similarity(text, entry)), 0);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreSpike(
  candidate: CandidateSpike,
  existingTopics: readonly string[],
  seasonalKeywords: readonly string[],
): ScoredSpike {
  const novelty = clamp(candidate.novelty);
  const specificity = clamp(candidate.specificity);
  const relevance = clamp(candidate.relevance);

  const base =
    novelty * SCORE_WEIGHTS.novelty +
    specificity * SCORE_WEIGHTS.specificity +
    relevance * SCORE_WEIGHTS.relevance;

  const subject = `${candidate.topic} ${candidate.angle}`;
  const dupe = bestSimilarity(subject, existingTopics);
  const duplicatePenalty = dupe >= DUPLICATE_THRESHOLD ? DUPLICATE_PENALTY : 0;

  const matchedSeason = seasonalKeywords.filter((keyword) =>
    keyword.trim() !== '' && subject.toLowerCase().includes(keyword.toLowerCase()),
  );
  const seasonBonus = matchedSeason.length > 0 ? SEASONALITY_BONUS : 0;

  const score = round1(Math.max(0, Math.min(10, base - duplicatePenalty + seasonBonus)));

  const parts = [
    `n${round1(novelty)}`,
    `s${round1(specificity)}`,
    `r${round1(relevance)}`,
    `base ${round1(base)}`,
  ];
  if (duplicatePenalty) parts.push(`-${duplicatePenalty} near-duplicate (${round1(dupe * 100)}% overlap)`);
  if (seasonBonus) parts.push(`+${seasonBonus} seasonal (${matchedSeason.join(', ')})`);

  return { ...candidate, novelty, specificity, relevance, score, rationale: parts.join(' | ') };
}

/** Score, drop near-duplicates within the batch, sort high to low. */
export function rankSpikes(
  candidates: readonly CandidateSpike[],
  existingTopics: readonly string[],
  seasonalKeywords: readonly string[],
): ScoredSpike[] {
  const accepted: ScoredSpike[] = [];
  const corpus = [...existingTopics];

  for (const candidate of candidates) {
    const scored = scoreSpike(candidate, corpus, seasonalKeywords);
    // Feed accepted candidates back into the corpus so two near-identical
    // spikes from different sources do not both survive this run.
    corpus.push(`${candidate.topic} ${candidate.angle}`);
    accepted.push(scored);
  }

  return accepted.sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic));
}

/** Topic+angle strings for everything already in the vault. */
export function vaultTopics(spikes: readonly SpikeRecord[]): string[] {
  return spikes
    .filter((s) => s.status !== 'KILLED')
    .map((s) => `${s.topic} ${s.angle}`.trim())
    .filter(Boolean);
}

/**
 * The top N live spikes for `topics`. Ranked by score, then recency.
 * USED / KILLED / PARKED are out — they are not things to write next.
 */
export function topSpikes(spikes: readonly SpikeRecord[], n: number): SpikeRecord[] {
  return spikes
    .filter((s) => s.status === 'NEW' || s.status === 'SHORTLISTED' || s.status === 'INTERVIEWED')
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, n);
}
