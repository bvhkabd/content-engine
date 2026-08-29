Content Engine — CLI Build Spec for Claude Code

What you're building: A Node.js CLI tool that reads tenant configuration from Google Drive, runs the Content Engine loop, and writes outputs back to Drive + Google Sheet.

Non-negotiables:

Zero tenant-specific facts in the code. Config lives in tenants/{tenant}/tenant.yaml; code reads it at runtime.
Data layer (Google Drive + Sheet) is the source of truth. Code only reads, appends, and writes through the six contracts below.
Stateless: delete the src/ folder, rebuild from this spec, point at the same tenants/ folder — system resumes with zero loss.
Architecture

Three layers (already separated):

tenants/{tenant}/                 ← Data layer (Google Drive)
  tenant.yaml                     ← runtime config
  {section-2-files}               ← audiences, positioning, voice, etc.
  
src/                              ← App layer (this repo)
  engine/                         ← pure functions
  prompts/                        ← all LLM text
  skills/                         ← one session / one skill
  jobs/                           ← headless (SCAN/ID daily)
  
GitHub → runs locally on Mac
The Six Contracts (immutable interfaces)

Copy these exactly:

Contract 1: Spike Record (VAULT sheet row)
Spike-ID | Date | Brand | Author | Source | Source Ref | Topic | Angle | Story/Evidence | Persona | Pillar | Timeliness | Score | Status | Used-In | Notes

Status ∈ {NEW, SHORTLISTED, INTERVIEWED, DRAFTED, USED, PARKED, KILLED}

Contract 2: Interview Transcript
File: interviews/{spike-id}-{author}-{date}.md

---
spike_id: SPIKE-20260815-001
tenant: harish
brand: ABD
author: harish
date: 2026-08-15
schema_version: 1
---

Q: [question]
A: [answer]
...
Contract 3: Draft Artefact
File: drafts/{anchor-id}-v{n}.md

---
anchor_id: ABD-ARTICLE-20260815-001
spike_id: SPIKE-20260815-001
brand: ABD
author: harish
channel: website-article
version: 1
schema_version: 1
---

# [title]

[body]

---
## Working Notes
claim→provenance map (Passage Ref format):
- "claim text" → Interview line 15
chosen CTA: [which CTA from ctas.md]
Contract 4: Critic Report
File: critic-reports/{anchor-id}-v{n}.md

---
anchor_id: ABD-ARTICLE-20260815-001
version: 1
schema_version: 1
---

## Boundary Check
Score: 8.5
Passed: no redline violations, brand correct
Flags: none

## Voice Check
Score: 7.2
Passed: sounds like Harish
Flags: 1. "unlock the potential" — banned phrase (lessons-harish.md)

## Traceability Check
Score: 9.0
Passed: all claims mapped
Flags: none

## Claims Scope Check
Score: 8.1
Passed: no overgeneralizations
Flags: none

---
## Verdict
PASS | REVISE | FAIL-AUTOMATIC
Outstanding criticisms: [quoted text + fix]
Contract 5: EDITIONS Sheet Row (Newsletter send)
Edition | Date-Published | Brand | Author | Topic | Issue-Number | Status | Newsletter-Link | Metrics-30d | Notes
Status ∈ {DRAFT, APPROVED, SENT, LEARNING}
Contract 6: REPURPOSING Sheet Row (Derived assets)
Anchor-ID | Asset-Type | Text | Status | Passage-Ref | Published-Link | Metrics-30d | Notes
Asset-Type ∈ {linkedin-post, x-thread, tweet, podcast-clip, shorts-script}
Status ∈ {PROPOSED, APPROVED, PUBLISHED}
Modules to Build
src/schemas/contracts.ts

TypeScript interfaces for all six contracts + a validation function per contract.

typescript
export interface SpikeRecord {
  spike_id: string;
  date: string;
  brand: string;
  author: string;
  source: string;
  source_ref: string;
  topic: string;
  angle: string;
  story_evidence: string;
  persona: string;
  pillar: string;
  timeliness: string;
  score: number;
  status: 'NEW' | 'SHORTLISTED' | 'INTERVIEWED' | 'DRAFTED' | 'USED' | 'PARKED' | 'KILLED';
  used_in: string;
  notes: string;
}
// ... similar for others
src/engine/

Pure functions, no I/O. Each takes data-layer inputs, outputs contract-valid records.

typescript
// writer.ts
export async function writeArticle(
  interview: InterviewTranscript,
  tenant: TenantConfig,
  spike: SpikeRecord
): Promise<DraftArtefact>

// critic.ts
export async function criticizeArticle(
  draft: DraftArtefact,
  tenant: TenantConfig,
  openrouterApiKey: string
): Promise<CriticReport>

// bundler.ts
export async function bundleAssets(
  draft: DraftArtefact,
  interview: InterviewTranscript,
  tenant: TenantConfig,
  openrouterApiKey: string
): Promise<DerivedAsset[]>  // 7 assets
src/prompts/

All LLM text. Every prompt is a function that takes contract data + config, outputs text.

typescript
// writer.ts
export function systemPrompt(tenant: TenantConfig, brand: string): string {
  return `You are a ghostwriter for ${tenant.authors[author].name}, writing about ${brand}...`
}

export function interviewPrompt(spike: SpikeRecord, tenant: TenantConfig): string {
  return `Interview this author about: ${spike.topic}...`
}

// critic.ts
export function boundaryCheckPrompt(draft: DraftArtefact, brand: BrandConfig): string {
  return `Check this draft against ${brand} redlines...`
}
src/skills/session.ts

One CLI command: orchestrates one full SESSION (interview → write → critic → approve).

typescript
export async function runSession(
  tenant: string,
  spikeId: string,
  authorName: string,
  openrouterApiKey: string,
  googleDriveCredentials: any
): Promise<{ draft: DraftArtefact; criticReport: CriticReport }>

Workflow:

Load tenant config
Load spike from VAULT sheet
Prompt user: "Interview ready? (y/n)"
Read interview transcript from interviews/{spike_id}-* folder
Call writer.ts → generate draft
Call critic.ts → generate 4 checks
Write draft + critic-report to folders
Display critic report to user
Prompt: "Approve? (yes/revise/reject)"
If approve: update spike status to DRAFTED, return
If revise: loop to user edit + re-critique (max 3 cycles)
If reject: mark KILLED, return
Call bundler.ts → generate 7 derived assets
Write all to REPURPOSING sheet (status: PROPOSED)
Update EDITIONS sheet (status: DRAFT)
src/jobs/oracle.ts (Headless)

Runs daily. SCAN + ID only.

typescript
export async function dailyOracle(
  tenant: string,
  googleSheetId: string,
  googleDriveCredentials: any
): Promise<number>  // returns count of new spikes

Workflow:

Load tenant config
Call sources/subscriptions-inbox.ts → fetch new emails labeled #Postideas
Call sources/transcripts.ts → check transcripts-in/ folder for new files
Call sources/dossiers.ts → scan dossier folder for client mentions
For each source item, extract: topic, angle, evidence snippet
Score against seasonality + existing topics
Generate top 6 by timeliness
Append new spikes to VAULT sheet with status=NEW
Log summary to logs/oracle-{date}.log
Email you: "Oracle found 3 new spikes, top 6 refreshed"
src/jobs/watchdog.ts (Headless)

Runs daily. Checks that all scheduled jobs are healthy.

typescript
export async function watchdog(
  tenant: string,
  yourEmail: string
): Promise<void>

Workflow:

Check logs/ folder for today's oracle + esp-sync heartbeats
If missing: email you "Daily oracle did not run"
Check EDITIONS sheet for any stuck in DRAFT > 2 days: email you "Stale draft needs approval"
src/sources/

Readers that fetch source data, return typed results. No filtering, no scoring — oracle does that.

typescript
// subscriptions-inbox.ts
export async function fetchPostIdeasEmails(
  email: string,
  appPassword: string
): Promise<{ subject: string; body: string; from: string }[]>

// transcripts.ts
export async function fetchTranscriptsFolder(
  folderId: string,
  credentials: any
): Promise<{ filename: string; content: string }[]>

// dossiers.ts
export async function fetchDossierMentions(
  folderId: string,
  credentials: any
): Promise<{ docName: string; mentions: string[] }[]>
src/skills/topics.ts (UI / manual trigger)

Displays top 6 spikes from VAULT sheet.

typescript
export async function showTopics(
  tenant: string,
  googleSheetId: string
): Promise<void>

Output:

🔥 Top 6 This Week

1. [Topic] — ABD
   Angle: [angle]
   Why now: [timeliness]
   Persona: [persona]
   👍 Add to Interview Queue

2. ...
CLI Interface
bash
# Set up
npx content-engine init --tenant harish --sheet-id XXX

# Run a session (you've read Wispr transcript, now write)
npx content-engine session --tenant harish --spike SPIKE-20260815-001

# Show current top 6 topics
npx content-engine topics --tenant harish

# Approve a draft + generate bundle
npx content-engine approve --tenant harish --draft ABD-ARTICLE-20260815-001

# Run oracle once (manual trigger)
npx content-engine oracle --tenant harish

# Run watchdog once (manual trigger)
npx content-engine watchdog --tenant harish
Openrouter Integration
typescript
// src/engine/openrouter.ts
export async function callOpenrouter(
  prompt: string,
  systemPrompt: string,
  model: string = "openrouter/auto",  // swap via env var
  apiKey: string
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    }),
  });
  
  const data = await response.json();
  return data.choices[0].message.content;
}

Pass model from env: OPENROUTER_MODEL=anthropic/claude-opus → swap instantly.

Google Drive / Sheets Integration
typescript
// src/io/google-drive.ts
export async function readTenantFile(
  path: string,  // e.g., "tenants/harish/tenant.yaml"
  credentials: any
): Promise<string>

export async function writeTenantFile(
  path: string,
  content: string,
  credentials: any
): Promise<void>

// src/io/google-sheets.ts
export async function appendVaultRow(
  sheetId: string,
  spike: SpikeRecord,
  credentials: any
): Promise<void>

export async function updateVaultRow(
  sheetId: string,
  spikeId: string,
  updates: Partial<SpikeRecord>,
  credentials: any
): Promise<void>

export async function readVault(
  sheetId: string,
  credentials: any
): Promise<SpikeRecord[]>
Setup Instructions for the Developer (Claude Code)
Create repo structure per the folder tree above.
Write TypeScript, ESM imports. Use tsx for running scripts locally.
All prompts as files in src/prompts/, not hardcoded.
No credentials in code. Load from env vars:
OPENROUTER_API_KEY
GOOGLE_CREDENTIALS_JSON (service account JSON for Drive/Sheets, or user OAuth token)
GMAIL_APP_PASSWORD
FIREFLIES_API_KEY (if used)
package.json scripts:
json
   {
     "scripts": {
       "session": "tsx src/skills/session.ts",
       "topics": "tsx src/skills/topics.ts",
       "oracle": "tsx src/jobs/oracle.ts",
       "watchdog": "tsx src/jobs/watchdog.ts"
     }
   }
Logging: All I/O goes to tenants/{tenant}/logs/ with timestamp + run ID.
Error handling: If Drive read fails, exit with clear error. If critic fails on a draft, save partial + report the failure.
No retry logic for LLM calls yet; fail fast.
Validation Gates (Phase 1)

Before pushing:

✅ npx content-engine init creates tenants/test/ with all Section 3 templates.
✅ Dummy second tenant: create tenants/dummy/, run npx content-engine topics --tenant dummy — reads from Drive folder, returns empty (no spikes yet).
✅ Rebuild test: rm -rf src/, re-clone the repo, recreate from this spec alone, point at tenants/harish/ — same CLI runs with zero changes.
✅ All six contracts have TypeScript validation + unit tests.
README.md (to include in repo)
markdown
# Content Engine

Multi-tenant content orchestration: interview → write → critic → bundle.

## Setup

1. **Clone repo**
```bash
   git clone https://github.com/[you]/content-engine.git
   cd content-engine
```

2. **Install**
```bash
   npm install
```

3. **Credentials** (create `.env`)

OPENROUTER_API_KEY=sk-...
GOOGLE_CREDENTIALS_JSON=/path/to/service-account.json
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx


4. **Initialize tenant** (one-time)
```bash
   npx content-engine init --tenant harish --sheet-id [your-sheet-id]
```

## Usage

### Show top 6 topics
```bash
npx content-engine topics --tenant harish
```

### Run a session (after Wispr interview)
```bash
npx content-engine session --tenant harish --spike SPIKE-20260815-001
```

### Approve draft + generate bundle
```bash
npx content-engine approve --tenant harish --draft ABD-ARTICLE-20260815-001
```

## Architecture

- `src/engine/` — pure functions (write, critic, bundle)
- `src/prompts/` — all LLM text
- `src/jobs/` — headless (oracle, watchdog)
- `tenants/` — data layer (Google Drive, never committed)

## Data Layer

All state lives in `tenants/{tenant}/`:
- `tenant.yaml` — config
- `interviews/` — transcripts
- `drafts/` — articles
- `critic-reports/` — reviews
- Google Sheet (VAULT, EDITIONS, REPURPOSING tabs)
