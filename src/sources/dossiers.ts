/**
 * Dossier source — client and prospect documents.
 *
 * Scans the tenant's dossiers/ folder for keyword mentions. Keywords come from
 * `sources.dossiers.keywords` in tenant.yaml; with none configured, whole
 * documents are returned and the oracle decides what is interesting.
 */

import { joinPath, type Storage } from '../io/storage.js';
import type { SourceDocument } from './types.js';

export interface DossierMentions {
  docName: string;
  mentions: string[];
}

/** Lines mentioning any keyword, with a line of context either side. */
export async function fetchDossierMentions(
  storage: Storage,
  tenant: string,
  folder: string,
  keywords: readonly string[],
): Promise<DossierMentions[]> {
  const dir = joinPath(tenant, folder);
  const files = await storage.list(dir);
  const results: DossierMentions[] = [];

  for (const filename of files) {
    if (!/\.(md|txt|json|csv)$/i.test(filename)) continue;
    const content = await storage.readFile(joinPath(dir, filename));
    const mentions = keywords.length === 0 ? [content.trim()] : extractMentions(content, keywords);
    if (mentions.length > 0) results.push({ docName: filename, mentions });
  }
  return results;
}

export function extractMentions(content: string, keywords: readonly string[]): string[] {
  const lines = content.split(/\r?\n/);
  const needles = keywords.map((k) => k.toLowerCase()).filter(Boolean);
  const hits: string[] = [];
  const seen = new Set<number>();

  lines.forEach((line, index) => {
    const haystack = line.toLowerCase();
    if (!needles.some((needle) => haystack.includes(needle))) return;
    // One line of context either side, without repeating overlapping windows.
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length - 1, index + 1);
    if (seen.has(start)) return;
    for (let i = start; i <= end; i++) seen.add(i);
    hits.push(lines.slice(start, end + 1).join('\n').trim());
  });

  return hits.filter(Boolean);
}

export function toSourceDocuments(dossiers: readonly DossierMentions[]): SourceDocument[] {
  return dossiers.map((d) => ({
    kind: 'dossier',
    reference: d.docName,
    title: d.docName.replace(/\.[^.]+$/, ''),
    content: d.mentions.join('\n\n---\n\n'),
  }));
}
