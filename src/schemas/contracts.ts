/**
 * The Six Contracts — immutable interfaces.
 *
 * These are the only shapes that cross the boundary between the app layer
 * (src/) and the data layer (Google Drive + Sheet). Every read produces one of
 * these; every write consumes one. Changing a field here is a breaking change
 * to the data layer, so bump `schema_version` if you ever do.
 *
 * Each contract ships with a `validateX()` that returns a structured result
 * rather than throwing, so callers can decide whether a bad row is fatal
 * (a draft we are about to publish) or skippable (one malformed sheet row).
 */

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Validation plumbing
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function ok(): ValidationResult {
  return { ok: true, errors: [] };
}

export function fail(errors: string[]): ValidationResult {
  return { ok: false, errors };
}

/** Throw on invalid. Use at trust boundaries where continuing is unsafe. */
export function assertValid(result: ValidationResult, label: string): void {
  if (!result.ok) {
    throw new Error(`${label} failed contract validation:\n  - ${result.errors.join('\n  - ')}`);
  }
}

class Check {
  readonly errors: string[] = [];
  constructor(private readonly subject: Record<string, unknown>) {}

  /** Field must be a non-empty string after trimming. */
  requiredString(field: string): this {
    const value = this.subject[field];
    if (typeof value !== 'string' || value.trim() === '') {
      this.errors.push(`${field}: required non-empty string (got ${describe(value)})`);
    }
    return this;
  }

  /** Field must be a string, but "" is meaningful (e.g. an unused Notes cell). */
  optionalString(field: string): this {
    const value = this.subject[field];
    if (typeof value !== 'string') {
      this.errors.push(`${field}: must be a string, use "" when empty (got ${describe(value)})`);
    }
    return this;
  }

  enum<T extends string>(field: string, allowed: readonly T[]): this {
    const value = this.subject[field];
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.errors.push(`${field}: must be one of ${allowed.join(' | ')} (got ${describe(value)})`);
    }
    return this;
  }

  numberInRange(field: string, min: number, max: number): this {
    const value = this.subject[field];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      this.errors.push(`${field}: must be a number (got ${describe(value)})`);
    } else if (value < min || value > max) {
      this.errors.push(`${field}: must be between ${min} and ${max} (got ${value})`);
    }
    return this;
  }

  /** ISO calendar date, YYYY-MM-DD. */
  isoDate(field: string): this {
    const value = this.subject[field];
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      this.errors.push(`${field}: must be an ISO date YYYY-MM-DD (got ${describe(value)})`);
    }
    return this;
  }

  matches(field: string, pattern: RegExp, hint: string): this {
    const value = this.subject[field];
    if (typeof value !== 'string' || !pattern.test(value)) {
      this.errors.push(`${field}: ${hint} (got ${describe(value)})`);
    }
    return this;
  }

  positiveInt(field: string): this {
    const value = this.subject[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      this.errors.push(`${field}: must be an integer >= 1 (got ${describe(value)})`);
    }
    return this;
  }

  result(): ValidationResult {
    return this.errors.length === 0 ? ok() : fail(this.errors);
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function check(subject: unknown): Check {
  if (typeof subject !== 'object' || subject === null) {
    const c = new Check({});
    c.errors.push(`expected an object, got ${describe(subject)}`);
    return c;
  }
  return new Check(subject as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Shared ID formats
// ---------------------------------------------------------------------------

/** SPIKE-20260815-001 */
export const SPIKE_ID_PATTERN = /^SPIKE-\d{8}-\d{3,}$/;
/** ABD-ARTICLE-20260815-001 — brand prefix is tenant-defined, so kept loose. */
export const ANCHOR_ID_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+-\d{8}-\d{3,}$/;

// ---------------------------------------------------------------------------
// Contract 1 — Spike Record (VAULT sheet row)
// ---------------------------------------------------------------------------

export const SPIKE_STATUSES = [
  'NEW',
  'SHORTLISTED',
  'INTERVIEWED',
  'DRAFTED',
  'USED',
  'PARKED',
  'KILLED',
] as const;
export type SpikeStatus = (typeof SPIKE_STATUSES)[number];

export interface SpikeRecord {
  spike_id: string;
  date: string;
  brand: string;
  author: string;
  source: string;
  source_ref: string;
  topic: string;
  angle: string;
  story_evidence: string;
  persona: string;
  pillar: string;
  timeliness: string;
  score: number;
  status: SpikeStatus;
  used_in: string;
  notes: string;
}

/**
 * Header row of the VAULT tab, in order. The sheet adapters map columns by
 * this array, so the on-disk order and the interface can never drift.
 */
export const VAULT_COLUMNS = [
  'Spike-ID',
  'Date',
  'Brand',
  'Author',
  'Source',
  'Source Ref',
  'Topic',
  'Angle',
  'Story/Evidence',
  'Persona',
  'Pillar',
  'Timeliness',
  'Score',
  'Status',
  'Used-In',
  'Notes',
] as const;

/** Column header -> object key. Order matches VAULT_COLUMNS. */
export const VAULT_FIELDS: readonly (keyof SpikeRecord)[] = [
  'spike_id',
  'date',
  'brand',
  'author',
  'source',
  'source_ref',
  'topic',
  'angle',
  'story_evidence',
  'persona',
  'pillar',
  'timeliness',
  'score',
  'status',
  'used_in',
  'notes',
];

export function validateSpikeRecord(value: unknown): ValidationResult {
  return check(value)
    .matches('spike_id', SPIKE_ID_PATTERN, 'must look like SPIKE-YYYYMMDD-NNN')
    .isoDate('date')
    .requiredString('brand')
    .requiredString('author')
    .requiredString('source')
    .optionalString('source_ref')
    .requiredString('topic')
    .requiredString('angle')
    .optionalString('story_evidence')
    .optionalString('persona')
    .optionalString('pillar')
    .optionalString('timeliness')
    .numberInRange('score', 0, 10)
    .enum('status', SPIKE_STATUSES)
    .optionalString('used_in')
    .optionalString('notes')
    .result();
}

// ---------------------------------------------------------------------------
// Contract 2 — Interview Transcript
// File: interviews/{spike-id}-{author}-{date}.md
// ---------------------------------------------------------------------------

export interface InterviewQA {
  question: string;
  answer: string;
  /** 1-based line number of the answer within the transcript body. Used to
   *  build the claim→provenance map ("Interview line 15"). */
  line: number;
}

export interface InterviewTranscript {
  spike_id: string;
  tenant: string;
  brand: string;
  author: string;
  date: string;
  schema_version: number;
  /** Parsed Q/A pairs. */
  qa: InterviewQA[];
  /** Raw markdown body below the frontmatter, verbatim. */
  body: string;
  /** Where this came from, for logs and error messages. */
  source_path?: string;
}

export function validateInterviewTranscript(value: unknown): ValidationResult {
  const base = check(value)
    .matches('spike_id', SPIKE_ID_PATTERN, 'must look like SPIKE-YYYYMMDD-NNN')
    .requiredString('tenant')
    .requiredString('brand')
    .requiredString('author')
    .isoDate('date')
    .positiveInt('schema_version')
    .requiredString('body')
    .result();

  const errors = [...base.errors];
  const qa = (value as { qa?: unknown } | null)?.qa;
  if (!Array.isArray(qa)) {
    errors.push('qa: must be an array of {question, answer, line}');
  } else if (qa.length === 0) {
    errors.push('qa: transcript contains no Q:/A: pairs — nothing to write from');
  } else {
    qa.forEach((pair, i) => {
      const r = check(pair).requiredString('question').requiredString('answer').positiveInt('line').result();
      r.errors.forEach((e) => errors.push(`qa[${i}].${e}`));
    });
  }
  return errors.length === 0 ? ok() : fail(errors);
}

// ---------------------------------------------------------------------------
// Contract 3 — Draft Artefact
// File: drafts/{anchor-id}-v{n}.md
// ---------------------------------------------------------------------------

/** One row of the claim→provenance map in the Working Notes block. */
export interface ProvenanceEntry {
  claim: string;
  /** Passage Ref format, e.g. "Interview line 15". */
  passage_ref: string;
}

export interface DraftArtefact {
  anchor_id: string;
  spike_id: string;
  brand: string;
  author: string;
  channel: string;
  version: number;
  schema_version: number;
  title: string;
  body: string;
  provenance: ProvenanceEntry[];
  chosen_cta: string;
  source_path?: string;
}

export function validateDraftArtefact(value: unknown): ValidationResult {
  const base = check(value)
    .matches('anchor_id', ANCHOR_ID_PATTERN, 'must look like BRAND-CHANNEL-YYYYMMDD-NNN')
    .matches('spike_id', SPIKE_ID_PATTERN, 'must look like SPIKE-YYYYMMDD-NNN')
    .requiredString('brand')
    .requiredString('author')
    .requiredString('channel')
    .positiveInt('version')
    .positiveInt('schema_version')
    .requiredString('title')
    .requiredString('body')
    .optionalString('chosen_cta')
    .result();

  const errors = [...base.errors];
  const provenance = (value as { provenance?: unknown } | null)?.provenance;
  if (!Array.isArray(provenance)) {
    errors.push('provenance: must be an array of {claim, passage_ref}');
  } else {
    provenance.forEach((entry, i) => {
      const r = check(entry).requiredString('claim').requiredString('passage_ref').result();
      r.errors.forEach((e) => errors.push(`provenance[${i}].${e}`));
    });
  }
  return errors.length === 0 ? ok() : fail(errors);
}

// ---------------------------------------------------------------------------
// Contract 4 — Critic Report
// File: critic-reports/{anchor-id}-v{n}.md
// ---------------------------------------------------------------------------

export const CRITIC_CHECKS = ['boundary', 'voice', 'traceability', 'claims_scope'] as const;
export type CriticCheckName = (typeof CRITIC_CHECKS)[number];

/** Display headings, in report order. */
export const CRITIC_CHECK_HEADINGS: Record<CriticCheckName, string> = {
  boundary: 'Boundary Check',
  voice: 'Voice Check',
  traceability: 'Traceability Check',
  claims_scope: 'Claims Scope Check',
};

export interface CriticCheck {
  name: CriticCheckName;
  score: number;
  passed: string;
  /** Empty array renders as "none". */
  flags: string[];
}

export const CRITIC_VERDICTS = ['PASS', 'REVISE', 'FAIL-AUTOMATIC'] as const;
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number];

export interface CriticReport {
  anchor_id: string;
  version: number;
  schema_version: number;
  checks: CriticCheck[];
  verdict: CriticVerdict;
  outstanding_criticisms: string[];
  source_path?: string;
}

export function validateCriticReport(value: unknown): ValidationResult {
  const base = check(value)
    .matches('anchor_id', ANCHOR_ID_PATTERN, 'must look like BRAND-CHANNEL-YYYYMMDD-NNN')
    .positiveInt('version')
    .positiveInt('schema_version')
    .enum('verdict', CRITIC_VERDICTS)
    .result();

  const errors = [...base.errors];
  const checks = (value as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) {
    errors.push('checks: must be an array of four CriticCheck entries');
  } else {
    // All four checks must be present exactly once — a report missing the
    // boundary check must never read as a pass.
    const seen = new Set<string>();
    checks.forEach((entry, i) => {
      const r = check(entry)
        .enum('name', CRITIC_CHECKS)
        .numberInRange('score', 0, 10)
        .requiredString('passed')
        .result();
      r.errors.forEach((e) => errors.push(`checks[${i}].${e}`));
      const name = (entry as { name?: unknown })?.name;
      if (typeof name === 'string') {
        if (seen.has(name)) errors.push(`checks: duplicate check "${name}"`);
        seen.add(name);
      }
      if (!Array.isArray((entry as { flags?: unknown })?.flags)) {
        errors.push(`checks[${i}].flags: must be an array of strings (use [] for none)`);
      }
    });
    for (const required of CRITIC_CHECKS) {
      if (!seen.has(required)) errors.push(`checks: missing required check "${required}"`);
    }
  }

  if (!Array.isArray((value as { outstanding_criticisms?: unknown } | null)?.outstanding_criticisms)) {
    errors.push('outstanding_criticisms: must be an array of strings (use [] for none)');
  }
  return errors.length === 0 ? ok() : fail(errors);
}

/** Mean of the four check scores, rounded to one decimal. */
export function overallCriticScore(report: CriticReport): number {
  if (report.checks.length === 0) return 0;
  const total = report.checks.reduce((sum, c) => sum + c.score, 0);
  return Math.round((total / report.checks.length) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Contract 5 — EDITIONS sheet row (newsletter send)
// ---------------------------------------------------------------------------

export const EDITION_STATUSES = ['DRAFT', 'APPROVED', 'SENT', 'LEARNING'] as const;
export type EditionStatus = (typeof EDITION_STATUSES)[number];

export interface EditionRecord {
  edition: string;
  date_published: string;
  brand: string;
  author: string;
  topic: string;
  issue_number: string;
  status: EditionStatus;
  newsletter_link: string;
  metrics_30d: string;
  notes: string;
}

export const EDITIONS_COLUMNS = [
  'Edition',
  'Date-Published',
  'Brand',
  'Author',
  'Topic',
  'Issue-Number',
  'Status',
  'Newsletter-Link',
  'Metrics-30d',
  'Notes',
] as const;

export const EDITIONS_FIELDS: readonly (keyof EditionRecord)[] = [
  'edition',
  'date_published',
  'brand',
  'author',
  'topic',
  'issue_number',
  'status',
  'newsletter_link',
  'metrics_30d',
  'notes',
];

export function validateEditionRecord(value: unknown): ValidationResult {
  return check(value)
    .requiredString('edition')
    .optionalString('date_published') // empty until it actually ships
    .requiredString('brand')
    .requiredString('author')
    .requiredString('topic')
    .optionalString('issue_number')
    .enum('status', EDITION_STATUSES)
    .optionalString('newsletter_link')
    .optionalString('metrics_30d')
    .optionalString('notes')
    .result();
}

// ---------------------------------------------------------------------------
// Contract 6 — REPURPOSING sheet row (derived assets)
// ---------------------------------------------------------------------------

export const ASSET_TYPES = [
  'linkedin-post',
  'x-thread',
  'tweet',
  'podcast-clip',
  'shorts-script',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_STATUSES = ['PROPOSED', 'APPROVED', 'PUBLISHED'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export interface DerivedAsset {
  anchor_id: string;
  asset_type: AssetType;
  text: string;
  status: AssetStatus;
  passage_ref: string;
  published_link: string;
  metrics_30d: string;
  notes: string;
}

export const REPURPOSING_COLUMNS = [
  'Anchor-ID',
  'Asset-Type',
  'Text',
  'Status',
  'Passage-Ref',
  'Published-Link',
  'Metrics-30d',
  'Notes',
] as const;

export const REPURPOSING_FIELDS: readonly (keyof DerivedAsset)[] = [
  'anchor_id',
  'asset_type',
  'text',
  'status',
  'passage_ref',
  'published_link',
  'metrics_30d',
  'notes',
];

export function validateDerivedAsset(value: unknown): ValidationResult {
  return check(value)
    .matches('anchor_id', ANCHOR_ID_PATTERN, 'must look like BRAND-CHANNEL-YYYYMMDD-NNN')
    .enum('asset_type', ASSET_TYPES)
    .requiredString('text')
    .enum('status', ASSET_STATUSES)
    .requiredString('passage_ref') // every derived asset must trace to the anchor
    .optionalString('published_link')
    .optionalString('metrics_30d')
    .optionalString('notes')
    .result();
}
