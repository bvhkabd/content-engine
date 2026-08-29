/**
 * ID generation. Pure functions — the caller supplies today's date and the
 * records that already exist, so this is fully deterministic and testable.
 */

import type { SpikeRecord } from '../schemas/contracts.js';
import type { BrandConfig, ChannelConfig } from '../config/tenant.js';

export function compactDate(date: Date | string): string {
  const iso = typeof date === 'string' ? date : date.toISOString().slice(0, 10);
  return iso.slice(0, 10).replace(/-/g, '');
}

export function isoDate(date: Date | string): string {
  return typeof date === 'string' ? date.slice(0, 10) : date.toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

/**
 * Next SPIKE-YYYYMMDD-NNN for the given day. Sequence is per-day and derived
 * from what is already in the VAULT, so two runs on the same day never collide.
 */
export function nextSpikeId(existing: readonly SpikeRecord[], date: Date | string): string {
  const stamp = compactDate(date);
  const prefix = `SPIKE-${stamp}-`;
  let max = 0;
  for (const spike of existing) {
    if (!spike.spike_id.startsWith(prefix)) continue;
    const seq = Number(spike.spike_id.slice(prefix.length));
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${pad(max + 1)}`;
}

/** Allocate `count` consecutive spike IDs without re-reading the vault. */
export function nextSpikeIds(
  existing: readonly SpikeRecord[],
  date: Date | string,
  count: number,
): string[] {
  const first = nextSpikeId(existing, date);
  const stamp = compactDate(date);
  const start = Number(first.slice(`SPIKE-${stamp}-`.length));
  return Array.from({ length: count }, (_, i) => `SPIKE-${stamp}-${pad(start + i)}`);
}

/** ABD-ARTICLE-20260815-001 */
export function buildAnchorId(
  brand: BrandConfig,
  channel: ChannelConfig,
  date: Date | string,
  sequence: number,
): string {
  return `${brand.prefix}-${channel.anchor_token}-${compactDate(date)}-${pad(sequence)}`;
}

/**
 * Next anchor ID for today, given the draft filenames already in drafts/.
 * Filenames look like `{anchor-id}-v{n}.md`.
 */
export function nextAnchorId(
  existingDraftFiles: readonly string[],
  brand: BrandConfig,
  channel: ChannelConfig,
  date: Date | string,
): string {
  const prefix = `${brand.prefix}-${channel.anchor_token}-${compactDate(date)}-`;
  let max = 0;
  for (const file of existingDraftFiles) {
    if (!file.startsWith(prefix)) continue;
    const seq = Number(file.slice(prefix.length).split('-')[0]);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${pad(max + 1)}`;
}

export function draftFileName(anchorId: string, version: number): string {
  return `${anchorId}-v${version}.md`;
}

export function criticReportFileName(anchorId: string, version: number): string {
  return `${anchorId}-v${version}.md`;
}

/** Highest version already on disk for this anchor, or 0 if none. */
export function latestVersion(files: readonly string[], anchorId: string): number {
  let max = 0;
  const re = new RegExp(`^${escapeRegex(anchorId)}-v(\\d+)\\.md$`);
  for (const file of files) {
    const match = re.exec(file);
    const version = Number(match?.[1]);
    if (Number.isFinite(version) && version > max) max = version;
  }
  return max;
}

/** interviews/{spike-id}-{author}-{date}.md */
export function interviewFileName(spikeId: string, author: string, date: Date | string): string {
  return `${spikeId}-${author}-${isoDate(date)}.md`;
}

/** Any interview file belonging to this spike, newest last. */
export function findInterviewFiles(files: readonly string[], spikeId: string): string[] {
  return files.filter((f) => f.startsWith(`${spikeId}-`) && f.endsWith('.md')).sort();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
