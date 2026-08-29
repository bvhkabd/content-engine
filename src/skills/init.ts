/**
 * `content-engine init` — scaffold a tenant in the data layer.
 *
 * Idempotent: existing files are never overwritten, so re-running after adding
 * a brand fills in only what is missing.
 */

import { createSheetStore, createStorage } from '../config/context.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../io/logger.js';
import { TENANT_SUBFOLDERS, TenantPaths, joinPath } from '../io/storage.js';
import { loadTenantConfig, missingReferenceFiles } from '../config/tenant.js';
import { scaffoldFiles, type ScaffoldOptions } from '../templates/tenant-templates.js';
import { heading, info, step, style, success, warn } from '../ui/console.js';

export interface InitOptions {
  tenant: string;
  sheetId?: string;
  brands?: string[];
  author?: string;
  authorName?: string;
  driveFolderId?: string;
  inboxEmail?: string;
}

export interface InitResult {
  created: string[];
  skipped: string[];
  tenantRoot: string;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const env = loadEnv();
  const storage = createStorage(env, options.driveFolderId);
  const tenant = options.tenant;

  const scaffold: ScaffoldOptions = {
    tenant,
    brands: options.brands?.length ? options.brands : [tenant.toUpperCase()],
    author: options.author ?? tenant,
    authorName: options.authorName ?? capitalise(options.author ?? tenant),
    sheetId: options.sheetId ?? '',
    driveFolderId: options.driveFolderId ?? '',
    inboxEmail: options.inboxEmail ?? '',
  };

  heading(`Initialising tenant "${tenant}"`);
  info(`${style.dim('backend:')} ${env.storageBackend}   ${style.dim('storage:')} ${storage.label}`);

  // Folders first, so a partially-created tenant still gets its tree.
  await storage.ensureDir(TenantPaths.root(tenant));
  for (const folder of TENANT_SUBFOLDERS) {
    await storage.ensureDir(joinPath(tenant, folder));
  }
  step(`folders: ${TENANT_SUBFOLDERS.join(', ')}`);

  const created: string[] = [];
  const skipped: string[] = [];
  for (const [name, contents] of Object.entries(scaffoldFiles(scaffold))) {
    const path = joinPath(tenant, name);
    if (await storage.exists(path)) {
      skipped.push(name);
      continue;
    }
    await storage.writeFile(path, contents);
    created.push(name);
  }

  if (created.length) step(`created ${created.length} files: ${created.join(', ')}`);
  if (skipped.length) step(style.dim(`kept ${skipped.length} existing files: ${skipped.join(', ')}`));

  // Now that tenant.yaml exists, set up the sheet tabs.
  const config = await loadTenantConfig(tenant, storage);
  const log = createLogger(storage, tenant, 'init');
  try {
    const sheet = createSheetStore(env, config, storage);
    await sheet.ensureTabs();
    success(`sheet ready: ${sheet.label} (VAULT, EDITIONS, REPURPOSING)`);
    log.info(`init complete: ${created.length} created, ${skipped.length} kept, sheet=${sheet.label}`);
  } catch (error) {
    // A missing sheet ID should not undo the folder scaffolding.
    warn(`Sheet not initialised: ${(error as Error).message}`);
    log.warn(`sheet init skipped: ${(error as Error).message}`);
  }
  await log.flush();

  const missing = await missingReferenceFiles(config, storage);
  if (missing.length) {
    warn(`Reference files still missing: ${missing.join(', ')}`);
  }

  heading('Next');
  info(`1. Fill in the templates in ${style.bold(joinPath(env.tenantsDir, tenant))} — start with voice, redlines, ctas.`);
  info(`2. ${style.bold(`npm run cli -- oracle --tenant ${tenant}`)} to populate the vault, or add spikes to the sheet by hand.`);
  info(`3. ${style.bold(`npm run cli -- topics --tenant ${tenant}`)} to see what to write next.`);

  return { created, skipped, tenantRoot: joinPath(env.tenantsDir, tenant) };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
