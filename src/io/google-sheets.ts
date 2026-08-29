/**
 * Google Sheets backend. Three tabs, headers fixed by the contracts.
 *
 * Values are written RAW so a topic starting with "=" or "+" is stored as text
 * rather than evaluated as a formula.
 */

import { explainGoogleError, sheetsClient, type ServiceAccountCredentials } from './google-auth.js';
import {
  RowMappers,
  TABS,
  TAB_HEADERS,
  applyUpdates,
  findRowIndex,
  type SheetStore,
  type TabName,
} from './sheets.js';
import type { DerivedAsset, EditionRecord, SpikeRecord } from '../schemas/contracts.js';

type Sheets = ReturnType<typeof sheetsClient>;

export class GoogleSheetStore implements SheetStore {
  readonly label: string;
  private readonly sheets: Sheets;

  constructor(
    private readonly sheetId: string,
    credentials: string | ServiceAccountCredentials,
  ) {
    this.sheets = sheetsClient(credentials);
    this.label = `sheet:${sheetId}`;
  }

  private async listTabs(): Promise<string[]> {
    try {
      const res = await this.sheets.spreadsheets.get({ spreadsheetId: this.sheetId, fields: 'sheets.properties.title' });
      return (res.data.sheets ?? []).map((s) => s.properties?.title ?? '').filter(Boolean);
    } catch (error) {
      throw explainGoogleError(error, `Opening Google Sheet ${this.sheetId}`);
    }
  }

  async ensureTabs(): Promise<void> {
    const existing = new Set(await this.listTabs());
    const missing = (Object.values(TABS) as TabName[]).filter((t) => !existing.has(t));

    if (missing.length > 0) {
      try {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.sheetId,
          requestBody: {
            requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
          },
        });
      } catch (error) {
        throw explainGoogleError(error, `Creating tabs ${missing.join(', ')}`);
      }
    }

    // Write the header row on any tab that is empty or has a stale header.
    for (const tab of Object.values(TABS) as TabName[]) {
      const header = TAB_HEADERS[tab];
      const current = await this.getRange(`${tab}!1:1`);
      const currentHeader = current[0] ?? [];
      const matches =
        currentHeader.length === header.length && header.every((h, i) => (currentHeader[i] ?? '') === h);
      if (!matches) {
        await this.setRange(`${tab}!A1`, [[...header]]);
      }
    }
  }

  private async getRange(range: string): Promise<string[][]> {
    try {
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      return ((res.data.values ?? []) as unknown[][]).map((row) =>
        row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))),
      );
    } catch (error) {
      throw explainGoogleError(error, `Reading ${range}`);
    }
  }

  private async setRange(range: string, values: string[][]): Promise<void> {
    try {
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.sheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values },
      });
    } catch (error) {
      throw explainGoogleError(error, `Writing ${range}`);
    }
  }

  private async appendRows(tab: TabName, rows: string[][]): Promise<void> {
    if (rows.length === 0) return;
    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range: `${tab}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
    } catch (error) {
      throw explainGoogleError(error, `Appending to ${tab}`);
    }
  }

  /** Data rows, header excluded. */
  private async dataRows(tab: TabName): Promise<string[][]> {
    const all = await this.getRange(`${tab}!A2:ZZ`);
    return all.filter((row) => row.some((cell) => cell.trim() !== ''));
  }

  private columnLetter(index: number): string {
    let n = index + 1;
    let letter = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      letter = String.fromCharCode(65 + rem) + letter;
      n = Math.floor((n - 1) / 26);
    }
    return letter;
  }

  private async updateByKey<T extends object>(
    tab: TabName,
    fields: readonly (keyof T)[],
    key: string,
    updates: Partial<T>,
  ): Promise<void> {
    const rows = await this.dataRows(tab);
    const index = findRowIndex(rows, 0, key);
    if (index === -1) throw new Error(`"${key}" not found in ${this.label} ${tab}`);
    const next = applyUpdates(fields, rows[index]!, updates);
    // +2: one for the header row, one because sheets are 1-indexed.
    const rowNumber = index + 2;
    const lastCol = this.columnLetter(fields.length - 1);
    await this.setRange(`${tab}!A${rowNumber}:${lastCol}${rowNumber}`, [next]);
  }

  // -- VAULT ----------------------------------------------------------------

  async readVault(): Promise<SpikeRecord[]> {
    return (await this.dataRows(TABS.VAULT)).map(RowMappers.vault.fromRow);
  }

  async appendVaultRow(spike: SpikeRecord): Promise<void> {
    await this.appendRows(TABS.VAULT, [RowMappers.vault.toRow(spike)]);
  }

  async updateVaultRow(spikeId: string, updates: Partial<SpikeRecord>): Promise<void> {
    await this.updateByKey<SpikeRecord>(TABS.VAULT, RowMappers.vault.fields, spikeId, updates);
  }

  // -- EDITIONS -------------------------------------------------------------

  async readEditions(): Promise<EditionRecord[]> {
    return (await this.dataRows(TABS.EDITIONS)).map(RowMappers.editions.fromRow);
  }

  async appendEditionRow(edition: EditionRecord): Promise<void> {
    await this.appendRows(TABS.EDITIONS, [RowMappers.editions.toRow(edition)]);
  }

  async updateEditionRow(edition: string, updates: Partial<EditionRecord>): Promise<void> {
    await this.updateByKey<EditionRecord>(TABS.EDITIONS, RowMappers.editions.fields, edition, updates);
  }

  // -- REPURPOSING ----------------------------------------------------------

  async readRepurposing(): Promise<DerivedAsset[]> {
    return (await this.dataRows(TABS.REPURPOSING)).map(RowMappers.repurposing.fromRow);
  }

  async appendRepurposingRows(assets: DerivedAsset[]): Promise<void> {
    await this.appendRows(TABS.REPURPOSING, assets.map(RowMappers.repurposing.toRow));
  }
}

// ---------------------------------------------------------------------------
// Spec-level convenience wrappers (CLAUDE_CODE_BRIEF.md § Google Sheets)
// ---------------------------------------------------------------------------

export async function readVault(
  sheetId: string,
  credentials: string | ServiceAccountCredentials,
): Promise<SpikeRecord[]> {
  return new GoogleSheetStore(sheetId, credentials).readVault();
}

export async function appendVaultRow(
  sheetId: string,
  spike: SpikeRecord,
  credentials: string | ServiceAccountCredentials,
): Promise<void> {
  return new GoogleSheetStore(sheetId, credentials).appendVaultRow(spike);
}

export async function updateVaultRow(
  sheetId: string,
  spikeId: string,
  updates: Partial<SpikeRecord>,
  credentials: string | ServiceAccountCredentials,
): Promise<void> {
  return new GoogleSheetStore(sheetId, credentials).updateVaultRow(spikeId, updates);
}
