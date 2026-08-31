/**
 * Tenant configuration.
 *
 * Non-negotiable #1: zero tenant-specific facts in the code. Every brand name,
 * voice rule, redline, persona and CTA is read from the data layer at runtime.
 * This file defines the *shape* of that config and nothing about its content.
 */

import YAML from 'yaml';
import { ASSET_TYPES, type AssetType } from '../schemas/contracts.js';
import { TenantPaths, type Storage } from '../io/storage.js';

export interface AuthorConfig {
  key: string;
  name: string;
  email: string;
  timezone: string;
  /** Accumulated voice corrections, e.g. lessons-harish.md */
  lessons_file: string;
}

export interface BrandConfig {
  key: string;
  name: string;
  /** Used to build anchor IDs: {prefix}-{CHANNEL}-{date}-{seq} */
  prefix: string;
  voice_file: string;
  redlines_file: string;
  positioning_file: string;
  audiences_file: string;
  ctas_file: string;
  pillars: string[];
}

export interface ChannelConfig {
  key: string;
  name: string;
  target_words: number;
  /** Free-text shape guidance handed to the writer prompt. */
  structure_notes: string;
  /** Middle segment of the anchor ID, e.g. "ARTICLE" in ABD-ARTICLE-20260815-001. */
  anchor_token: string;
}

export interface BundleItem {
  asset_type: AssetType;
  count: number;
  notes: string;
}

export interface CriticThresholds {
  /** Every check must reach this, with zero flags, for a PASS. */
  pass_score: number;
  /** A boundary score below this is an automatic fail — brand/redline breach. */
  boundary_fail_score: number;
  /** How many revise cycles a session will run before giving up. */
  max_revise_cycles: number;
}

export interface SourcesConfig {
  subscriptions_inbox: {
    enabled: boolean;
    email: string;
    label: string;
    /** Prose-word floor; below this a message is platform chrome, not content. */
    min_words: number;
    /** From-header substrings to drop, e.g. "no-reply@substack.com". */
    exclude_senders: string[];
  };
  transcripts: { enabled: boolean; type: string; folder_id: string };
  dossiers: { enabled: boolean; folder_id: string; keywords: string[] };
}

export interface TenantConfig {
  tenant: string;
  active_brands: string[];
  authors: Record<string, AuthorConfig>;
  brands: Record<string, BrandConfig>;
  channels: Record<string, ChannelConfig>;
  default_channel: string;
  default_author: string;
  sheet: { id: string; credentials_ref: string };
  drive: { root_folder_id: string };
  sources: SourcesConfig;
  esp: { type: string; api_key_ref: string; list_id: string };
  seasonality_file: string;
  /** Composition of the derived-asset bundle. Counts sum to the bundle size. */
  bundle: BundleItem[];
  oracle: { top_n: number; stale_draft_days: number };
  critic: CriticThresholds;
  /** Everything else from the YAML, so tenants can carry extra keys. */
  raw: Record<string, unknown>;
}

class ConfigError extends Error {
  constructor(tenant: string, message: string) {
    super(`tenant.yaml for "${tenant}" is invalid: ${message}`);
    this.name = 'ConfigError';
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function loadTenantConfig(tenant: string, storage: Storage): Promise<TenantConfig> {
  const path = TenantPaths.config(tenant);
  let raw: string;
  try {
    raw = await storage.readFile(path);
  } catch (error) {
    throw new Error(
      `Could not read ${path} from ${storage.label}.\n` +
        `Run:  npm run cli -- init --tenant ${tenant} --sheet-id <your-sheet-id>\n` +
        `Cause: ${(error as Error).message}`,
    );
  }
  return parseTenantConfig(tenant, raw);
}

export function parseTenantConfig(tenant: string, yamlText: string): TenantConfig {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (error) {
    throw new ConfigError(tenant, `not valid YAML — ${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ConfigError(tenant, 'file is empty');
  }
  const doc = parsed as Record<string, unknown>;

  const name = String(doc.tenant ?? tenant);
  if (name !== tenant) {
    throw new ConfigError(tenant, `declares tenant: "${name}" but lives in the "${tenant}" folder`);
  }

  const activeBrands = asStringArray(doc.active_brands);
  if (activeBrands.length === 0) {
    throw new ConfigError(tenant, 'active_brands is empty — list at least one brand');
  }

  const authors = parseAuthors(tenant, doc.authors);
  const brands = parseBrands(tenant, activeBrands, doc.brands);
  const channels = parseChannels(doc.channels);

  const authorKeys = Object.keys(authors);
  const defaultAuthor = String(doc.default_author ?? authorKeys[0] ?? '');
  if (!authors[defaultAuthor]) {
    throw new ConfigError(tenant, `default_author "${defaultAuthor}" is not defined under authors:`);
  }

  const channelKeys = Object.keys(channels);
  const defaultChannel = String(doc.default_channel ?? channelKeys[0] ?? '');
  if (!channels[defaultChannel]) {
    throw new ConfigError(tenant, `default_channel "${defaultChannel}" is not defined under channels:`);
  }

  return {
    tenant: name,
    active_brands: activeBrands,
    authors,
    brands,
    channels,
    default_channel: defaultChannel,
    default_author: defaultAuthor,
    sheet: {
      id: String(asRecord(doc.sheet).id ?? ''),
      credentials_ref: String(asRecord(doc.sheet).credentials_ref ?? 'gsheets_service_account'),
    },
    drive: { root_folder_id: String(asRecord(doc.drive).root_folder_id ?? '') },
    sources: parseSources(doc.sources),
    esp: {
      type: String(asRecord(doc.esp).type ?? ''),
      api_key_ref: String(asRecord(doc.esp).api_key_ref ?? ''),
      list_id: String(asRecord(doc.esp).list_id ?? ''),
    },
    seasonality_file: String(doc.seasonality_file ?? 'seasonal.yaml'),
    bundle: parseBundle(tenant, doc.bundle),
    oracle: {
      top_n: Number(asRecord(doc.oracle).top_n ?? 6),
      stale_draft_days: Number(asRecord(doc.oracle).stale_draft_days ?? 2),
    },
    critic: {
      pass_score: Number(asRecord(doc.critic).pass_score ?? 8),
      boundary_fail_score: Number(asRecord(doc.critic).boundary_fail_score ?? 6),
      max_revise_cycles: Number(asRecord(doc.critic).max_revise_cycles ?? 3),
    },
    raw: doc,
  };
}

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v)).filter((v) => v.trim() !== '');
}

function parseAuthors(tenant: string, value: unknown): Record<string, AuthorConfig> {
  const source = asRecord(value);
  const authors: Record<string, AuthorConfig> = {};
  for (const [key, entry] of Object.entries(source)) {
    const a = asRecord(entry);
    authors[key] = {
      key,
      name: String(a.name ?? key),
      email: String(a.email ?? ''),
      timezone: String(a.timezone ?? 'UTC'),
      lessons_file: String(a.lessons_file ?? `lessons-${key}.md`),
    };
  }
  if (Object.keys(authors).length === 0) {
    throw new ConfigError(tenant, 'no authors defined — add at least one under authors:');
  }
  return authors;
}

function parseBrands(
  tenant: string,
  activeBrands: string[],
  value: unknown,
): Record<string, BrandConfig> {
  const source = asRecord(value);
  const brands: Record<string, BrandConfig> = {};

  for (const key of activeBrands) {
    const b = asRecord(source[key]);
    const slug = key.toLowerCase();
    brands[key] = {
      key,
      name: String(b.name ?? key),
      prefix: String(b.prefix ?? key).toUpperCase(),
      voice_file: String(b.voice_file ?? `voice-${slug}.md`),
      redlines_file: String(b.redlines_file ?? `redlines-${slug}.md`),
      positioning_file: String(b.positioning_file ?? `positioning-${slug}.md`),
      audiences_file: String(b.audiences_file ?? `audiences-${slug}.md`),
      ctas_file: String(b.ctas_file ?? `ctas-${slug}.md`),
      pillars: asStringArray(b.pillars),
    };
  }

  // A brand configured but not listed as active is almost always a typo.
  for (const key of Object.keys(source)) {
    if (!brands[key]) {
      throw new ConfigError(
        tenant,
        `brands: defines "${key}" but active_brands does not list it — add it or remove the block`,
      );
    }
  }
  return brands;
}

function parseChannels(value: unknown): Record<string, ChannelConfig> {
  const source = asRecord(value);
  const channels: Record<string, ChannelConfig> = {};
  for (const [key, entry] of Object.entries(source)) {
    const c = asRecord(entry);
    channels[key] = {
      key,
      name: String(c.name ?? key),
      target_words: Number(c.target_words ?? 1200),
      structure_notes: String(c.structure_notes ?? ''),
      anchor_token: String(c.anchor_token ?? defaultAnchorToken(key)),
    };
  }
  if (Object.keys(channels).length === 0) {
    channels['website-article'] = {
      key: 'website-article',
      name: 'Website article',
      target_words: 1200,
      structure_notes: '',
      anchor_token: defaultAnchorToken('website-article'),
    };
  }
  return channels;
}

/** "website-article" -> "ARTICLE". Anchor IDs stay short and readable. */
export function defaultAnchorToken(channelKey: string): string {
  const last = channelKey.split('-').pop() ?? channelKey;
  return last.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'ASSET';
}

function parseSources(value: unknown): SourcesConfig {
  const s = asRecord(value);
  const inbox = asRecord(s.subscriptions_inbox);
  const transcripts = asRecord(s.transcripts);
  const dossiers = asRecord(s.dossiers);
  return {
    subscriptions_inbox: {
      enabled: inbox.enabled !== false && String(inbox.email ?? '') !== '',
      email: String(inbox.email ?? ''),
      label: String(inbox.label ?? 'INBOX'),
      min_words: Number(inbox.min_words ?? 200),
      exclude_senders: asStringArray(inbox.exclude_senders),
    },
    transcripts: {
      enabled: transcripts.enabled !== false,
      type: String(transcripts.type ?? 'manual_export'),
      folder_id: String(transcripts.folder_id ?? ''),
    },
    dossiers: {
      enabled: dossiers.enabled !== false,
      folder_id: String(dossiers.folder_id ?? ''),
      keywords: asStringArray(dossiers.keywords),
    },
  };
}

/** Default bundle: 7 derived assets across the five Contract-6 asset types. */
export const DEFAULT_BUNDLE: BundleItem[] = [
  { asset_type: 'linkedin-post', count: 2, notes: 'One narrative, one contrarian' },
  { asset_type: 'x-thread', count: 1, notes: '5-8 posts' },
  { asset_type: 'tweet', count: 2, notes: 'Standalone, quotable' },
  { asset_type: 'podcast-clip', count: 1, notes: '60-90s talking point' },
  { asset_type: 'shorts-script', count: 1, notes: '30-45s vertical video' },
];

function parseBundle(tenant: string, value: unknown): BundleItem[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_BUNDLE;
  return value.map((entry, i) => {
    const b = asRecord(entry);
    const assetType = String(b.asset_type ?? '');
    if (!(ASSET_TYPES as readonly string[]).includes(assetType)) {
      throw new ConfigError(
        tenant,
        `bundle[${i}].asset_type "${assetType}" is not one of ${ASSET_TYPES.join(' | ')}`,
      );
    }
    const count = Number(b.count ?? 1);
    if (!Number.isInteger(count) || count < 1) {
      throw new ConfigError(tenant, `bundle[${i}].count must be an integer >= 1`);
    }
    return { asset_type: assetType as AssetType, count, notes: String(b.notes ?? '') };
  });
}

export function bundleSize(config: TenantConfig): number {
  return config.bundle.reduce((sum, item) => sum + item.count, 0);
}

// ---------------------------------------------------------------------------
// Lookups — these throw with the list of valid options, which is far more
// useful at a CLI than "undefined is not an object".
// ---------------------------------------------------------------------------

export function getBrand(config: TenantConfig, brand: string): BrandConfig {
  const found = config.brands[brand];
  if (!found) {
    throw new Error(
      `Brand "${brand}" is not active for tenant "${config.tenant}". ` +
        `Active brands: ${config.active_brands.join(', ')}`,
    );
  }
  return found;
}

export function getAuthor(config: TenantConfig, author: string): AuthorConfig {
  const found = config.authors[author];
  if (!found) {
    throw new Error(
      `Author "${author}" is not defined for tenant "${config.tenant}". ` +
        `Known authors: ${Object.keys(config.authors).join(', ')}`,
    );
  }
  return found;
}

export function getChannel(config: TenantConfig, channel: string): ChannelConfig {
  const found = config.channels[channel];
  if (!found) {
    throw new Error(
      `Channel "${channel}" is not defined for tenant "${config.tenant}". ` +
        `Known channels: ${Object.keys(config.channels).join(', ')}`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Reference material (the "Section 2" files) — loaded on demand for prompts.
// ---------------------------------------------------------------------------

export interface BrandContext {
  brand: BrandConfig;
  author: AuthorConfig;
  channel: ChannelConfig;
  voice: string;
  redlines: string;
  positioning: string;
  audiences: string;
  ctas: string;
  lessons: string;
  seasonality: string;
}

async function readOptional(storage: Storage, tenant: string, file: string): Promise<string> {
  if (!file) return '';
  const path = TenantPaths.reference(tenant, file);
  if (!(await storage.exists(path))) return '';
  return (await storage.readFile(path)).trim();
}

/**
 * Load every reference file the writer/critic/bundler prompts need. Missing
 * files degrade to empty strings — a tenant mid-setup should still be able to
 * run a session, just with thinner guidance.
 */
export async function loadBrandContext(
  config: TenantConfig,
  storage: Storage,
  brandKey: string,
  authorKey: string,
  channelKey: string,
): Promise<BrandContext> {
  const brand = getBrand(config, brandKey);
  const author = getAuthor(config, authorKey);
  const channel = getChannel(config, channelKey);
  const t = config.tenant;

  const [voice, redlines, positioning, audiences, ctas, lessons, seasonality] = await Promise.all([
    readOptional(storage, t, brand.voice_file),
    readOptional(storage, t, brand.redlines_file),
    readOptional(storage, t, brand.positioning_file),
    readOptional(storage, t, brand.audiences_file),
    readOptional(storage, t, brand.ctas_file),
    readOptional(storage, t, author.lessons_file),
    readOptional(storage, t, config.seasonality_file),
  ]);

  return { brand, author, channel, voice, redlines, positioning, audiences, ctas, lessons, seasonality };
}

/** Which reference files are missing — surfaced by `init` and `session`. */
export async function missingReferenceFiles(
  config: TenantConfig,
  storage: Storage,
): Promise<string[]> {
  const files = new Set<string>([config.seasonality_file]);
  for (const brand of Object.values(config.brands)) {
    files.add(brand.voice_file);
    files.add(brand.redlines_file);
    files.add(brand.positioning_file);
    files.add(brand.audiences_file);
    files.add(brand.ctas_file);
  }
  for (const author of Object.values(config.authors)) files.add(author.lessons_file);

  const missing: string[] = [];
  for (const file of files) {
    if (!file) continue;
    if (!(await storage.exists(TenantPaths.reference(config.tenant, file)))) missing.push(file);
  }
  return missing.sort();
}
