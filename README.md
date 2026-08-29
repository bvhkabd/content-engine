# Content Engine

Multi-tenant content orchestration: **interview → write → critic → bundle**.

Reads tenant config from the data layer (Google Drive or a local mirror), runs
the loop, and writes drafts, critic reports and derived assets back to Drive +
a Google Sheet.

---

## Quick start (no credentials needed)

You can run the whole system locally with the filesystem backend before you set
up any Google access.

```bash
git clone https://github.com/bvhkabd/content-engine.git
cd content-engine
npm install
cp .env.example .env          # defaults to STORAGE_BACKEND=local
```

Add one line to `.env` — an OpenRouter key is the only thing you truly need:

```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

Then:

```bash
npm run cli -- init --tenant harish --brands ABD,CTQ,HARISH
npm run cli -- doctor --tenant harish
```

`init` scaffolds `tenants/harish/` with every reference file as a template, and
creates the three sheet tabs as CSVs. `doctor` tells you what is still missing.

---

## Credentials

Everything lives in `.env` (gitignored). Nothing is ever read from a tenant file.

| Variable | Required? | What it is | Where to get it |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | **Yes** | Powers writer, critic, bundler, oracle | [openrouter.ai/keys](https://openrouter.ai/keys) |
| `OPENROUTER_MODEL` | No | Model to use. Swap without touching code | e.g. `anthropic/claude-opus-4.1` |
| `STORAGE_BACKEND` | No | `local` (default) or `google` | — |
| `GOOGLE_CREDENTIALS_JSON` | Only for `google` | Service-account JSON, path **or** raw JSON | See below |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Only for `google` | Drive folder holding the tenants tree | Folder URL, after `/folders/` |
| `GMAIL_APP_PASSWORD` | Only for the inbox source | Reads the `#Postideas` label over IMAP | Google Account → Security → 2-Step Verification → App passwords |
| `FIREFLIES_API_KEY` | Only for Fireflies | Pulls meeting transcripts | Fireflies → Settings → Developer |
| `NOTIFY_SMTP_*`, `NOTIFY_TO` | No | Oracle/watchdog email. Falls back to console | Your SMTP provider |

### Setting up Google (when you're ready)

1. Google Cloud Console → new project → enable the **Drive API** and **Sheets API**.
2. IAM → Service Accounts → create one → Keys → **Add key → JSON**. Save the file.
3. Point `GOOGLE_CREDENTIALS_JSON` at that file.
4. **Share both the Drive folder and the Sheet with the service-account email**
   (it looks like `name@project.iam.gserviceaccount.com`) as **Editor**.
   This step is the one everyone forgets — a 404 or 403 from any command is
   almost always this.
5. Set `STORAGE_BACKEND=google` and `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

Run `npm run cli -- doctor --tenant harish` to confirm the wiring.

---

## Triggering a session manually

The core loop. You have a spike, you've recorded an interview, now you write.

```bash
# 1. What should I write about?
npm run cli -- topics --tenant harish

# 2. Don't have the interview questions yet? Generate them.
#    Writes a question-only transcript stub into interviews/.
npm run cli -- session --tenant harish --spike SPIKE-20260815-001 --guide

# 3. Answer the questions in that file (Wispr, typing, whatever).
#    Add an `A:` line under each `Q:` line.

# 4. Run the session.
npm run cli -- session --tenant harish --spike SPIKE-20260815-001
```

Step 4 walks the loop: reads the transcript, writes a draft, runs four critic
checks, shows you the report, and asks **Approve? [yes/revise/reject]**.

- `yes` → spike goes to `DRAFTED`, then it generates the 7-asset bundle.
- `revise` → you can add notes; it rewrites and re-critiques (up to 3 cycles).
- `reject` → spike goes to `KILLED`. The draft is kept on disk regardless.

Useful flags:

```bash
--yes            # unattended: accept a PASS, auto-revise otherwise
--no-bundle      # approve without generating assets; bundle later
--brand CTQ      # override the brand on the spike row
--channel newsletter
--version 2      # (approve only) pick a specific draft version
```

Approve a draft you edited by hand, or one from an earlier `--no-bundle` run:

```bash
npm run cli -- approve --tenant harish --draft ABD-ARTICLE-20260815-001
```

### The headless jobs

```bash
npm run cli -- oracle   --tenant harish   # scan sources, append new spikes
npm run cli -- oracle   --tenant harish --dry-run   # score without writing
npm run cli -- watchdog --tenant harish   # check heartbeats + stalled work
```

`watchdog` exits non-zero when it finds problems, so cron and CI can see it.
To schedule both daily:

```cron
0 6 * * *  cd /path/to/content-engine && npm run cli -- oracle   --tenant harish
0 7 * * *  cd /path/to/content-engine && npm run cli -- watchdog --tenant harish
```

---

## Multiple tenants

Nothing about any tenant is in the code. Adding one is one command:

```bash
npm run cli -- init --tenant sirisha --brands SIRISHA --author sirisha
npm run cli -- init --tenant ctq     --brands CTQ     --author sirisha
```

Every command takes `--tenant`, and they share nothing but the binary. Each
tenant has its own brands, voice, redlines, CTAs, bundle composition, critic
thresholds and sheet.

---

## Iterating on prompts and style

Two separate dials, and it matters which one you reach for.

**Tenant voice — edit the data layer, no code, no restart.** These are read
fresh on every run:

| File | Read by | Effect |
| --- | --- | --- |
| `voice-{brand}.md` | writer, critic | How it sounds. Banned-phrase list lives here |
| `redlines-{brand}.md` | critic | Hard boundaries. A violation is `FAIL-AUTOMATIC` |
| `positioning-{brand}.md` | writer, critic | What the brand may claim |
| `audiences-{brand}.md` | writer, oracle | Personas |
| `ctas-{brand}.md` | writer, bundler | The CTA menu |
| `lessons-{author}.md` | writer, critic | **Accumulated corrections. Overrides voice guidance.** |

`lessons-{author}.md` is the memory of the system. Every time you correct a
draft for the same reason twice, write the rule there.

**Prompt mechanics — edit `src/prompts/`.** All LLM text lives in that folder
and nowhere else: `writer.ts`, `critic.ts`, `bundler.ts`, `oracle.ts`.

Tuning knobs in `tenant.yaml` that need no code change:

```yaml
critic:
  pass_score: 8            # every check must reach this for a PASS
  boundary_fail_score: 6   # below this on boundary = FAIL-AUTOMATIC
  max_revise_cycles: 3

bundle:                    # what the 7-asset bundle is made of
  - asset_type: linkedin-post
    count: 2
    notes: "One narrative, one contrarian"
```

Swap models per run without editing anything:

```bash
OPENROUTER_MODEL=anthropic/claude-opus-4.1 npm run cli -- session --tenant harish --spike SPIKE-...
```

---

## Architecture

Three layers, strictly separated.

```
tenants/{tenant}/        ← Data layer (Google Drive). Never committed.
  tenant.yaml            ← runtime config
  voice-*.md, redlines-*.md, ctas-*.md, ...
  interviews/            ← Contract 2
  drafts/                ← Contract 3
  critic-reports/        ← Contract 4
  transcripts-in/, dossiers/, logs/, sheets/

src/                     ← App layer (this repo)
  schemas/               ← the six contracts + validators
  engine/                ← writer, critic, bundler, scoring (LLM injected, no I/O)
  prompts/               ← all LLM text
  skills/                ← interactive: session, topics, approve, init, doctor
  jobs/                  ← headless: oracle, watchdog
  sources/               ← inbox, transcripts, dossiers
  io/                    ← storage + sheet adapters, logging, notify
```

**The data layer is the source of truth.** Delete `src/`, rebuild from
`CLAUDE_CODE_BRIEF.md`, point at the same `tenants/` folder, and the system
resumes with zero loss.

### Storage backends

One interface, two implementations, chosen by `STORAGE_BACKEND`:

- `local` — filesystem + CSV files as the sheet. No Google auth. Use this for
  first runs, prompt iteration and tests.
- `google` — Drive folder + real Google Sheet.

Identical path layout and identical column order, so a CSV written locally
imports straight into the Sheet. Nothing above `src/io/` knows which is active.

### The six contracts

Defined once in `src/schemas/contracts.ts`, each with a validator:

| # | Contract | Lives as |
| --- | --- | --- |
| 1 | `SpikeRecord` | VAULT sheet row |
| 2 | `InterviewTranscript` | `interviews/{spike-id}-{author}-{date}.md` |
| 3 | `DraftArtefact` | `drafts/{anchor-id}-v{n}.md` |
| 4 | `CriticReport` | `critic-reports/{anchor-id}-v{n}.md` |
| 5 | `EditionRecord` | EDITIONS sheet row |
| 6 | `DerivedAsset` | REPURPOSING sheet row |

Sheet column order is driven by the same arrays the interfaces use, so the
on-disk layout and the types cannot drift apart.

### Critic verdicts are deterministic

The model scores each of the four checks; it does not decide the outcome.
`decideVerdict()` is a pure function:

- **`FAIL-AUTOMATIC`** — boundary below `boundary_fail_score`. A redline breach
  never goes to a revision cycle.
- **`PASS`** — every check at or above `pass_score`, and zero flags.
- **`REVISE`** — anything else.

An unparseable score is treated as `0`, never as a pass.

---

## Development

```bash
npm test           # 306 unit tests, no network
npm run typecheck  # tsc --noEmit
npm run test:watch
```

Tests cover all six contract validators, markdown round-trips, CSV encoding,
the sheet adapters, ID generation, scoring, verdict logic, and the
writer/critic/bundler driven by a stub LLM.

To exercise the loop without spending tokens, point the client at a local mock:

```bash
OPENROUTER_BASE_URL=http://127.0.0.1:8899/v1
```

### Error handling

Deliberate choices, per the spec:

- **No retries on LLM calls.** Fail fast, surface the error.
- **A failed critic still saves the draft** and reports the failure.
- **One dead source does not kill the oracle** — it logs and continues.
- **Notification failures never fail the job** that already succeeded.
- Drive read failures exit with a message naming the likely cause.

Set `DEBUG=1` for stack traces.

---

## Command reference

| Command | What it does |
| --- | --- |
| `init --tenant X [--sheet-id ID] [--brands A,B]` | Scaffold a tenant. Idempotent |
| `doctor --tenant X` | Check credentials, config, sheet. No LLM calls |
| `topics --tenant X [--limit N] [--brand B] [--json]` | Top spikes from VAULT |
| `session --tenant X --spike ID [--guide] [--yes] [--no-bundle]` | The full loop |
| `approve --tenant X --draft ANCHOR-ID [--version N]` | Approve + bundle |
| `oracle --tenant X [--dry-run] [--since-days N]` | Scan sources, append spikes |
| `watchdog --tenant X [--email A]` | Heartbeats + stalled work. Non-zero on problems |
