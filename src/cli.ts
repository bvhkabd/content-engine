#!/usr/bin/env -S npx tsx
/**
 * Content Engine CLI.
 *
 * Every command takes --tenant. Nothing about any tenant is baked in here.
 */

import { Command, InvalidArgumentError } from 'commander';
import { runInit } from './skills/init.js';
import { showTopics } from './skills/topics.js';
import { runSession } from './skills/session.js';
import { runInterview } from './skills/interview.js';
import { runApprove } from './skills/approve.js';
import { dailyOracle } from './jobs/oracle.js';
import { watchdog } from './jobs/watchdog.js';
import { runDoctor } from './skills/doctor.js';
import { runSources } from './skills/sources.js';
import { failure, style } from './ui/console.js';

const program = new Command();

program
  .name('content-engine')
  .description('Multi-tenant content orchestration: interview → write → critic → bundle.')
  .version('1.0.0')
  .showHelpAfterError();

function commaList(value: string): string[] {
  const items = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (items.length === 0) throw new InvalidArgumentError('expected a comma-separated list');
  return items;
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Scaffold a tenant in the data layer and prepare its sheet tabs')
  .requiredOption('--tenant <name>', 'tenant key, e.g. harish')
  .option('--sheet-id <id>', 'Google Sheet ID (the part of the URL between /d/ and /edit)')
  .option('--brands <list>', 'comma-separated brand keys, e.g. ABD,CTQ', commaList)
  .option('--author <key>', 'primary author key (defaults to the tenant name)')
  .option('--author-name <name>', 'author display name')
  .option('--drive-folder <id>', 'Google Drive folder ID (STORAGE_BACKEND=google only)')
  .option('--inbox <email>', 'Gmail address the oracle reads #Postideas from')
  .action(async (options) => {
    await runInit({
      tenant: options.tenant,
      sheetId: options.sheetId,
      brands: options.brands,
      author: options.author,
      authorName: options.authorName,
      driveFolderId: options.driveFolder,
      inboxEmail: options.inbox,
    });
  });

program
  .command('topics')
  .description('Show the current top spikes from the VAULT')
  .requiredOption('--tenant <name>', 'tenant key')
  .option('--limit <n>', 'how many to show (default: oracle.top_n from tenant.yaml)', positiveInt)
  .option('--brand <key>', 'only show spikes for this brand')
  .option('--json', 'print raw JSON instead of the formatted list')
  .action(async (options) => {
    await showTopics({
      tenant: options.tenant,
      limit: options.limit,
      brand: options.brand,
      json: Boolean(options.json),
    });
  });

program
  .command('interview')
  .description('Adaptive interview: each question is generated from your last answer')
  .requiredOption('--tenant <name>', 'tenant key')
  .requiredOption('--spike <id>', 'spike ID, e.g. SPIKE-20260815-001')
  .option('--author <key>', 'override the author from the spike row')
  .option('--brand <key>', 'override the brand from the spike row')
  .option('--channel <key>', 'channel this will be written for')
  .option('--questions <n>', 'question ceiling (default 12)', positiveInt)
  .action(async (options) => {
    await runInterview({
      tenant: options.tenant,
      spikeId: options.spike,
      author: options.author,
      brand: options.brand,
      channel: options.channel,
      questions: options.questions,
    });
  });

program
  .command('session')
  .description('Run one session: interview → write → critic → approve → bundle')
  .requiredOption('--tenant <name>', 'tenant key')
  .requiredOption('--spike <id>', 'spike ID, e.g. SPIKE-20260815-001')
  .option('--author <key>', 'override the author from the spike row')
  .option('--brand <key>', 'override the brand from the spike row')
  .option('--channel <key>', 'channel to write for (default: default_channel)')
  .option('--guide', 'generate an interview guide for this spike and stop')
  .option('--no-bundle', 'approve without generating derived assets')
  .option('-y, --yes', 'run unattended: accept a PASS, auto-revise otherwise')
  .action(async (options) => {
    await runSession({
      tenant: options.tenant,
      spikeId: options.spike,
      author: options.author,
      brand: options.brand,
      channel: options.channel,
      guide: Boolean(options.guide),
      // commander maps --no-bundle to options.bundle === false
      noBundle: options.bundle === false,
      yes: Boolean(options.yes),
    });
  });

program
  .command('approve')
  .description('Approve an existing draft and generate its derived-asset bundle')
  .requiredOption('--tenant <name>', 'tenant key')
  .requiredOption('--draft <anchor-id>', 'anchor ID, e.g. ABD-ARTICLE-20260815-001')
  .option('--version <n>', 'draft version (default: the highest on disk)', positiveInt)
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (options) => {
    await runApprove({
      tenant: options.tenant,
      anchorId: options.draft,
      version: options.version,
      yes: Boolean(options.yes),
    });
  });

program
  .command('oracle')
  .description('Scan sources and append new spikes to the VAULT (headless, daily)')
  .requiredOption('--tenant <name>', 'tenant key')
  .option('--dry-run', 'extract and score, but write nothing')
  .option('--since-days <n>', 'lookback window for email and Fireflies (default 7)', positiveInt)
  .action(async (options) => {
    await dailyOracle({
      tenant: options.tenant,
      dryRun: Boolean(options.dryRun),
      sinceDays: options.sinceDays,
    });
  });

program
  .command('sources')
  .description('Probe each oracle source independently and report what came back')
  .requiredOption('--tenant <name>', 'tenant key')
  .option('--since-days <n>', 'lookback window (default 7)', positiveInt)
  .option('--only <name>', 'probe one source: inbox | transcripts | dossiers')
  .action(async (options) => {
    const ok = await runSources({
      tenant: options.tenant,
      sinceDays: options.sinceDays,
      only: options.only,
    });
    if (!ok) process.exitCode = 1;
  });

program
  .command('watchdog')
  .description('Check job heartbeats and stalled work (headless, daily)')
  .requiredOption('--tenant <name>', 'tenant key')
  .option('--email <address>', 'override the alert recipient')
  .option('--jobs <list>', 'jobs that must have a heartbeat today (default: oracle)', commaList)
  .action(async (options) => {
    const result = await watchdog({
      tenant: options.tenant,
      email: options.email,
      jobs: options.jobs,
    });
    // Non-zero exit so cron and CI can see the failure.
    if (!result.healthy) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Check credentials, config and data-layer wiring without calling the LLM')
  .requiredOption('--tenant <name>', 'tenant key')
  .action(async (options) => {
    const ok = await runDoctor({ tenant: options.tenant });
    if (!ok) process.exitCode = 1;
  });

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('');
    failure(message);
    if (process.env.DEBUG && error instanceof Error && error.stack) {
      console.error(style.dim(error.stack));
    } else {
      console.error(style.dim('Re-run with DEBUG=1 for a stack trace.'));
    }
    process.exitCode = 1;
  }
}

void main();
