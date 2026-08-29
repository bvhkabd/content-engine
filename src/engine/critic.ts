/**
 * Critic — four independent checks, then a deterministic verdict.
 *
 * The model scores; it does not decide. Verdict is computed from the scores and
 * flags by `decideVerdict`, which is pure and unit-tested, so "what counts as a
 * pass" is a config decision rather than a mood.
 */

import {
  CRITIC_CHECKS,
  SCHEMA_VERSION,
  assertValid,
  validateCriticReport,
  type CriticCheck,
  type CriticCheckName,
  type CriticReport,
  type CriticVerdict,
  type DraftArtefact,
  type InterviewTranscript,
} from '../schemas/contracts.js';
import type { BrandContext, CriticThresholds, TenantConfig } from '../config/tenant.js';
import { CHECK_PROMPT_BUILDERS, criticSystemPrompt } from '../prompts/critic.js';
import type { LlmClient } from './llm.js';

interface CheckPayload {
  score?: unknown;
  passed?: unknown;
  flags?: unknown;
}

/**
 * Run all four checks. Signature follows CLAUDE_CODE_BRIEF.md § src/engine,
 * with the LLM client injected in place of a raw API key.
 */
export async function criticizeArticle(
  draft: DraftArtefact,
  tenant: TenantConfig,
  interview: InterviewTranscript,
  ctx: BrandContext,
  llm: LlmClient,
): Promise<CriticReport> {
  const system = criticSystemPrompt(ctx);

  // Independent checks; run them concurrently.
  const results = await Promise.all(
    CRITIC_CHECKS.map(async (name): Promise<CriticCheck> => {
      const prompt = CHECK_PROMPT_BUILDERS[name](draft, ctx, interview);
      const payload = await llm.json<CheckPayload>(prompt, system, { temperature: 0.2 });
      return normaliseCheck(name, payload);
    }),
  );

  const report: CriticReport = {
    anchor_id: draft.anchor_id,
    version: draft.version,
    schema_version: SCHEMA_VERSION,
    checks: results,
    verdict: decideVerdict(results, tenant.critic),
    outstanding_criticisms: collectOutstanding(results),
  };

  assertValid(validateCriticReport(report), `Critic report ${draft.anchor_id} v${draft.version}`);
  return report;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Verdict rules:
 *   FAIL-AUTOMATIC — boundary check below the fail threshold. A redline breach
 *                    is not something a revision cycle should paper over.
 *   PASS           — every check at or above pass_score, and zero flags.
 *   REVISE         — anything else.
 */
export function decideVerdict(checks: readonly CriticCheck[], thresholds: CriticThresholds): CriticVerdict {
  const boundary = checks.find((c) => c.name === 'boundary');
  if (boundary && boundary.score < thresholds.boundary_fail_score) return 'FAIL-AUTOMATIC';

  const allPassed = checks.every((c) => c.score >= thresholds.pass_score);
  const noFlags = checks.every((c) => c.flags.length === 0);
  return allPassed && noFlags ? 'PASS' : 'REVISE';
}

function collectOutstanding(checks: readonly CriticCheck[]): string[] {
  return checks.flatMap((c) => c.flags.map((flag) => `[${c.name}] ${flag}`));
}

function normaliseCheck(name: CriticCheckName, payload: CheckPayload): CriticCheck {
  return {
    name,
    score: clampScore(payload.score),
    passed: String(payload.passed ?? '').trim() || '(no summary returned)',
    flags: normaliseFlags(payload.flags),
  };
}

function clampScore(value: unknown): number {
  const n = Number(value);
  // An unparseable score must not read as a pass.
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function normaliseFlags(value: unknown): string[] {
  if (typeof value === 'string') {
    const text = value.trim();
    return !text || /^none$/i.test(text) ? [] : [text];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((flag) => (typeof flag === 'string' ? flag : JSON.stringify(flag)))
    .map((flag) => flag.trim())
    .filter((flag) => flag !== '' && !/^none$/i.test(flag));
}
