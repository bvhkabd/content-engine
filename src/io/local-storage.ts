/**
 * Local filesystem backend — a mirror of the Drive tree on this Mac.
 *
 * This exists so the whole loop can be exercised (and prompts iterated on)
 * without Google credentials. The path layout is identical to the Drive
 * backend, so a folder synced by Google Drive for Desktop also works here.
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { FileNotFoundError, dirName, type Storage } from './storage.js';

export class LocalStorage implements Storage {
  readonly label: string;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
    this.label = `local:${this.root}`;
  }

  /** Resolve a data-layer path, refusing anything that escapes the root. */
  private resolve(path: string): string {
    const full = resolve(this.root, path);
    if (full !== this.root && !full.startsWith(this.root + '/')) {
      throw new Error(`Refusing to access "${path}": resolves outside the tenants root`);
    }
    return full;
  }

  async readFile(path: string): Promise<string> {
    const full = this.resolve(path);
    try {
      return await readFile(full, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(path, this.label);
      }
      throw error;
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  async appendFile(path: string, content: string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(join(full, '..'), { recursive: true });
    await appendFile(full, content, 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }

  async list(dir: string): Promise<string[]> {
    const full = this.resolve(dir);
    if (!existsSync(full)) return [];
    const entries = await readdir(full, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  }

  async ensureDir(dir: string): Promise<void> {
    await mkdir(this.resolve(dir), { recursive: true });
  }
}

export { dirName };
