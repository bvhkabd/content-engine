/**
 * The data-layer file interface.
 *
 * All paths are POSIX-style and relative to the tenants root, e.g.
 * `harish/interviews/SPIKE-20260815-001-harish-2026-08-15.md`. Neither the
 * engine nor the skills know whether that resolves to a folder on this Mac or
 * a folder in Google Drive.
 */

export interface Storage {
  /** Human-readable description of where this storage points, for logs. */
  readonly label: string;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** File names (not full paths) directly inside `dir`. Missing dir => []. */
  list(dir: string): Promise<string[]>;
  ensureDir(dir: string): Promise<void>;
}

/** Thrown when a required file is absent, so callers can exit with a clear message. */
export class FileNotFoundError extends Error {
  constructor(
    readonly path: string,
    location: string,
    hint?: string,
  ) {
    super(`File not found: ${path}\n  Looked in: ${location}${hint ? `\n  ${hint}` : ''}`);
    this.name = 'FileNotFoundError';
  }
}

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function baseName(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

// ---------------------------------------------------------------------------
// Tenant folder layout — the canonical paths, in one place.
// ---------------------------------------------------------------------------

export const TenantPaths = {
  root: (tenant: string) => tenant,
  config: (tenant: string) => joinPath(tenant, 'tenant.yaml'),
  reference: (tenant: string, file: string) => joinPath(tenant, file),
  interviews: (tenant: string) => joinPath(tenant, 'interviews'),
  interview: (tenant: string, filename: string) => joinPath(tenant, 'interviews', filename),
  drafts: (tenant: string) => joinPath(tenant, 'drafts'),
  draft: (tenant: string, anchorId: string, version: number) =>
    joinPath(tenant, 'drafts', `${anchorId}-v${version}.md`),
  criticReports: (tenant: string) => joinPath(tenant, 'critic-reports'),
  criticReport: (tenant: string, anchorId: string, version: number) =>
    joinPath(tenant, 'critic-reports', `${anchorId}-v${version}.md`),
  transcriptsIn: (tenant: string) => joinPath(tenant, 'transcripts-in'),
  logs: (tenant: string) => joinPath(tenant, 'logs'),
  log: (tenant: string, name: string) => joinPath(tenant, 'logs', name),
  sheets: (tenant: string) => joinPath(tenant, 'sheets'),
  sheet: (tenant: string, tab: string) => joinPath(tenant, 'sheets', `${tab}.csv`),
} as const;

/** Folders every tenant has. `init` creates these; other commands assume them. */
export const TENANT_SUBFOLDERS = [
  'interviews',
  'drafts',
  'critic-reports',
  'transcripts-in',
  'dossiers',
  'logs',
  'sheets',
] as const;
