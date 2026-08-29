/**
 * The three-tab sheet interface (VAULT / EDITIONS / REPURPOSING).
 *
 * Row <-> record mapping lives here so the CSV backend and the Google Sheets
 * backend can never disagree about column order. Both are driven by the
 * *_FIELDS arrays in schemas/contracts.ts.
 */

import {
  EDITIONS_COLUMNS,
  EDITIONS_FIELDS,
  REPURPOSING_COLUMNS,
  REPURPOSING_FIELDS,
  VAULT_COLUMNS,
  VAULT_FIELDS,
  type DerivedAsset,
  type EditionRecord,
  type SpikeRecord,
} from '../schemas/contracts.js';

export const TABS = {
  VAULT: 'VAULT',
  EDITIONS: 'EDITIONS',
  REPURPOSING: 'REPURPOSING',
} as const;
export type TabName = (typeof TABS)[keyof typeof TABS];

export const TAB_HEADERS: Record<TabName, readonly string[]> = {
  VAULT: VAULT_COLUMNS,
  EDITIONS: EDITIONS_COLUMNS,
  REPURPOSING: REPURPOSING_COLUMNS,
};

/** Fields the sheet stores as text but the contract types as a number. */
const NUMERIC_FIELDS = new Set<string>(['score']);

export interface SheetStore {
  readonly label: string;
  /** Create any missing tabs with their header row. Safe to call repeatedly. */
  ensureTabs(): Promise<void>;

  readVault(): Promise<SpikeRecord[]>;
  appendVaultRow(spike: SpikeRecord): Promise<void>;
  updateVaultRow(spikeId: string, updates: Partial<SpikeRecord>): Promise<void>;

  readEditions(): Promise<EditionRecord[]>;
  appendEditionRow(edition: EditionRecord): Promise<void>;
  updateEditionRow(edition: string, updates: Partial<EditionRecord>): Promise<void>;

  readRepurposing(): Promise<DerivedAsset[]>;
  appendRepurposingRows(assets: DerivedAsset[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

export function recordToRow<T extends object>(fields: readonly (keyof T)[], record: T): string[] {
  return fields.map((field) => {
    const value = record[field];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function rowToRecord<T extends object>(fields: readonly (keyof T)[], row: readonly string[]): T {
  const record: Record<string, unknown> = {};
  fields.forEach((field, index) => {
    const raw = row[index] ?? '';
    if (NUMERIC_FIELDS.has(String(field))) {
      const n = Number(raw);
      record[String(field)] = Number.isFinite(n) ? n : 0;
    } else {
      record[String(field)] = raw;
    }
  });
  return record as T;
}

export const RowMappers = {
  vault: {
    fields: VAULT_FIELDS,
    toRow: (s: SpikeRecord) => recordToRow(VAULT_FIELDS, s),
    fromRow: (row: readonly string[]) => rowToRecord<SpikeRecord>(VAULT_FIELDS, row),
  },
  editions: {
    fields: EDITIONS_FIELDS,
    toRow: (e: EditionRecord) => recordToRow(EDITIONS_FIELDS, e),
    fromRow: (row: readonly string[]) => rowToRecord<EditionRecord>(EDITIONS_FIELDS, row),
  },
  repurposing: {
    fields: REPURPOSING_FIELDS,
    toRow: (a: DerivedAsset) => recordToRow(REPURPOSING_FIELDS, a),
    fromRow: (row: readonly string[]) => rowToRecord<DerivedAsset>(REPURPOSING_FIELDS, row),
  },
} as const;

/** Merge a partial update onto a row without disturbing untouched columns. */
export function applyUpdates<T extends object>(
  fields: readonly (keyof T)[],
  row: readonly string[],
  updates: Partial<T>,
): string[] {
  const next = fields.map((_, i) => row[i] ?? '');
  fields.forEach((field, index) => {
    if (Object.prototype.hasOwnProperty.call(updates, field)) {
      const value = updates[field];
      next[index] = value === undefined || value === null ? '' : String(value);
    }
  });
  return next;
}

/** Does this row match the tab's contract header? Case- and space-insensitive. */
export function isHeaderRow(tab: TabName, row: readonly string[] | undefined): boolean {
  if (!row) return false;
  const expected = TAB_HEADERS[tab];
  if (row.length < expected.length) return false;
  return expected.every((column, i) => normaliseHeader(row[i] ?? '') === normaliseHeader(column));
}

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Describe what is wrong with a header row, for an actionable error.
 * Returns null when the header is fine.
 */
export function describeHeaderProblem(tab: TabName, row: readonly string[] | undefined): string | null {
  if (isHeaderRow(tab, row)) return null;
  const expected = TAB_HEADERS[tab];
  if (!row || row.length === 0) return `${tab} is missing its header row`;

  const missing = expected.filter(
    (column) => !row.some((cell) => normaliseHeader(cell) === normaliseHeader(column)),
  );
  // No column matched at all: this is a data row sitting where the header
  // should be, not a header with columns missing. Saying "missing 16 columns"
  // sends people looking for the wrong problem.
  if (missing.length === expected.length) {
    return `${tab} is missing its header row (the first row looks like data)`;
  }
  if (missing.length > 0) {
    return `${tab} header is missing column(s): ${missing.join(', ')}`;
  }
  return `${tab} header columns are in the wrong order`;
}

/** Row index (0-based, excluding the header) of the first match, or -1. */
export function findRowIndex(rows: readonly (readonly string[])[], column: number, value: string): number {
  return rows.findIndex((row) => (row[column] ?? '').trim() === value.trim());
}
