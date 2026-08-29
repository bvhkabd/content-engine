/**
 * Runtime wiring: env + tenant name -> storage, sheet, logger, config.
 *
 * Every CLI command starts here, so backend selection happens in exactly one
 * place and nothing downstream knows which backend it got.
 */

import { GoogleDriveStorage } from '../io/google-drive.js';
import { GoogleSheetStore } from '../io/google-sheets.js';
import { LocalSheetStore } from '../io/local-sheets.js';
import { LocalStorage } from '../io/local-storage.js';
import { createLogger, type Logger } from '../io/logger.js';
import type { SheetStore } from '../io/sheets.js';
import type { Storage } from '../io/storage.js';
import { loadEnv, requireEnv, type Env } from './env.js';
import { loadTenantConfig, type TenantConfig } from './tenant.js';

export interface RunContext {
  env: Env;
  tenant: string;
  config: TenantConfig;
  storage: Storage;
  sheet: SheetStore;
  log: Logger;
}

/**
 * Storage only — used by `init`, which must run before tenant.yaml exists.
 * For the google backend the Drive root comes from env, since we cannot read
 * the tenant's own config until we can read files.
 */
export function createStorage(env: Env, driveRootFolderId?: string): Storage {
  if (env.storageBackend === 'local') {
    return new LocalStorage(env.tenantsDir);
  }
  const credentials = requireEnv(env, 'googleCredentialsJson', 'use the Google Drive backend');
  const root = driveRootFolderId || env.googleDriveRootFolderId;
  if (!root) {
    throw new Error(
      'STORAGE_BACKEND=google requires a Drive folder. Set GOOGLE_DRIVE_ROOT_FOLDER_ID in .env ' +
        '(or drive.root_folder_id in tenant.yaml).',
    );
  }
  return new GoogleDriveStorage(credentials, root);
}

export function createSheetStore(env: Env, config: TenantConfig, storage: Storage): SheetStore {
  if (env.storageBackend === 'local') {
    return new LocalSheetStore(storage, config.tenant);
  }
  if (!config.sheet.id) {
    throw new Error(
      `tenant.yaml for "${config.tenant}" has no sheet.id. Add the Google Sheet ID ` +
        '(the long string in the sheet URL between /d/ and /edit).',
    );
  }
  const credentials = requireEnv(env, 'googleCredentialsJson', 'read the Google Sheet');
  return new GoogleSheetStore(config.sheet.id, credentials);
}

export interface ContextOptions {
  /** Log file prefix, e.g. "session" or "oracle". */
  job: string;
  /** Print INFO lines to the terminal. Headless jobs do; interactive skills don't. */
  echo?: boolean;
}

export async function createContext(tenant: string, options: ContextOptions): Promise<RunContext> {
  const env = loadEnv();

  // Two-step for the Drive backend: read the config with the env-level root,
  // then honour a tenant-level override if the config specifies one.
  let storage = createStorage(env);
  let config = await loadTenantConfig(tenant, storage);
  if (
    env.storageBackend === 'google' &&
    config.drive.root_folder_id &&
    config.drive.root_folder_id !== env.googleDriveRootFolderId
  ) {
    storage = createStorage(env, config.drive.root_folder_id);
    config = await loadTenantConfig(tenant, storage);
  }

  const sheet = createSheetStore(env, config, storage);
  const log = createLogger(storage, tenant, options.job, { ...(options.echo ? { echo: true } : {}) });
  log.info(`tenant=${tenant} backend=${env.storageBackend} storage=${storage.label} sheet=${sheet.label}`);

  return { env, tenant, config, storage, sheet, log };
}
