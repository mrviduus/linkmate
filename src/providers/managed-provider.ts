/**
 * Managed provider — LinkMate's hosted free tier.
 *
 * Calls the LinkMate proxy (a Cloudflare Worker, see /proxy) instead of OpenAI
 * directly. The proxy holds the real OpenAI key and enforces a per-install $2
 * spend quota, so the user needs no API key of their own. Authentication is an
 * anonymous install UUID sent as a bearer token — never a real API key.
 *
 * Wire format is OpenAI-compatible, so this is OpenAIProvider with two changes:
 *   - baseUrl defaults to the proxy, not api.openai.com
 *   - the bearer credential is the install token, not an `sk-...` key
 *
 * When the proxy reports the quota is spent it returns HTTP 402; we surface that
 * as a typed QuotaExceededError so callers/UI can prompt the user to switch to
 * their own key (BYOK) instead of string-matching an error message.
 */

import type { InferenceParams, InferenceProvider } from './inference-provider';

/** Default proxy origin. Override per-config if needed. */
export const MANAGED_BASE_URL = 'https://linkmate-proxy.linkmate.workers.dev';

export interface ManagedConfig {
  /** Anonymous install token (UUID). Never a real API key. */
  installToken: string;
  /** Model id; must be allowed by the proxy whitelist (e.g. "gpt-4o-mini"). */
  model: string;
  /** Override proxy base URL. Defaults to MANAGED_BASE_URL. */
  baseUrl?: string;
}

/** Thrown when the managed free tier is exhausted (proxy HTTP 402). */
export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded';
  readonly usedUSD?: number;
  readonly limitUSD?: number;
  constructor(message: string, usedUSD?: number, limitUSD?: number) {
    super(message);
    this.name = 'QuotaExceededError';
    this.usedUSD = usedUSD;
    this.limitUSD = limitUSD;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; code?: string; usedUSD?: number; limitUSD?: number };
}

export class ManagedProvider implements InferenceProvider {
  readonly name: string;
  readonly isCloud = true;
  private readonly cfg: ManagedConfig;
  /** Test hook — when undefined we resolve global fetch at generate() time. */
  private readonly fetchImpl?: typeof fetch;

  constructor(cfg: ManagedConfig, fetchImpl?: typeof fetch) {
    if (!cfg.installToken) {
      throw new Error('ManagedProvider requires an install token');
    }
    if (!cfg.model) {
      throw new Error('ManagedProvider requires a model id');
    }
    this.cfg = cfg;
    this.name = `LinkMate (${cfg.model})`;
    this.fetchImpl = fetchImpl;
  }

  async generate(params: InferenceParams): Promise<string> {
    const doFetch = this.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) {
      throw new Error('No fetch available in this runtime');
    }
    const baseUrl = this.cfg.baseUrl ?? MANAGED_BASE_URL;
    const url = `${baseUrl}/v1/chat/completions`;

    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      max_tokens: params.maxTokens ?? 150,
      temperature: params.temperature ?? 0.85,
      top_p: params.topP ?? 0.9,
      stop: params.stop,
    };

    const timeoutMs = params.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Bearer is the anonymous install token, NOT an API key. Never logged.
          Authorization: `Bearer ${this.cfg.installToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`LinkMate request timed out after ${timeoutMs / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      let parsed: ChatCompletionResponse | null = null;
      try {
        parsed = (await res.json()) as ChatCompletionResponse;
      } catch {
        // Body not JSON — handled below via status line.
      }
      if (res.status === 402 || parsed?.error?.code === 'quota_exceeded') {
        throw new QuotaExceededError(
          parsed?.error?.message ??
            'Your free AI allowance is used up. Add your own OpenAI key for unlimited use.',
          parsed?.error?.usedUSD,
          parsed?.error?.limitUSD,
        );
      }
      const errMsg = parsed?.error?.message
        ? `${res.status}: ${parsed.error.message}`
        : `${res.status} ${res.statusText}`;
      throw new Error(`LinkMate API error — ${errMsg}`);
    }

    const data: ChatCompletionResponse = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    return text.trim();
  }
}
