/**
 * Local sheet backend — one CSV per tab under tenants/{tenant}/sheets/.
 *
 * Same header rows and same column order as the real Google Sheet, so a CSV
 * written here can be imported straight into the Sheet (and vice versa).
 */

import { TenantPaths, type Storage } from './storage.js';
import { parseCsv, serialiseCsv } from './csv.js';
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

export class LocalSheetStore implements SheetStore {
  readonly label: string;

  constructor(
    private readonly storage: Storage,
    private readonly tenant: string,
  ) {
    this.label = `csv:${TenantPaths.sheets(tenant)}`;
  }

  private path(tab: TabName): string {
    return TenantPaths.sheet(this.tenant, tab);
  }

  /** Rows below the header. */
  private async read(tab: TabName): Promise<string[][]> {
    const path = this.path(tab);
    if (!(await this.storage.exists(path))) return [];
    const rows = parseCsv(await this.storage.readFile(path));
    if (rows.length === 0) return [];
    // Drop the header, then drop fully-blank rows (trailing newlines, manual edits).
    return rows.slice(1).filter((row) => row.some((cell) => cell.trim() !== ''));
  }

  private async write(tab: TabName, rows: readonly (readonly string[])[]): Promise<void> {
    const header = TAB_HEADERS[tab];
    await this.storage.writeFile(this.path(tab), serialiseCsv([[...header], ...rows]));
  }

  async ensureTabs(): Promise<void> {
    await this.storage.ensureDir(TenantPaths.sheets(this.tenant));
    for (const tab of Object.values(TABS)) {
      if (!(await this.storage.exists(this.path(tab)))) {
        await this.write(tab, []);
      }
    }
  }

  // -- VAULT ----------------------------------------------------------------

  async readVault(): Promise<SpikeRecord[]> {
    return (await this.read(TABS.VAULT)).map(RowMappers.vault.fromRow);
  }

  async appendVaultRow(spike: SpikeRecord): Promise<void> {
    const rows = await this.read(TABS.VAULT);
    rows.push(RowMappers.vault.toRow(spike));
    await this.write(TABS.VAULT, rows);
  }

  async updateVaultRow(spikeId: string, updates: Partial<SpikeRecord>): Promise<void> {
    const rows = await this.read(TABS.VAULT);
    const index = findRowIndex(rows, 0, spikeId);
    if (index === -1) throw new Error(`Spike "${spikeId}" not found in ${this.label} VAULT`);
    rows[index] = applyUpdates(RowMappers.vault.fields, rows[index]!, updates);
    await this.write(TABS.VAULT, rows);
  }

  // -- EDITIONS -------------------------------------------------------------

  async readEditions(): Promise<EditionRecord[]> {
    return (await this.read(TABS.EDITIONS)).map(RowMappers.editions.fromRow);
  }

  async appendEditionRow(edition: EditionRecord): Promise<void> {
    const rows = await this.read(TABS.EDITIONS);
    rows.push(RowMappers.editions.toRow(edition));
    await this.write(TABS.EDITIONS, rows);
  }

  async updateEditionRow(edition: string, updates: Partial<EditionRecord>): Promise<void> {
    const rows = await this.read(TABS.EDITIONS);
    const index = findRowIndex(rows, 0, edition);
    if (index === -1) throw new Error(`Edition "${edition}" not found in ${this.label} EDITIONS`);
    rows[index] = applyUpdates(RowMappers.editions.fields, rows[index]!, updates);
    await this.write(TABS.EDITIONS, rows);
  }

  // -- REPURPOSING ----------------------------------------------------------

  async readRepurposing(): Promise<DerivedAsset[]> {
    return (await this.read(TABS.REPURPOSING)).map(RowMappers.repurposing.fromRow);
  }

  async appendRepurposingRows(assets: DerivedAsset[]): Promise<void> {
    if (assets.length === 0) return;
    const rows = await this.read(TABS.REPURPOSING);
    for (const asset of assets) rows.push(RowMappers.repurposing.toRow(asset));
    await this.write(TABS.REPURPOSING, rows);
  }
}
