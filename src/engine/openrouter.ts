/**
 * OpenRouter client.
 *
 * Per the spec: no retry logic, fail fast. The model is passed in from env
 * (OPENROUTER_MODEL) so it can be swapped without touching code.
 */

export interface OpenrouterOptions {
  temperature?: number;
  maxTokens?: number;
  siteUrl?: string;
  appName?: string;
  /** Ask the model for a JSON object response where the provider supports it. */
  jsonMode?: boolean;
  signal?: AbortSignal;
  /** Override the API base. For a proxy, a gateway, or a local mock in tests. */
  baseUrl?: string;
}

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function endpointFor(baseUrl?: string): string {
  return `${(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
}

export async function callOpenrouter(
  prompt: string,
  systemPrompt: string,
  model: string,
  apiKey: string,
  options: OpenrouterOptions = {},
): Promise<string> {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is empty — cannot call the model.');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  // OpenRouter uses these for dashboard attribution; both are optional.
  if (options.siteUrl) headers['HTTP-Referer'] = options.siteUrl;
  if (options.appName) headers['X-Title'] = options.appName;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: options.temperature ?? 0.7,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  if (options.jsonMode) body.response_format = { type: 'json_object' };

  let response: Response;
  try {
    response = await fetch(endpointFor(options.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new Error(`OpenRouter request failed (network): ${(error as Error).message}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenRouter returned ${response.status} ${response.statusText} for model "${model}".\n${truncate(text, 600)}`,
    );
  }

  let data: OpenrouterResponse;
  try {
    data = JSON.parse(text) as OpenrouterResponse;
  } catch {
    throw new Error(`OpenRouter returned non-JSON body:\n${truncate(text, 600)}`);
  }

  // A 200 can still carry an error payload (e.g. no provider for the model).
  if (data.error) {
    throw new Error(`OpenRouter error for model "${model}": ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `OpenRouter returned an empty completion for model "${model}". ` +
        `finish_reason=${data.choices?.[0]?.finish_reason ?? 'unknown'}`,
    );
  }
  return content;
}

interface OpenrouterResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: { message?: string };
}

/**
 * Call the model and parse the reply as JSON.
 *
 * Models wrap JSON in prose or fences often enough that tolerating it is worth
 * the twelve lines — this is extraction, not retrying, so it stays fail-fast.
 */
export async function callOpenrouterJson<T>(
  prompt: string,
  systemPrompt: string,
  model: string,
  apiKey: string,
  options: OpenrouterOptions = {},
): Promise<T> {
  const raw = await callOpenrouter(prompt, systemPrompt, model, apiKey, { jsonMode: true, ...options });
  return parseJsonReply<T>(raw, model);
}

export function parseJsonReply<T>(raw: string, model = 'model'): T {
  const candidates = [raw.trim(), stripFences(raw), extractBalanced(raw)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next extraction strategy
    }
  }
  throw new Error(
    `Could not parse JSON from ${model}. Response began:\n${truncate(raw, 600)}`,
  );
}

function stripFences(raw: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return match?.[1]?.trim() ?? '';
}

/** First balanced {...} or [...] block, ignoring braces inside strings. */
function extractBalanced(raw: string): string {
  const start = raw.search(/[[{]/);
  if (start === -1) return '';
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return '';
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
