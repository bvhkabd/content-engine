/**
 * Sheet header integrity.
 *
 * Regression coverage for silent data loss: `read()` used to drop row 1
 * unconditionally, so a hand-created CSV without a header lost its first
 * record. The row was in the file, but `topics` never listed it and `session`
 * reported the spike as missing — the worst kind of failure, because nothing
 * looked wrong.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage } from '../src/io/local-storage.js';
import { LocalSheetStore } from '../src/io/local-sheets.js';
import { TABS, TAB_HEADERS, describeHeaderProblem, isHeaderRow } from '../src/io/sheets.js';
import { serialiseCsv } from '../src/io/csv.js';
import { VAULT_COLUMNS } from '../src/schemas/contracts.js';
import { validSpike } from './contracts.test.js';

describe('isHeaderRow', () => {
  it('accepts the exact contract header', () => {
    expect(isHeaderRow('VAULT', [...VAULT_COLUMNS])).toBe(true);
  });

  it('tolerates case and surrounding whitespace', () => {
    expect(isHeaderRow('VAULT', VAULT_COLUMNS.map((c) => `  ${c.toUpperCase()} `))).toBe(true);
  });

  it('accepts extra trailing columns a user may have added', () => {
    expect(isHeaderRow('VAULT', [...VAULT_COLUMNS, 'My Notes'])).toBe(true);
  });

  it('rejects a data row', () => {
    expect(isHeaderRow('VAULT', ['SPIKE-20260829-001', '2026-08-29', 'ABD'])).toBe(false);
  });

  it('rejects a short or absent row', () => {
    expect(isHeaderRow('VAULT', ['Spike-ID'])).toBe(false);
    expect(isHeaderRow('VAULT', undefined)).toBe(false);
  });

  it('rejects reordered columns', () => {
    const swapped = [...VAULT_COLUMNS];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(isHeaderRow('VAULT', swapped)).toBe(false);
  });
});

describe('describeHeaderProblem', () => {
  it('returns null for a good header', () => {
    expect(describeHeaderProblem('VAULT', [...VAULT_COLUMNS])).toBeNull();
  });

  it('names the missing columns', () => {
    const problem = describeHeaderProblem('VAULT', VAULT_COLUMNS.filter((c) => c !== 'Angle'));
    expect(problem).toContain('missing column(s)');
    expect(problem).toContain('Angle');
  });

  it('distinguishes wrong order from missing columns', () => {
    const swapped = [...VAULT_COLUMNS];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(describeHeaderProblem('VAULT', swapped)).toContain('wrong order');
  });

  it('reports an absent header row', () => {
    expect(describeHeaderProblem('VAULT', [])).toContain('missing its header row');
  });
});

describe('LocalSheetStore header enforcement', () => {
  let dir: string;
  let storage: LocalStorage;
  let sheet: LocalSheetStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ce-hdr-'));
    storage = new LocalStorage(dir);
    sheet = new LocalSheetStore(storage, 'harish');
    await sheet.ensureTabs();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses to read a headerless file rather than eating the first row', async () => {
    // Two real spikes, no header. The old code returned only the second.
    await storage.writeFile(
      'harish/sheets/VAULT.csv',
      serialiseCsv([
        ['SPIKE-20260829-001', '2026-08-29', 'ABD', 'harish', 'manual', 'r1', 'First', 'Angle 1', '', '', '', '', '7', 'NEW', '', ''],
        ['SPIKE-20260829-002', '2026-08-29', 'ABD', 'harish', 'manual', 'r2', 'Second', 'Angle 2', '', '', '', '', '8', 'NEW', '', ''],
      ]),
    );

    await expect(sheet.readVault()).rejects.toThrow(/missing its header row/);
    // The error must name the file and show both rows' worth of context.
    await expect(sheet.readVault()).rejects.toThrow(/harish\/sheets\/VAULT\.csv/);
  });

  it('names the missing column when the header is partial', async () => {
    await storage.writeFile(
      'harish/sheets/VAULT.csv',
      serialiseCsv([VAULT_COLUMNS.filter((c) => c !== 'Score'), []]),
    );
    await expect(sheet.readVault()).rejects.toThrow(/missing column\(s\).*Score/s);
  });

  it('still reads a correct file normally', async () => {
    await sheet.appendVaultRow(validSpike);
    expect(await sheet.readVault()).toEqual([validSpike]);
  });

  it('treats a missing file as empty, not an error', async () => {
    await rm(join(dir, 'harish/sheets/VAULT.csv'));
    expect(await sheet.readVault()).toEqual([]);
  });

  it('enforces headers on all three tabs', async () => {
    for (const tab of Object.values(TABS)) {
      await storage.writeFile(`harish/sheets/${tab}.csv`, serialiseCsv([['bogus', 'header']]));
    }
    await expect(sheet.readVault()).rejects.toThrow(/VAULT/);
    await expect(sheet.readEditions()).rejects.toThrow(/EDITIONS/);
    await expect(sheet.readRepurposing()).rejects.toThrow(/REPURPOSING/);
  });

  it('ensureTabs restores a header without touching other tabs', async () => {
    await sheet.appendVaultRow(validSpike);
    await storage.writeFile('harish/sheets/EDITIONS.csv', '');
    await sheet.ensureTabs();
    expect(await sheet.readVault()).toEqual([validSpike]);
    expect(await sheet.readEditions()).toEqual([]);
  });

  it('every tab header matches its contract columns', () => {
    for (const [tab, header] of Object.entries(TAB_HEADERS)) {
      expect(isHeaderRow(tab as keyof typeof TAB_HEADERS, [...header])).toBe(true);
    }
  });
});
