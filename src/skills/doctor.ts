/**
 * `content-engine doctor` — pre-flight check.
 *
 * Verifies credentials, config and data-layer wiring without spending a token
 * on the LLM. This is the first thing to run when something is misconfigured.
 */

import { createSheetStore, createStorage } from '../config/context.js';
import { loadEnv } from '../config/env.js';
import { loadTenantConfig, missingReferenceFiles, bundleSize } from '../config/tenant.js';
import { TENANT_SUBFOLDERS, TenantPaths, joinPath } from '../io/storage.js';
import { TABS, TAB_HEADERS, describeHeaderProblem, type TabName } from '../io/sheets.js';
import { parseCsv } from '../io/csv.js';
import { notificationsEnabled } from '../io/notify.js';
import { heading, info, style } from '../ui/console.js';

export interface DoctorOptions {
  tenant: string;
}

type Status = 'ok' | 'warn' | 'fail';

interface CheckResult {
  status: Status;
  label: string;
  detail: string;
}

const MARK: Record<Status, string> = {
  ok: style.green('✔'),
  warn: style.yellow('!'),
  fail: style.red('✖'),
};

/** Returns false if any check hard-failed. */
export async function runDoctor(options: DoctorOptions): Promise<boolean> {
  const results: CheckResult[] = [];
  const add = (status: Status, label: string, detail: string) => results.push({ status, label, detail });

  heading(`Doctor — tenant "${options.tenant}"`);

  // --- env -----------------------------------------------------------------
  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
    add('ok', 'environment', `backend=${env.storageBackend}, model=${env.openrouterModel}`);
  } catch (error) {
    add('fail', 'environment', (error as Error).message);
    return report(results);
  }

  add(
    env.openrouterApiKey ? 'ok' : 'fail',
    'OPENROUTER_API_KEY',
    env.openrouterApiKey ? `set (${mask(env.openrouterApiKey)})` : 'missing — session, approve and oracle will fail',
  );

  if (env.storageBackend === 'google') {
    add(
      env.googleCredentialsJson ? 'ok' : 'fail',
      'GOOGLE_CREDENTIALS_JSON',
      env.googleCredentialsJson ?? 'missing — required when STORAGE_BACKEND=google',
    );
  } else {
    add('ok', 'storage backend', `local — tenants at ${env.tenantsDir} (no Google credentials needed)`);
  }

  add(
    env.gmailAppPassword ? 'ok' : 'warn',
    'GMAIL_APP_PASSWORD',
    env.gmailAppPassword ? 'set' : 'missing — the oracle will skip the #Postideas inbox source',
  );
  add(
    notificationsEnabled(env) ? 'ok' : 'warn',
    'SMTP notifications',
    notificationsEnabled(env) ? `via ${env.notify.host}` : 'not configured — alerts print to the console instead',
  );

  // --- storage + config ----------------------------------------------------
  let storage: ReturnType<typeof createStorage>;
  try {
    storage = createStorage(env);
    add('ok', 'storage', storage.label);
  } catch (error) {
    add('fail', 'storage', (error as Error).message);
    return report(results);
  }

  let config: Awaited<ReturnType<typeof loadTenantConfig>>;
  try {
    config = await loadTenantConfig(options.tenant, storage);
    add(
      'ok',
      'tenant.yaml',
      `brands=${config.active_brands.join('/')}, authors=${Object.keys(config.authors).join('/')}, ` +
        `channels=${Object.keys(config.channels).join('/')}, bundle=${bundleSize(config)} assets`,
    );
  } catch (error) {
    add('fail', 'tenant.yaml', (error as Error).message);
    return report(results);
  }

  // --- folders -------------------------------------------------------------
  const missingFolders: string[] = [];
  for (const folder of TENANT_SUBFOLDERS) {
    const path = joinPath(options.tenant, folder);
    const entries = await storage.list(path);
    if (entries.length === 0 && !(await storage.exists(path))) missingFolders.push(folder);
  }
  add(
    missingFolders.length === 0 ? 'ok' : 'warn',
    'folders',
    missingFolders.length === 0 ? TENANT_SUBFOLDERS.join(', ') : `missing: ${missingFolders.join(', ')} — re-run init`,
  );

  // --- reference material --------------------------------------------------
  const missingRefs = await missingReferenceFiles(config, storage);
  add(
    missingRefs.length === 0 ? 'ok' : 'warn',
    'reference files',
    missingRefs.length === 0
      ? 'all present'
      : `missing: ${missingRefs.join(', ')} — drafts will run with thinner guidance`,
  );

  // --- sheet files ---------------------------------------------------------
  // Checked before reading through the sheet store, so a broken header is
  // reported as a finding rather than surfacing as an exception below.
  if (env.storageBackend === 'local') {
    const sheetsDir = TenantPaths.sheets(options.tenant);
    if (!(await storage.exists(sheetsDir)) && (await storage.list(sheetsDir)).length === 0) {
      add('fail', 'sheets folder', `missing: ${sheetsDir} — run init to create it`);
    } else {
      add('ok', 'sheets folder', sheetsDir);
    }

    for (const tab of Object.values(TABS) as TabName[]) {
      const path = TenantPaths.sheet(options.tenant, tab);
      if (!(await storage.exists(path))) {
        add('fail', `${tab}.csv`, `missing — run init to recreate it`);
        continue;
      }
      const rows = parseCsv(await storage.readFile(path));
      const problem = describeHeaderProblem(tab, rows[0]);
      if (problem) {
        add('fail', `${tab}.csv`, `${problem}. Expected: ${TAB_HEADERS[tab].join(',')}`);
      } else {
        const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).length;
        add('ok', `${tab}.csv`, `header correct, ${dataRows} data row(s)`);
      }
    }
  }

  // --- sheet ---------------------------------------------------------------
  try {
    const sheet = createSheetStore(env, config, storage);
    const vault = await sheet.readVault();
    const editions = await sheet.readEditions();
    const assets = await sheet.readRepurposing();
    add(
      'ok',
      'sheet',
      `${sheet.label} — VAULT ${vault.length} rows, EDITIONS ${editions.length}, REPURPOSING ${assets.length}`,
    );

    const live = vault.filter((s) => ['NEW', 'SHORTLISTED', 'INTERVIEWED'].includes(s.status));
    add(
      live.length > 0 ? 'ok' : 'warn',
      'live spikes',
      live.length > 0 ? `${live.length} ready to work on` : 'none — run `oracle` or add rows to VAULT by hand',
    );
  } catch (error) {
    add('fail', 'sheet', (error as Error).message);
  }

  // --- work in progress ----------------------------------------------------
  const interviews = await storage.list(TenantPaths.interviews(options.tenant));
  const drafts = await storage.list(TenantPaths.drafts(options.tenant));
  add('ok', 'artefacts', `${interviews.length} interviews, ${drafts.length} draft files`);

  return report(results);
}

function report(results: CheckResult[]): boolean {
  console.log('');
  const width = Math.max(...results.map((r) => r.label.length));
  for (const result of results) {
    console.log(`${MARK[result.status]} ${result.label.padEnd(width)}  ${style.dim(result.detail)}`);
  }

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');
  console.log('');
  if (failed.length === 0 && warned.length === 0) {
    info(style.green('Everything checks out.'));
  } else if (failed.length === 0) {
    info(style.yellow(`${warned.length} warning${warned.length === 1 ? '' : 's'} — usable, but not complete.`));
  } else {
    info(style.red(`${failed.length} failure${failed.length === 1 ? '' : 's'} — fix these before running a session.`));
  }
  console.log('');
  return failed.length === 0;
}

function mask(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
