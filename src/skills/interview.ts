/**
 * `content-engine interview` — adaptive interview.
 *
 * Asks one question, waits, then generates the next from what you actually
 * said. Writes a Contract 2 transcript that `session` reads unchanged.
 *
 * The transcript is saved after every answer, so Ctrl-C, a dropped connection
 * or a dead API key never costs more than the question in flight.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createContext, type RunContext } from '../config/context.js';
import { createLlmClient, type LlmClient } from '../engine/llm.js';
import { interviewFileName, isoDate } from '../engine/ids.js';
import { loadBrandContext, type BrandContext } from '../config/tenant.js';
import { TenantPaths } from '../io/storage.js';
import { SCHEMA_VERSION, type SpikeRecord } from '../schemas/contracts.js';
import { parseInterviewQA, serialiseFrontmatter } from '../schemas/markdown.js';
import { interviewSystemPrompt, nextQuestionPrompt, type InterviewExchange } from '../prompts/interview.js';
import { choose, failure, heading, info, isInteractive, step, style, success, warn } from '../ui/console.js';
import { loadSpike } from './shared.js';

export interface InterviewOptions {
  tenant: string;
  spikeId: string;
  author?: string;
  brand?: string;
  channel?: string;
  /** Question ceiling. The interviewer may also stop early. */
  questions?: number;
}

export interface InterviewResult {
  exchanges: InterviewExchange[];
  path: string;
  completed: boolean;
}

const DEFAULT_QUESTIONS = 12;
const MAX_CONSECUTIVE_SKIPS = 3;

export async function runInterview(options: InterviewOptions): Promise<InterviewResult> {
  const ctx = await createContext(options.tenant, { job: 'interview' });
  const now = new Date();

  try {
    if (!isInteractive()) {
      throw new Error(
        'interview needs a terminal — it is a conversation, not a batch job.\n' +
          'Run it directly in your shell, or use `session --guide` for a static question list you can fill in offline.',
      );
    }

    const spike = await loadSpike(ctx, options.spikeId);
    const brandKey = options.brand ?? spike.brand ?? ctx.config.active_brands[0]!;
    const authorKey = options.author ?? spike.author ?? ctx.config.default_author;
    const channelKey = options.channel ?? ctx.config.default_channel;
    const brandContext = await loadBrandContext(ctx.config, ctx.storage, brandKey, authorKey, channelKey);

    const maxQuestions = Math.max(1, options.questions ?? DEFAULT_QUESTIONS);
    const filename = interviewFileName(spike.spike_id, authorKey, now);
    const path = TenantPaths.interview(ctx.tenant, filename);

    heading(`Interview — ${spike.spike_id}`);
    info(`${style.dim('Topic: ')}${spike.topic}`);
    info(`${style.dim('Angle: ')}${spike.angle}`);
    info(`${style.dim('Saving to: ')}${path}`);

    // Resume rather than clobber. A second interview on the same day is far
    // more likely to be a continuation than a fresh start.
    const exchanges = await resumeOrStart(ctx, path, maxQuestions);
    if (exchanges === null) {
      info('Cancelled. Nothing changed.');
      return { exchanges: [], path, completed: false };
    }

    const llm = createLlmClient(ctx.env, 'run an adaptive interview');
    info(`${style.dim('Model: ')}${llm.model}`);
    printHelp(maxQuestions);

    const rl = createInterface({ input: stdin, output: stdout });
    let completed = false;
    try {
      completed = await conversation(ctx, rl, llm, spike, brandContext, exchanges, maxQuestions, {
        authorKey,
        brandKey,
        filename,
        now,
      });
    } finally {
      rl.close();
    }

    // Always save, even on an early exit — partial material still has value.
    await save(ctx, filename, exchanges, spike, brandKey, authorKey, now);

    if (exchanges.length === 0) {
      warn('No answers recorded. Transcript not useful yet.');
      return { exchanges, path, completed: false };
    }

    if (spike.status === 'NEW' || spike.status === 'SHORTLISTED') {
      await ctx.sheet.updateVaultRow(spike.spike_id, { status: 'INTERVIEWED' });
      ctx.log.info(`spike ${spike.spike_id} -> INTERVIEWED`);
    }

    heading('Done');
    success(`${exchanges.length} Q/A pairs → ${path}`);
    info(`Spike ${spike.spike_id} → INTERVIEWED`);
    info('');
    info('Write it up:');
    info(`  npm run cli -- session --tenant ${ctx.tenant} --spike ${spike.spike_id}`);

    ctx.log.info(`interview complete: ${exchanges.length} exchanges, completed=${completed}`);
    return { exchanges, path, completed };
  } finally {
    await ctx.log.flush();
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

interface SaveMeta {
  authorKey: string;
  brandKey: string;
  filename: string;
  now: Date;
}

/** Returns true if the interview reached a natural end. */
async function conversation(
  ctx: RunContext,
  rl: Interface,
  llm: LlmClient,
  spike: SpikeRecord,
  brandContext: BrandContext,
  exchanges: InterviewExchange[],
  maxQuestions: number,
  meta: SaveMeta,
): Promise<boolean> {
  const system = interviewSystemPrompt(brandContext);
  let skips = 0;

  while (exchanges.length < maxQuestions) {
    const remaining = maxQuestions - exchanges.length;

    let next: NextQuestion;
    try {
      next = await askModel(llm, spike, brandContext, exchanges, remaining, system);
    } catch (error) {
      // The transcript so far is already on disk; let the operator decide.
      failure(`Could not generate the next question: ${(error as Error).message}`);
      ctx.log.error(`question generation failed: ${(error as Error).message}`);
      const retry = await prompt(rl, `${style.dim('retry / done')} >`);
      if (retry.toLowerCase().startsWith('r')) continue;
      return false;
    }

    if (next.done) {
      success(`Interviewer stopped early: ${next.reason || 'enough material gathered'}`);
      return true;
    }

    const number = exchanges.length + 1;
    console.log('');
    info(`${style.bold(`Q${number}.`)} ${next.question}`);
    if (next.probing) info(style.dim(`   ↳ ${next.probing}`));

    const answer = await readAnswer(rl);

    if (answer.command === 'quit') {
      warn('Stopping here. Everything answered so far is saved.');
      return false;
    }
    if (answer.command === 'done') {
      success('Wrapping up.');
      return true;
    }
    if (answer.command === 'skip') {
      if (++skips >= MAX_CONSECUTIVE_SKIPS) {
        warn(`${MAX_CONSECUTIVE_SKIPS} skips in a row — stopping.`);
        return false;
      }
      info(style.dim('   (skipped)'));
      // Record the skip so the interviewer does not re-ask the same thing.
      exchanges.push({ question: next.question, answer: '[skipped]' });
      continue;
    }

    skips = 0;
    exchanges.push({ question: next.question, answer: answer.text });

    // Save after every answer.
    await save(ctx, meta.filename, exchanges, spike, meta.brandKey, meta.authorKey, meta.now);
    info(style.dim(`   ✓ saved (${countAnswered(exchanges)} answered)`));
  }

  success(`Reached the ${maxQuestions}-question limit.`);
  return true;
}

interface NextQuestion {
  done: boolean;
  reason: string;
  question: string;
  probing: string;
}

async function askModel(
  llm: LlmClient,
  spike: SpikeRecord,
  brandContext: BrandContext,
  exchanges: readonly InterviewExchange[],
  remaining: number,
  system: string,
): Promise<NextQuestion> {
  const payload = await llm.json<Partial<NextQuestion>>(
    nextQuestionPrompt(spike, brandContext, exchanges, remaining),
    system,
    { temperature: 0.7 },
  );

  const question = String(payload.question ?? '').trim();
  const done = payload.done === true;
  if (!done && !question) {
    throw new Error('the model returned neither a question nor a done signal');
  }
  return {
    done,
    reason: String(payload.reason ?? '').trim(),
    question,
    probing: String(payload.probing ?? '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

type Answer =
  | { command: 'answer'; text: string }
  | { command: 'done' | 'skip' | 'quit'; text: '' };

/**
 * One line per answer, which keeps behaviour predictable with dictation.
 * `+` opens multi-line capture for anything longer, terminated by a lone `.`.
 */
async function readAnswer(rl: Interface): Promise<Answer> {
  for (;;) {
    const line = (await prompt(rl, `${style.cyan('A')} >`)).trim();
    const command = parseCommand(line);
    if (command) return command;

    if (line === '+') {
      const lines: string[] = [];
      info(style.dim('   multi-line: finish with a single "." on its own line'));
      for (;;) {
        const more = await prompt(rl, style.dim('   |'));
        if (more.trim() === '.') break;
        lines.push(more);
      }
      const text = lines.join('\n').trim();
      if (text) return { command: 'answer', text };
      warn('Empty answer — try again, or type "skip".');
      continue;
    }

    if (line === '') {
      warn('Empty answer. Type something, or "skip" to move on, or "done" to finish.');
      continue;
    }
    return { command: 'answer', text: line };
  }
}

/** Exported for tests. */
export function parseCommand(line: string): Answer | null {
  const normalised = line.trim().toLowerCase();
  if (normalised === 'done') return { command: 'done', text: '' };
  if (normalised === 'skip') return { command: 'skip', text: '' };
  if (normalised === 'quit' || normalised === 'exit') return { command: 'quit', text: '' };
  return null;
}

async function prompt(rl: Interface, label: string): Promise<string> {
  return rl.question(`${label} `);
}

function printHelp(maxQuestions: number): void {
  info('');
  info(style.dim(`Up to ${maxQuestions} questions. Each answer shapes the next one.`));
  info(style.dim('  done  finish and save    skip  pass on this question'));
  info(style.dim('  quit  stop and save      +     multi-line answer (end with ".")'));
  info(style.dim('"I don\'t have that number" is a good answer — better than inventing one.'));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Returns existing exchanges to continue from, [] for a fresh start, or null to cancel. */
async function resumeOrStart(
  ctx: RunContext,
  path: string,
  maxQuestions: number,
): Promise<InterviewExchange[] | null> {
  if (!(await ctx.storage.exists(path))) return [];

  const existing = parseInterviewQA(await ctx.storage.readFile(path));
  const answered = existing.filter((e) => e.answer !== '[skipped]');

  console.log('');
  if (answered.length === 0) {
    // Almost certainly a `session --guide` stub: questions, no answers.
    warn('A transcript already exists here with no answers in it (likely a generated guide).');
    const choice = await choose('Overwrite it with an adaptive interview?', ['yes', 'no'] as const, 'yes');
    return choice === 'yes' ? [] : null;
  }

  warn(`A transcript already exists with ${answered.length} answered question(s).`);
  const choice = await choose('Resume it, start over, or cancel?', ['resume', 'overwrite', 'cancel'] as const, 'resume');
  if (choice === 'cancel') return null;
  if (choice === 'overwrite') return [];

  if (existing.length >= maxQuestions) {
    warn(`Already at the ${maxQuestions}-question limit. Use --questions to raise it.`);
  }
  step(`Resuming from ${existing.length} question(s).`);
  return existing.map((e) => ({ question: e.question, answer: e.answer }));
}

async function save(
  ctx: RunContext,
  filename: string,
  exchanges: readonly InterviewExchange[],
  spike: SpikeRecord,
  brandKey: string,
  authorKey: string,
  now: Date,
): Promise<void> {
  const content = buildTranscript(exchanges, {
    spike_id: spike.spike_id,
    tenant: ctx.tenant,
    brand: brandKey,
    author: authorKey,
    date: isoDate(now),
  });
  await ctx.storage.writeFile(TenantPaths.interview(ctx.tenant, filename), content);
}

export interface TranscriptMeta {
  spike_id: string;
  tenant: string;
  brand: string;
  author: string;
  date: string;
}

/**
 * Contract 2 markdown. Pure — exported for tests.
 * Blank line between pairs so `parseInterviewQA` reads them back cleanly.
 */
export function buildTranscript(
  exchanges: readonly InterviewExchange[],
  meta: TranscriptMeta,
): string {
  const body = exchanges
    .map((e) => `Q: ${e.question}\nA: ${e.answer}`)
    .join('\n\n');
  return serialiseFrontmatter({ ...meta, schema_version: SCHEMA_VERSION }, body);
}

function countAnswered(exchanges: readonly InterviewExchange[]): number {
  return exchanges.filter((e) => e.answer !== '[skipped]').length;
}
