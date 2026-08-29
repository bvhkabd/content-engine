/**
 * Google Drive backend.
 *
 * Drive has no real paths — only parent/child links — so this adapter walks
 * the folder chain and caches the resolved IDs for the life of the process.
 * Google Docs are exported as plain text on read; files we create are plain
 * text/markdown so they round-trip byte for byte.
 */

import { Readable } from 'node:stream';
import { driveClient, explainGoogleError, type ServiceAccountCredentials } from './google-auth.js';
import { FileNotFoundError, baseName, dirName, type Storage } from './storage.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';

type Drive = ReturnType<typeof driveClient>;

export class GoogleDriveStorage implements Storage {
  readonly label: string;
  private readonly drive: Drive;
  private readonly rootFolderId: string;
  /** path -> folder id. '' maps to the root. */
  private readonly folderIds = new Map<string, string>();

  constructor(credentials: string | ServiceAccountCredentials, rootFolderId: string) {
    this.drive = driveClient(credentials);
    this.rootFolderId = rootFolderId;
    this.label = `drive:${rootFolderId}`;
    this.folderIds.set('', rootFolderId);
  }

  // -- folder resolution ----------------------------------------------------

  private async findChild(parentId: string, name: string, folderOnly: boolean): Promise<string | null> {
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const clauses = [`'${parentId}' in parents`, `name = '${escaped}'`, 'trashed = false'];
    if (folderOnly) clauses.push(`mimeType = '${FOLDER_MIME}'`);
    try {
      const res = await this.drive.files.list({
        q: clauses.join(' and '),
        fields: 'files(id, name, mimeType)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return res.data.files?.[0]?.id ?? null;
    } catch (error) {
      throw explainGoogleError(error, `Listing "${name}" in Drive folder ${parentId}`);
    }
  }

  private async resolveFolder(path: string, create: boolean): Promise<string | null> {
    const clean = path.replace(/^\/+|\/+$/g, '');
    const cached = this.folderIds.get(clean);
    if (cached) return cached;
    if (clean === '') return this.rootFolderId;

    const parentPath = dirName(clean);
    const parentId = await this.resolveFolder(parentPath, create);
    if (!parentId) return null;

    const name = baseName(clean);
    let id = await this.findChild(parentId, name, true);
    if (!id && create) {
      try {
        const res = await this.drive.files.create({
          requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
          fields: 'id',
          supportsAllDrives: true,
        });
        id = res.data.id ?? null;
      } catch (error) {
        throw explainGoogleError(error, `Creating Drive folder "${clean}"`);
      }
    }
    if (id) this.folderIds.set(clean, id);
    return id;
  }

  private async resolveFile(path: string): Promise<{ id: string; mimeType: string } | null> {
    const parentId = await this.resolveFolder(dirName(path), false);
    if (!parentId) return null;
    const name = baseName(path);
    const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    try {
      const res = await this.drive.files.list({
        q: `'${parentId}' in parents and name = '${escaped}' and trashed = false`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const file = res.data.files?.[0];
      return file?.id ? { id: file.id, mimeType: file.mimeType ?? 'text/plain' } : null;
    } catch (error) {
      throw explainGoogleError(error, `Looking up "${path}" in Drive`);
    }
  }

  // -- Storage --------------------------------------------------------------

  async readFile(path: string): Promise<string> {
    const file = await this.resolveFile(path);
    if (!file) throw new FileNotFoundError(path, this.label);
    try {
      if (file.mimeType === GOOGLE_DOC_MIME) {
        // A Doc has no raw bytes; export it. Interview transcripts pasted into
        // Docs are common, so this path matters.
        const res = await this.drive.files.export(
          { fileId: file.id, mimeType: 'text/plain' },
          { responseType: 'text' },
        );
        return String(res.data);
      }
      const res = await this.drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'text' },
      );
      return String(res.data);
    } catch (error) {
      throw explainGoogleError(error, `Reading "${path}" from Drive`);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const parentId = await this.resolveFolder(dirName(path), true);
    if (!parentId) throw new Error(`Could not create Drive folder for "${path}"`);
    const existing = await this.resolveFile(path);
    const media = { mimeType: 'text/markdown', body: Readable.from([content]) };
    try {
      if (existing) {
        await this.drive.files.update({ fileId: existing.id, media, supportsAllDrives: true });
      } else {
        await this.drive.files.create({
          requestBody: { name: baseName(path), parents: [parentId] },
          media,
          fields: 'id',
          supportsAllDrives: true,
        });
      }
    } catch (error) {
      throw explainGoogleError(error, `Writing "${path}" to Drive`);
    }
  }

  async appendFile(path: string, content: string): Promise<void> {
    // Drive has no append; read-modify-write. Only used for logs, which are
    // written once per run by a single process.
    let existing = '';
    if (await this.exists(path)) existing = await this.readFile(path);
    await this.writeFile(path, existing + content);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.resolveFile(path)) !== null;
  }

  async list(dir: string): Promise<string[]> {
    const folderId = await this.resolveFolder(dir, false);
    if (!folderId) return [];
    const names: string[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const res = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
          fields: 'nextPageToken, files(name)',
          pageSize: 1000,
          ...(pageToken ? { pageToken } : {}),
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        for (const f of res.data.files ?? []) if (f.name) names.push(f.name);
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      throw explainGoogleError(error, `Listing Drive folder "${dir}"`);
    }
    return names.sort();
  }

  async ensureDir(dir: string): Promise<void> {
    await this.resolveFolder(dir, true);
  }
}

// ---------------------------------------------------------------------------
// Spec-level convenience wrappers (CLAUDE_CODE_BRIEF.md § Google Drive)
// ---------------------------------------------------------------------------

/** Read one tenant file, e.g. readTenantFile("harish/tenant.yaml", creds, rootId). */
export async function readTenantFile(
  path: string,
  credentials: string | ServiceAccountCredentials,
  rootFolderId: string,
): Promise<string> {
  return new GoogleDriveStorage(credentials, rootFolderId).readFile(path);
}

export async function writeTenantFile(
  path: string,
  content: string,
  credentials: string | ServiceAccountCredentials,
  rootFolderId: string,
): Promise<void> {
  return new GoogleDriveStorage(credentials, rootFolderId).writeFile(path, content);
}
