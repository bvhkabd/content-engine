/**
 * Scaffolding written by `content-engine init`.
 *
 * These are empty frames with instructions, not content. Nothing here is a
 * fact about any tenant — the operator fills them in, and from then on the
 * data layer owns them.
 */

export interface ScaffoldOptions {
  tenant: string;
  brands: string[];
  author: string;
  authorName: string;
  sheetId: string;
  driveFolderId: string;
  inboxEmail: string;
}

export function tenantYaml(o: ScaffoldOptions): string {
  const brandBlocks = o.brands
    .map((brand) => {
      const slug = brand.toLowerCase();
      return `  ${brand}:
    name: "${brand}"                       # full display name
    prefix: "${brand.toUpperCase()}"                     # anchor ID prefix: ${brand.toUpperCase()}-ARTICLE-20260815-001
    voice_file: "voice-${slug}.md"
    redlines_file: "redlines-${slug}.md"
    positioning_file: "positioning-${slug}.md"
    audiences_file: "audiences-${slug}.md"
    ctas_file: "ctas-${slug}.md"
    redline_lessons_file: "redline-lessons-${slug}.md"
    pillars: []                            # e.g. ["operating model", "org design"]`;
    })
    .join('\n\n');

  return `# Content Engine — tenant config
# Owned by the data layer. Edit here, not in code.
# Never put secrets in this file; credentials come from .env.

tenant: ${o.tenant}

active_brands:
${o.brands.map((b) => `  - ${b}`).join('\n')}

brands:
${brandBlocks}

authors:
  ${o.author}:
    name: "${o.authorName}"
    email: ""                              # used for watchdog + oracle notifications
    timezone: "Asia/Kolkata"
    lessons_file: "lessons-${o.author}.md"

default_author: ${o.author}

channels:
  website-article:
    name: "Website article"
    target_words: 1200
    anchor_token: "ARTICLE"                # middle segment of the anchor ID
    structure_notes: ""                    # free text handed to the writer prompt
  newsletter:
    name: "Newsletter"
    target_words: 800
    anchor_token: "NEWSLETTER"
    structure_notes: ""

default_channel: website-article

sheet:
  id: "${o.sheetId}"
  credentials_ref: "gsheets_service_account"

drive:
  root_folder_id: "${o.driveFolderId}"     # only used when STORAGE_BACKEND=google

sources:
  subscriptions_inbox:
    enabled: ${o.inboxEmail ? 'true' : 'false'}
    email: "${o.inboxEmail}"
    label: "#Postideas"                    # Gmail label the oracle reads

  transcripts:
    enabled: true
    type: "manual_export"                  # "manual_export" | "fireflies"
    folder_id: ""                          # Fireflies only

  dossiers:
    enabled: true
    folder_id: "dossiers"                  # folder name inside this tenant
    keywords: []                           # empty = feed whole documents to the oracle

esp:
  type: "kit"
  api_key_ref: "kit_api_key"
  list_id: ""

seasonality_file: "seasonal.yaml"

# Derived-asset bundle produced after a draft is approved. Counts sum to the
# bundle size (7 by default). Asset types must be Contract 6 types.
bundle:
  - asset_type: linkedin-post
    count: 2
    notes: "One narrative, one contrarian"
  - asset_type: x-thread
    count: 1
    notes: "5-8 posts"
  - asset_type: tweet
    count: 2
    notes: "Standalone, quotable"
  - asset_type: podcast-clip
    count: 1
    notes: "60-90s talking point"
  - asset_type: shorts-script
    count: 1
    notes: "30-45s vertical video"

critic:
  pass_score: 8                            # every check must reach this for a PASS
  boundary_fail_score: 6                   # below this on boundary = FAIL-AUTOMATIC
  max_revise_cycles: 3

oracle:
  top_n: 6
  stale_draft_days: 2                      # watchdog alerts on drafts older than this
`;
}

export function voiceTemplate(brand: string): string {
  return `# Voice — ${brand}

Read by: writer, critic (Voice Check).

## How this brand sounds
<!-- Three to five sentences. Describe the register, not the topic. -->

## Sentence rhythm
<!-- Long and winding, or short and blunt? Where do you break the pattern? -->

## Words and phrases we use
-

## Banned phrases
<!-- The critic flags every one of these. Be specific and literal. -->
- unlock the potential
- in today's fast-paced world
- it's not just X, it's Y
- game-changer
- delve

## Person and tense
<!-- First person singular? "We"? Present tense? -->

## Worked example
<!-- Paste 200-300 words of real writing that sounds exactly right.
     This does more work than every rule above combined. -->
`;
}

export function redlinesTemplate(brand: string): string {
  return `# Redlines — ${brand}

Read by: critic (Boundary Check). Any violation scores 5 or below and returns
FAIL-AUTOMATIC — no revision cycle.

## Never claim
-

## Never name
<!-- Clients, employers, individuals who have not consented to be written about. -->
-

## Never take a position on
-

## Legal and compliance
<!-- Regulated claims, disclaimers that must appear, anything with contractual risk. -->
-

## Confidentiality
<!-- What from client work may be used, and how anonymised it must be. -->
-
`;
}

export function positioningTemplate(brand: string): string {
  return `# Positioning — ${brand}

Read by: writer, critic (Boundary Check, Claims Scope Check).

## One-line positioning
<!-- What this brand is, for whom, and why it is different. -->

## What we believe that others do not
-

## What we are explicitly not
-

## Proof we are entitled to make these claims
<!-- Track record, credentials, data. The critic checks claims against this. -->
-

## Adjacent territory we stay out of
-
`;
}

export function audiencesTemplate(brand: string): string {
  return `# Audiences — ${brand}

Read by: writer, oracle. Personas named here are what the Persona column uses.

## Persona: <name>
- Role and seniority:
- What keeps them up at night:
- What they already know (do not explain this to them):
- What they are sceptical of:
- What would make them share this:
- Where they read:

<!-- Copy the block above for each persona. Two or three is plenty. -->
`;
}

export function ctasTemplate(brand: string): string {
  return `# CTAs — ${brand}

Read by: writer, bundler. The writer picks exactly one per draft and quotes it
verbatim; the chosen CTA is recorded in the draft's Working Notes.

## Low commitment
-

## Medium commitment
-

## High commitment
-

## Never use
-
`;
}

export function redlineLessonsTemplate(brand: string): string {
  return `# Redline rulings — ${brand}

Read by: oracle (boundary flagging), critic (Boundary Check).

\`redlines-${brand.toLowerCase()}.md\` states the policy. This file is the case law:
actual calls made on real spikes, with reasons. **Where the two disagree, this
file wins** — a ruling on a real example beats a general principle.

Record one whenever a boundary call comes out wrong in either direction:

\`\`\`
npm run cli -- classify --tenant <t> --spike SPIKE-... --allow "why this is fine"
npm run cli -- classify --tenant <t> --spike SPIKE-... --block "why this is not"
\`\`\`

Empty is a normal starting state.

---
`;
}

export function lessonsTemplate(authorName: string, authorKey: string): string {
  return `# Lessons — ${authorName}

Read by: writer, critic (Voice Check). Treated as binding and as overriding
general voice guidance.

This file is the memory of the system. Every time you correct a draft for the
same reason twice, write the rule here. Keep entries short and literal.

## Format

### YYYY-MM-DD — <short rule>
What went wrong:
The rule:

<!-- Example:

### 2026-08-15 — no rhetorical questions as section openers
What went wrong: three sections in a row opened with "But what if...?"
The rule: open sections with a statement or a concrete detail, never a question.

-->
`;
}

export function seasonalTemplate(): string {
  return `# Seasonality — what is timely, and when
#
# Read by: oracle. A candidate spike whose topic or angle contains one of these
# keywords during its window gets a scoring bonus.
#
# windows:
#   - name: "Annual planning"
#     months: [10, 11, 12]
#     keywords: ["planning", "budget", "headcount", "operating plan"]

windows: []
`;
}

export function tenantReadme(o: ScaffoldOptions): string {
  return `# ${o.tenant} — data layer

This folder is the source of truth for the ${o.tenant} tenant. The code in
src/ reads it at runtime and holds no facts about ${o.tenant} itself.

## Fill these in before your first session

| File | Read by | Purpose |
| --- | --- | --- |
| \`tenant.yaml\` | everything | Runtime config: brands, authors, channels, bundle |
${o.brands
  .map((b) => {
    const s = b.toLowerCase();
    return `| \`voice-${s}.md\` | writer, critic | How ${b} sounds; banned phrases |
| \`redlines-${s}.md\` | critic | Hard boundaries; violations fail automatically |
| \`positioning-${s}.md\` | writer, critic | What ${b} claims and is entitled to claim |
| \`audiences-${s}.md\` | writer, oracle | Personas |
| \`ctas-${s}.md\` | writer, bundler | The CTA menu |`;
  })
  .join('\n')}
| \`lessons-${o.author}.md\` | writer, critic | Accumulated corrections; overrides voice |
| \`seasonal.yaml\` | oracle | Timeliness windows |

## Folders

| Folder | Contents |
| --- | --- |
| \`interviews/\` | Contract 2 transcripts — \`{spike-id}-{author}-{date}.md\` |
| \`drafts/\` | Contract 3 drafts — \`{anchor-id}-v{n}.md\` |
| \`critic-reports/\` | Contract 4 reports — \`{anchor-id}-v{n}.md\` |
| \`transcripts-in/\` | Drop raw meeting/dictation transcripts here for the oracle |
| \`dossiers/\` | Client and prospect documents the oracle scans |
| \`logs/\` | One log per job per day; the watchdog reads these as heartbeats |
| \`sheets/\` | VAULT / EDITIONS / REPURPOSING as CSV (local backend only) |

## Notes

- Never commit this folder. The repo's .gitignore already excludes \`tenants/\`.
- No secrets in \`tenant.yaml\`. Credentials live in \`.env\`.
`;
}

/** Everything init writes, as path-relative-to-tenant -> contents. */
export function scaffoldFiles(o: ScaffoldOptions): Record<string, string> {
  const files: Record<string, string> = {
    'tenant.yaml': tenantYaml(o),
    'README.md': tenantReadme(o),
    'seasonal.yaml': seasonalTemplate(),
    [`lessons-${o.author}.md`]: lessonsTemplate(o.authorName, o.author),
  };
  for (const brand of o.brands) {
    const slug = brand.toLowerCase();
    files[`voice-${slug}.md`] = voiceTemplate(brand);
    files[`redlines-${slug}.md`] = redlinesTemplate(brand);
    files[`positioning-${slug}.md`] = positioningTemplate(brand);
    files[`audiences-${slug}.md`] = audiencesTemplate(brand);
    files[`ctas-${slug}.md`] = ctasTemplate(brand);
    files[`redline-lessons-${slug}.md`] = redlineLessonsTemplate(brand);
  }
  return files;
}
