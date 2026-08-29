/**
 * Markdown <-> contract serialisation.
 *
 * Contracts 2, 3 and 4 live on disk as markdown files with YAML frontmatter.
 * The exact on-disk shape is specified in CLAUDE_CODE_BRIEF.md, so these
 * functions are the single place that shape is encoded. Everything here
 * round-trips: parse(serialise(x)) deep-equals x (see test/markdown.test.ts).
 */

import YAML from 'yaml';
import {
  CRITIC_CHECKS,
  CRITIC_CHECK_HEADINGS,
  CRITIC_VERDICTS,
  SCHEMA_VERSION,
  type CriticCheck,
  type CriticCheckName,
  type CriticReport,
  type CriticVerdict,
  type DraftArtefact,
  type InterviewQA,
  type InterviewTranscript,
  type ProvenanceEntry,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^\uFEFF/, ''); // strip BOM; Drive exports sometimes add one
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const parsed = YAML.parse(match[1] ?? '') as unknown;
  const data = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  return { data, body: text.slice(match[0].length).trim() };
}

export function serialiseFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return value === undefined || value === null ? '' : String(value);
}

function num(data: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(data[key]);
  return Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Contract 2 — Interview Transcript
// ---------------------------------------------------------------------------

/**
 * Parse a `Q:` / `A:` transcript. Answers may span multiple lines (Wispr
 * dictation wraps freely), so a line is only treated as a new Q/A when it
 * starts with the marker. `line` is 1-based within the body and is what the
 * writer cites as "Interview line N".
 */
export function parseInterviewQA(body: string): InterviewQA[] {
  const lines = body.split(/\r?\n/);
  const pairs: InterviewQA[] = [];
  let current: { question: string[]; answer: string[]; line: number } | null = null;
  let mode: 'q' | 'a' | null = null;

  const flush = () => {
    if (!current) return;
    const question = current.question.join('\n').trim();
    const answer = current.answer.join('\n').trim();
    // A question with no answer carries no evidence; drop it.
    if (question && answer) pairs.push({ question, answer, line: current.line });
    current = null;
  };

  lines.forEach((line, index) => {
    const q = /^\s*Q:\s?(.*)$/.exec(line);
    const a = /^\s*A:\s?(.*)$/.exec(line);
    if (q) {
      flush();
      current = { question: [q[1] ?? ''], answer: [], line: index + 1 };
      mode = 'q';
      return;
    }
    if (a) {
      if (!current) current = { question: [''], answer: [], line: index + 1 };
      current.answer.push(a[1] ?? '');
      current.line = index + 1; // cite the answer line, that's where evidence is
      mode = 'a';
      return;
    }
    if (!current || mode === null) return;
    (mode === 'q' ? current.question : current.answer).push(line);
  });
  flush();
  return pairs;
}

export function parseInterviewTranscript(raw: string, sourcePath?: string): InterviewTranscript {
  const { data, body } = parseFrontmatter(raw);
  return {
    spike_id: str(data, 'spike_id'),
    tenant: str(data, 'tenant'),
    brand: str(data, 'brand'),
    author: str(data, 'author'),
    date: str(data, 'date'),
    schema_version: num(data, 'schema_version', SCHEMA_VERSION),
    qa: parseInterviewQA(body),
    body,
    ...(sourcePath ? { source_path: sourcePath } : {}),
  };
}

export function serialiseInterviewTranscript(interview: InterviewTranscript): string {
  const body =
    interview.body.trim() ||
    interview.qa.map((pair) => `Q: ${pair.question}\nA: ${pair.answer}`).join('\n\n');
  return serialiseFrontmatter(
    {
      spike_id: interview.spike_id,
      tenant: interview.tenant,
      brand: interview.brand,
      author: interview.author,
      date: interview.date,
      schema_version: interview.schema_version,
    },
    body,
  );
}

// ---------------------------------------------------------------------------
// Contract 3 — Draft Artefact
// ---------------------------------------------------------------------------

const WORKING_NOTES_HEADING = '## Working Notes';

export function serialiseDraftArtefact(draft: DraftArtefact): string {
  const provenance = draft.provenance.length
    ? draft.provenance.map((p) => `- "${p.claim}" → ${p.passage_ref}`).join('\n')
    : '- (none recorded)';

  const body = [
    `# ${draft.title}`,
    '',
    draft.body.trim(),
    '',
    '---',
    WORKING_NOTES_HEADING,
    'claim→provenance map (Passage Ref format):',
    provenance,
    '',
    `chosen CTA: ${draft.chosen_cta || '(none)'}`,
  ].join('\n');

  return serialiseFrontmatter(
    {
      anchor_id: draft.anchor_id,
      spike_id: draft.spike_id,
      brand: draft.brand,
      author: draft.author,
      channel: draft.channel,
      version: draft.version,
      schema_version: draft.schema_version,
    },
    body,
  );
}

export function parseDraftArtefact(raw: string, sourcePath?: string): DraftArtefact {
  const { data, body } = parseFrontmatter(raw);

  // Split the article from the Working Notes block. Only split on the LAST
  // occurrence — an article may legitimately contain a `---` rule.
  const notesIndex = body.lastIndexOf(WORKING_NOTES_HEADING);
  const articlePart = notesIndex === -1 ? body : body.slice(0, notesIndex).replace(/---\s*$/, '');
  const notesPart = notesIndex === -1 ? '' : body.slice(notesIndex);

  const titleMatch = /^#\s+(.+)$/m.exec(articlePart);
  const title = titleMatch?.[1]?.trim() ?? '';
  const articleBody = titleMatch
    ? articlePart.slice((titleMatch.index ?? 0) + titleMatch[0].length).trim()
    : articlePart.trim();

  return {
    anchor_id: str(data, 'anchor_id'),
    spike_id: str(data, 'spike_id'),
    brand: str(data, 'brand'),
    author: str(data, 'author'),
    channel: str(data, 'channel'),
    version: num(data, 'version', 1),
    schema_version: num(data, 'schema_version', SCHEMA_VERSION),
    title,
    body: articleBody,
    provenance: parseProvenance(notesPart),
    chosen_cta: parseChosenCta(notesPart),
    ...(sourcePath ? { source_path: sourcePath } : {}),
  };
}

/** Accepts both the `→` arrow and a plain `->` in case a human edits the file. */
function parseProvenance(notes: string): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [];
  for (const line of notes.split(/\r?\n/)) {
    const match = /^\s*-\s*"([\s\S]*?)"\s*(?:→|->)\s*(.+?)\s*$/.exec(line);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      entries.push({ claim: match[1], passage_ref: match[2] });
    }
  }
  return entries;
}

function parseChosenCta(notes: string): string {
  const match = /^\s*chosen CTA:\s*(.+?)\s*$/im.exec(notes);
  const value = match?.[1]?.trim() ?? '';
  return value === '(none)' ? '' : value;
}

// ---------------------------------------------------------------------------
// Contract 4 — Critic Report
// ---------------------------------------------------------------------------

export function serialiseCriticReport(report: CriticReport): string {
  const sections = report.checks.map((c) => {
    const flags = c.flags.length
      ? c.flags.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : 'none';
    return [
      `## ${CRITIC_CHECK_HEADINGS[c.name]}`,
      `Score: ${c.score}`,
      `Passed: ${c.passed}`,
      `Flags: ${flags}`,
    ].join('\n');
  });

  const outstanding = report.outstanding_criticisms.length
    ? report.outstanding_criticisms.map((c) => `- ${c}`).join('\n')
    : 'none';

  const body = [
    sections.join('\n\n'),
    '',
    '---',
    '## Verdict',
    report.verdict,
    `Outstanding criticisms:${report.outstanding_criticisms.length ? `\n${outstanding}` : ' none'}`,
  ].join('\n');

  return serialiseFrontmatter(
    {
      anchor_id: report.anchor_id,
      version: report.version,
      schema_version: report.schema_version,
    },
    body,
  );
}

const HEADING_TO_CHECK: Record<string, CriticCheckName> = Object.fromEntries(
  CRITIC_CHECKS.map((name) => [CRITIC_CHECK_HEADINGS[name].toLowerCase(), name]),
) as Record<string, CriticCheckName>;

export function parseCriticReport(raw: string, sourcePath?: string): CriticReport {
  const { data, body } = parseFrontmatter(raw);
  const checks: CriticCheck[] = [];

  // Each `## Heading` starts a section; slice between headings.
  const headingRe = /^##\s+(.+)$/gm;
  const marks: { heading: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    if (marks.length) marks[marks.length - 1]!.end = m.index;
    marks.push({ heading: (m[1] ?? '').trim(), start: m.index + m[0].length, end: body.length });
  }

  let verdict: CriticVerdict = 'REVISE';
  let outstanding: string[] = [];

  for (const mark of marks) {
    const section = body.slice(mark.start, mark.end);
    const checkName = HEADING_TO_CHECK[mark.heading.toLowerCase()];
    if (checkName) {
      checks.push({
        name: checkName,
        score: Number(/^\s*Score:\s*(.+)$/im.exec(section)?.[1]?.trim() ?? '0') || 0,
        passed: /^\s*Passed:\s*(.+)$/im.exec(section)?.[1]?.trim() ?? '',
        flags: parseFlags(section),
      });
      continue;
    }
    if (mark.heading.toLowerCase() === 'verdict') {
      const found = CRITIC_VERDICTS.find((v) =>
        new RegExp(`(^|\\s)${escapeRegex(v)}(\\s|$)`, 'm').test(section),
      );
      // FAIL-AUTOMATIC contains "FAIL"; the find above matches whole tokens so
      // ordering of CRITIC_VERDICTS does not matter here.
      if (found) verdict = found;
      outstanding = parseOutstanding(section);
    }
  }

  return {
    anchor_id: str(data, 'anchor_id'),
    version: num(data, 'version', 1),
    schema_version: num(data, 'schema_version', SCHEMA_VERSION),
    checks,
    verdict,
    outstanding_criticisms: outstanding,
    ...(sourcePath ? { source_path: sourcePath } : {}),
  };
}

function parseFlags(section: string): string[] {
  const match = /^\s*Flags:\s*([\s\S]*?)$/im.exec(section);
  if (!match) return [];
  const raw = (match[1] ?? '').trim();
  if (!raw || /^none$/i.test(raw)) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+\.|-)\s*/, '').trim())
    .filter(Boolean);
}

function parseOutstanding(section: string): string[] {
  const match = /^\s*Outstanding criticisms:\s*([\s\S]*)$/im.exec(section);
  if (!match) return [];
  const raw = (match[1] ?? '').trim();
  if (!raw || /^none$/i.test(raw) || /^\[/.test(raw)) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+\.|-)\s*/, '').trim())
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
