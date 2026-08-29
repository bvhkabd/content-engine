/**
 * Thin LLM seam.
 *
 * The engine depends on this interface rather than on OpenRouter directly, so
 * writer/critic/bundler can be unit-tested with a stub and no network.
 */

import type { Env } from '../config/env.js';
import { requireEnv } from '../config/env.js';
import { callOpenrouter, parseJsonReply, type OpenrouterOptions } from './openrouter.js';

export interface LlmClient {
  readonly model: string;
  complete(prompt: string, systemPrompt: string, options?: OpenrouterOptions): Promise<string>;
  json<T>(prompt: string, systemPrompt: string, options?: OpenrouterOptions): Promise<T>;
}

export function createLlmClient(env: Env, purpose: string): LlmClient {
  const apiKey = requireEnv(env, 'openrouterApiKey', purpose);
  const model = env.openrouterModel;
  const base: OpenrouterOptions = {
    ...(env.openrouterSiteUrl ? { siteUrl: env.openrouterSiteUrl } : {}),
    ...(env.openrouterBaseUrl ? { baseUrl: env.openrouterBaseUrl } : {}),
    appName: env.openrouterAppName,
  };

  return {
    model,
    complete: (prompt, systemPrompt, options = {}) =>
      callOpenrouter(prompt, systemPrompt, model, apiKey, { ...base, ...options }),
    async json<T>(prompt: string, systemPrompt: string, options: OpenrouterOptions = {}): Promise<T> {
      const raw = await callOpenrouter(prompt, systemPrompt, model, apiKey, {
        ...base,
        jsonMode: true,
        ...options,
      });
      return parseJsonReply<T>(raw, model);
    },
  };
}
