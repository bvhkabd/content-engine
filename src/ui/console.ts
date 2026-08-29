/**
 * Terminal input and output for the interactive skills.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  CRITIC_CHECK_HEADINGS,
  overallCriticScore,
  type CriticReport,
  type DerivedAsset,
  type SpikeRecord,
} from '../schemas/contracts.js';

const useColour = stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) => (useColour ? `[${code}m${text}[0m` : text);

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

export function heading(text: string): void {
  console.log(`\n${style.bold(text)}`);
  console.log(style.dim('─'.repeat(Math.min(text.length, 72))));
}

export function info(text: string): void {
  console.log(text);
}

export function step(text: string): void {
  console.log(`${style.cyan('›')} ${text}`);
}

export function success(text: string): void {
  console.log(`${style.green('✔')} ${text}`);
}

export function warn(text: string): void {
  console.log(`${style.yellow('!')} ${text}`);
}

export function failure(text: string): void {
  console.log(`${style.red('✖')} ${text}`);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** True when there is no human to answer a prompt (cron, CI, piped input). */
export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export async function ask(question: string, fallback = ''): Promise<string> {
  if (!isInteractive()) return fallback;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} `);
    return answer.trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const suffix = fallback ? '(Y/n)' : '(y/N)';
  const answer = (await ask(`${question} ${suffix}`, fallback ? 'y' : 'n')).toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

/** Ask until the answer matches one of `choices`. */
export async function choose<T extends string>(
  question: string,
  choices: readonly T[],
  fallback: T,
): Promise<T> {
  if (!isInteractive()) return fallback;
  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = (await ask(`${question} [${choices.join('/')}]`, fallback)).toLowerCase();
    if (answer === '') return fallback;
    const match = choices.find((c) => c.toLowerCase() === answer || c.toLowerCase().startsWith(answer));
    if (match) return match;
    warn(`Please answer one of: ${choices.join(', ')}`);
  }
  return fallback;
}

/** Read a multi-line block, terminated by a line containing only ".". */
export async function askMultiline(question: string): Promise<string> {
  if (!isInteractive()) return '';
  console.log(`${question} ${style.dim('(end with a single "." on its own line)')}`);
  const rl = createInterface({ input: stdin, output: stdout });
  const lines: string[] = [];
  try {
    for await (const line of rl) {
      if (line.trim() === '.') break;
      lines.push(line);
    }
  } finally {
    rl.close();
  }
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function scoreColour(score: number, passScore: number): string {
  const text = score.toFixed(1);
  if (score >= passScore) return style.green(text);
  if (score >= passScore - 2) return style.yellow(text);
  return style.red(text);
}

export function renderCriticReport(report: CriticReport, passScore: number): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${style.bold(CRITIC_CHECK_HEADINGS[check.name])}  ${scoreColour(check.score, passScore)}/10`);
    lines.push(`  ${style.dim(check.passed)}`);
    if (check.flags.length === 0) {
      lines.push(`  ${style.green('no flags')}`);
    } else {
      check.flags.forEach((flag, i) => lines.push(`  ${style.yellow(`${i + 1}.`)} ${flag}`));
    }
    lines.push('');
  }

  const verdictColour =
    report.verdict === 'PASS' ? style.green : report.verdict === 'REVISE' ? style.yellow : style.red;
  lines.push(
    `${style.bold('Verdict:')} ${verdictColour(report.verdict)}   ${style.dim(
      `overall ${overallCriticScore(report).toFixed(1)}/10`,
    )}`,
  );
  return lines.join('\n');
}

/** The `topics` output format from CLAUDE_CODE_BRIEF.md § src/skills/topics.ts */
export function renderTopSpikes(spikes: readonly SpikeRecord[], topN: number): string {
  if (spikes.length === 0) {
    return style.dim('No live spikes in the vault. Run `oracle` to find some.');
  }
  const lines = [style.bold(`🔥 Top ${Math.min(topN, spikes.length)} This Week`), ''];
  spikes.forEach((spike, i) => {
    lines.push(`${style.bold(`${i + 1}. ${spike.topic}`)} — ${spike.brand}  ${style.dim(`(${spike.score.toFixed(1)})`)}`);
    lines.push(`   Angle: ${spike.angle}`);
    lines.push(`   Why now: ${spike.timeliness || '—'}`);
    lines.push(`   Persona: ${spike.persona || '—'}`);
    lines.push(`   ${style.dim(`${spike.spike_id} · ${spike.status}`)}`);
    lines.push('');
  });
  return lines.join('\n');
}

export function renderAssetSummary(assets: readonly DerivedAsset[]): string {
  const counts = new Map<string, number>();
  for (const asset of assets) counts.set(asset.asset_type, (counts.get(asset.asset_type) ?? 0) + 1);
  return [...counts.entries()].map(([type, count]) => `${count}× ${type}`).join(', ');
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
