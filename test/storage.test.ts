/**
 * CSV encoding, the local storage adapter, and the local sheet store.
 *
 * The sheet store tests are the important ones: they exercise the exact
 * row-mapping code the Google backend uses, so column drift shows up here.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCsv, serialiseCsv } from '../src/io/csv.js';
import { LocalStorage } from '../src/io/local-storage.js';
import { LocalSheetStore } from '../src/io/local-sheets.js';
import { TAB_HEADERS, applyUpdates, recordToRow, rowToRecord } from '../src/io/sheets.js';
import { VAULT_COLUMNS, VAULT_FIELDS, type SpikeRecord } from '../src/schemas/contracts.js';
import { validAsset, validEdition, validSpike } from './contracts.test.js';

describe('csv', () => {
  it('round-trips plain values', () => {
    const rows = [
      ['a', 'b'],
      ['1', '2'],
    ];
    expect(parseCsv(serialiseCsv(rows))).toEqual(rows);
  });

  it('round-trips commas, quotes and newlines', () => {
    const rows = [['Text'], ['He said "no, never".\nThen he left.'], ['plain']];
    expect(parseCsv(serialiseCsv(rows))).toEqual(rows);
  });

  it('preserves empty trailing fields', () => {
    const rows = [['a', '', '']];
    expect(parseCsv(serialiseCsv(rows))).toEqual(rows);
  });

  it('handles CRLF input', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('row mapping', () => {
  it('maps a record to a row and back', () => {
    const row = recordToRow(VAULT_FIELDS, validSpike);
    expect(row).toHaveLength(VAULT_COLUMNS.length);
    expect(rowToRecord<SpikeRecord>(VAULT_FIELDS, row)).toEqual(validSpike);
  });

  it('coerces score back to a number', () => {
    const row = recordToRow(VAULT_FIELDS, validSpike);
    expect(typeof rowToRecord<SpikeRecord>(VAULT_FIELDS, row).score).toBe('number');
  });

  it('pads a short row rather than producing undefined cells', () => {
    const record = rowToRecord<SpikeRecord>(VAULT_FIELDS, ['SPIKE-20260815-001']);
    expect(record.notes).toBe('');
    expect(record.score).toBe(0);
  });

  it('applyUpdates only touches the named columns', () => {
    const row = recordToRow(VAULT_FIELDS, validSpike);
    const next = applyUpdates<SpikeRecord>(VAULT_FIELDS, row, { status: 'DRAFTED' });
    expect(next[13]).toBe('DRAFTED');
    expect(next[6]).toBe(validSpike.topic);
    expect(next).toHaveLength(row.length);
  });
});

describe('LocalStorage', () => {
  let dir: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ce-storage-'));
    storage = new LocalStorage(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes and reads a file, creating parent folders', async () => {
    await storage.writeFile('t/interviews/a.md', 'hello');
    expect(await storage.readFile('t/interviews/a.md')).toBe('hello');
    expect(await storage.exists('t/interviews/a.md')).toBe(true);
  });

  it('throws FileNotFoundError with the path for a missing file', async () => {
    await expect(storage.readFile('t/missing.md')).rejects.toThrow(/File not found: t\/missing\.md/);
  });

  it('lists only files, sorted, hidden files excluded', async () => {
    await storage.writeFile('t/b.md', '');
    await storage.writeFile('t/a.md', '');
    await storage.writeFile('t/.hidden', '');
    await storage.ensureDir('t/sub');
    expect(await storage.list('t')).toEqual(['a.md', 'b.md']);
  });

  it('returns an empty list for a missing folder', async () => {
    expect(await storage.list('nope')).toEqual([]);
  });

  it('appends', async () => {
    await storage.appendFile('t/log.txt', 'one\n');
    await storage.appendFile('t/log.txt', 'two\n');
    expect(await storage.readFile('t/log.txt')).toBe('one\ntwo\n');
  });

  it('refuses to escape the tenants root', async () => {
    await expect(storage.readFile('../../etc/passwd')).rejects.toThrow(/outside the tenants root/);
  });
});

describe('LocalSheetStore', () => {
  let dir: string;
  let sheet: LocalSheetStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ce-sheet-'));
    sheet = new LocalSheetStore(new LocalStorage(dir), 'harish');
    await sheet.ensureTabs();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates all three tabs with contract headers', async () => {
    const storage = new LocalStorage(dir);
    for (const [tab, header] of Object.entries(TAB_HEADERS)) {
      const text = await storage.readFile(`harish/sheets/${tab}.csv`);
      expect(parseCsv(text)[0]).toEqual([...header]);
    }
  });

  it('starts empty', async () => {
    expect(await sheet.readVault()).toEqual([]);
    expect(await sheet.readEditions()).toEqual([]);
    expect(await sheet.readRepurposing()).toEqual([]);
  });

  it('appends and reads back a spike unchanged', async () => {
    await sheet.appendVaultRow(validSpike);
    expect(await sheet.readVault()).toEqual([validSpike]);
  });

  it('updates only the named fields', async () => {
    await sheet.appendVaultRow(validSpike);
    await sheet.updateVaultRow(validSpike.spike_id, { status: 'DRAFTED', used_in: 'ABD-ARTICLE-20260815-001' });
    const [row] = await sheet.readVault();
    expect(row).toEqual({ ...validSpike, status: 'DRAFTED', used_in: 'ABD-ARTICLE-20260815-001' });
  });

  it('throws a clear error updating a spike that is not there', async () => {
    await expect(sheet.updateVaultRow('SPIKE-20260101-999', { status: 'USED' })).rejects.toThrow(
      /SPIKE-20260101-999.*not found/,
    );
  });

  it('survives text containing commas, quotes and newlines', async () => {
    const asset = { ...validAsset, text: 'Line one, with a comma.\n"Quoted", too.' };
    await sheet.appendRepurposingRows([asset]);
    expect(await sheet.readRepurposing()).toEqual([asset]);
  });

  it('appends multiple assets in order', async () => {
    await sheet.appendRepurposingRows([validAsset, { ...validAsset, asset_type: 'tweet', text: 'Short.' }]);
    const rows = await sheet.readRepurposing();
    expect(rows.map((r) => r.asset_type)).toEqual(['linkedin-post', 'tweet']);
  });

  it('appending no assets is a no-op', async () => {
    await sheet.appendRepurposingRows([]);
    expect(await sheet.readRepurposing()).toEqual([]);
  });

  it('round-trips an edition and updates it', async () => {
    await sheet.appendEditionRow(validEdition);
    await sheet.updateEditionRow(validEdition.edition, { status: 'SENT', date_published: '2026-08-20' });
    const [row] = await sheet.readEditions();
    expect(row!.status).toBe('SENT');
    expect(row!.date_published).toBe('2026-08-20');
    expect(row!.topic).toBe(validEdition.topic);
  });

  it('ensureTabs does not clobber existing rows', async () => {
    await sheet.appendVaultRow(validSpike);
    await sheet.ensureTabs();
    expect(await sheet.readVault()).toHaveLength(1);
  });
});
