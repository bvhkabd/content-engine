/**
 * Transcript source — meeting and dictation transcripts.
 *
 * Two modes, selected by `sources.transcripts.type` in tenant.yaml:
 *   manual_export — read files dropped into tenants/{tenant}/transcripts-in/
 *   fireflies     — pull recent transcripts from the Fireflies GraphQL API
 */

import { TenantPaths, type Storage } from '../io/storage.js';
import type { SourceDocument } from './types.js';

/** Read every file in the tenant's transcripts-in/ folder. */
export async function fetchTranscriptsFolder(
  storage: Storage,
  tenant: string,
): Promise<{ filename: string; content: string }[]> {
  const dir = TenantPaths.transcriptsIn(tenant);
  const files = await storage.list(dir);
  const results: { filename: string; content: string }[] = [];
  for (const filename of files) {
    if (!/\.(md|txt|vtt|srt|json)$/i.test(filename)) continue;
    const content = (await storage.readFile(`${dir}/${filename}`)).trim();
    if (content) results.push({ filename, content });
  }
  return results;
}

const FIREFLIES_ENDPOINT = 'https://api.fireflies.ai/graphql';

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number | string;
  sentences?: { speaker_name?: string; text?: string }[] | null;
}

/** Recent Fireflies transcripts. Fail fast — no retries, per the spec. */
export async function fetchFirefliesTranscripts(
  apiKey: string,
  sinceDays = 7,
  limit = 10,
): Promise<{ filename: string; content: string }[]> {
  if (!apiKey) return [];

  const query = `
    query RecentTranscripts($limit: Int) {
      transcripts(limit: $limit) {
        id
        title
        date
        sentences { speaker_name text }
      }
    }`;

  let response: Response;
  try {
    response = await fetch(FIREFLIES_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, variables: { limit } }),
    });
  } catch (error) {
    throw new Error(`Fireflies request failed (network): ${(error as Error).message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Fireflies returned ${response.status}: ${text.slice(0, 400)}`);
  }

  let payload: { data?: { transcripts?: FirefliesTranscript[] }; errors?: { message?: string }[] };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Fireflies returned non-JSON: ${text.slice(0, 400)}`);
  }
  if (payload.errors?.length) {
    throw new Error(`Fireflies API error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }

  const cutoff = Date.now() - sinceDays * 86_400_000;
  return (payload.data?.transcripts ?? [])
    .filter((t) => {
      const time = typeof t.date === 'number' ? t.date : Date.parse(String(t.date));
      return Number.isFinite(time) ? time >= cutoff : true;
    })
    .map((t) => ({
      filename: `fireflies-${t.id}.md`,
      content: [
        `# ${t.title}`,
        '',
        (t.sentences ?? [])
          .map((s) => `${s.speaker_name ?? 'Speaker'}: ${s.text ?? ''}`)
          .join('\n'),
      ].join('\n'),
    }))
    .filter((t) => t.content.trim() !== '');
}

export function toSourceDocuments(
  transcripts: readonly { filename: string; content: string }[],
): SourceDocument[] {
  return transcripts.map((t) => ({
    kind: 'transcript',
    reference: t.filename,
    title: t.filename.replace(/\.[^.]+$/, ''),
    content: t.content,
  }));
}
