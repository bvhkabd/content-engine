/**
 * Tenant config parsing.
 *
 * These tests are the guard on non-negotiable #1: everything tenant-specific
 * has to survive a round trip through YAML, and a misconfiguration has to fail
 * loudly rather than silently defaulting to someone else's settings.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUNDLE,
  bundleSize,
  defaultAnchorToken,
  getAuthor,
  getBrand,
  getChannel,
  parseTenantConfig,
} from '../src/config/tenant.js';

const MINIMAL = `
tenant: harish
active_brands: [ABD]
authors:
  harish:
    name: "Harish"
`;

describe('parseTenantConfig', () => {
  it('parses a minimal config and fills in defaults', () => {
    const config = parseTenantConfig('harish', MINIMAL);
    expect(config.tenant).toBe('harish');
    expect(config.active_brands).toEqual(['ABD']);
    expect(config.default_author).toBe('harish');
    expect(config.default_channel).toBe('website-article');
    expect(config.bundle).toEqual(DEFAULT_BUNDLE);
    expect(bundleSize(config)).toBe(7);
    expect(config.critic).toEqual({ pass_score: 8, boundary_fail_score: 6, max_revise_cycles: 3 });
    expect(config.oracle).toEqual({ top_n: 6, stale_draft_days: 2 });
  });

  it('derives brand reference filenames from the brand key', () => {
    const brand = parseTenantConfig('harish', MINIMAL).brands.ABD!;
    expect(brand).toMatchObject({
      prefix: 'ABD',
      voice_file: 'voice-abd.md',
      redlines_file: 'redlines-abd.md',
      positioning_file: 'positioning-abd.md',
      audiences_file: 'audiences-abd.md',
      ctas_file: 'ctas-abd.md',
    });
  });

  it('honours explicit overrides', () => {
    const config = parseTenantConfig(
      'sirisha',
      `
tenant: sirisha
active_brands: [CTQ]
brands:
  CTQ:
    name: "Curious Thinkers Quarterly"
    prefix: CTQ
    voice_file: "house-voice.md"
    pillars: ["curiosity", "learning"]
authors:
  sirisha:
    name: "Sirisha"
    lessons_file: "corrections.md"
channels:
  newsletter:
    name: "Newsletter"
    target_words: 700
    anchor_token: "ISSUE"
critic:
  pass_score: 9
  max_revise_cycles: 5
oracle:
  top_n: 3
`,
    );
    expect(config.brands.CTQ!.voice_file).toBe('house-voice.md');
    expect(config.brands.CTQ!.pillars).toEqual(['curiosity', 'learning']);
    expect(config.authors.sirisha!.lessons_file).toBe('corrections.md');
    expect(config.default_channel).toBe('newsletter');
    expect(config.channels.newsletter!.anchor_token).toBe('ISSUE');
    expect(config.critic.pass_score).toBe(9);
    expect(config.critic.max_revise_cycles).toBe(5);
    expect(config.oracle.top_n).toBe(3);
  });

  it('rejects a config whose tenant name does not match its folder', () => {
    expect(() => parseTenantConfig('harish', 'tenant: sirisha\nactive_brands: [X]\nauthors:\n  a: {}')).toThrow(
      /declares tenant: "sirisha" but lives in the "harish" folder/,
    );
  });

  it('rejects empty active_brands', () => {
    expect(() => parseTenantConfig('harish', 'tenant: harish\nactive_brands: []')).toThrow(/active_brands is empty/);
  });

  it('rejects a config with no authors', () => {
    expect(() => parseTenantConfig('harish', 'tenant: harish\nactive_brands: [ABD]')).toThrow(/no authors defined/);
  });

  it('rejects a brand block that is not in active_brands — almost always a typo', () => {
    expect(() =>
      parseTenantConfig(
        'harish',
        `
tenant: harish
active_brands: [ABD]
brands:
  ABD: {}
  CTQ: {}
authors:
  harish: {}
`,
      ),
    ).toThrow(/defines "CTQ" but active_brands does not list it/);
  });

  it('rejects a default_author that is not defined', () => {
    expect(() =>
      parseTenantConfig('harish', `${MINIMAL}\ndefault_author: nobody\n`),
    ).toThrow(/default_author "nobody" is not defined/);
  });

  it('rejects a bundle asset type outside Contract 6', () => {
    expect(() =>
      parseTenantConfig(
        'harish',
        `${MINIMAL}
bundle:
  - asset_type: instagram-reel
    count: 1
`,
      ),
    ).toThrow(/instagram-reel" is not one of/);
  });

  it('rejects a bundle count below 1', () => {
    expect(() =>
      parseTenantConfig('harish', `${MINIMAL}\nbundle:\n  - asset_type: tweet\n    count: 0\n`),
    ).toThrow(/count must be an integer >= 1/);
  });

  it('accepts a custom bundle and reports its size', () => {
    const config = parseTenantConfig(
      'harish',
      `${MINIMAL}
bundle:
  - asset_type: tweet
    count: 3
  - asset_type: linkedin-post
    count: 1
`,
    );
    expect(bundleSize(config)).toBe(4);
  });

  it('rejects invalid YAML with a readable message', () => {
    expect(() => parseTenantConfig('harish', 'tenant: [unclosed')).toThrow(/not valid YAML/);
  });

  it('rejects an empty file', () => {
    expect(() => parseTenantConfig('harish', '')).toThrow(/file is empty/);
  });

  it('keeps unknown keys on `raw` so tenants can carry extra config', () => {
    const config = parseTenantConfig('harish', `${MINIMAL}\nmy_custom_key: hello\n`);
    expect(config.raw.my_custom_key).toBe('hello');
  });
});

describe('lookups', () => {
  const config = parseTenantConfig('harish', MINIMAL);

  it('finds a brand, author and channel', () => {
    expect(getBrand(config, 'ABD').key).toBe('ABD');
    expect(getAuthor(config, 'harish').name).toBe('Harish');
    expect(getChannel(config, 'website-article').key).toBe('website-article');
  });

  it('lists the valid options when a lookup fails', () => {
    expect(() => getBrand(config, 'CTQ')).toThrow(/Active brands: ABD/);
    expect(() => getAuthor(config, 'nobody')).toThrow(/Known authors: harish/);
    expect(() => getChannel(config, 'podcast')).toThrow(/Known channels: website-article/);
  });
});

describe('defaultAnchorToken', () => {
  it('takes the last segment, uppercased', () => {
    expect(defaultAnchorToken('website-article')).toBe('ARTICLE');
    expect(defaultAnchorToken('newsletter')).toBe('NEWSLETTER');
  });

  it('falls back for a key with no usable characters', () => {
    expect(defaultAnchorToken('--')).toBe('ASSET');
  });
});
