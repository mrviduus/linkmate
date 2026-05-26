/**
 * v0.5.0 — OpenAI provider (opt-in cloud, BYOK).
 *
 * Sends the user's prompt to OpenAI's chat-completions endpoint. The user
 * provides their own API key in popup settings; the extension stores it in
 * chrome.storage.local (per-browser-profile, never synced) and never logs
 * it to console.
 *
 * Constitution v1.2 §I (amended): cloud providers are opt-in, default off,
 * persistent visual indicator required when active. The compliance impact
 * is loud:
 *   - LinkedIn post content + your profile positioning leave the browser
 *   - OpenAI logs requests per their data-usage policy
 *   - LinkedIn TOS implications are the user's responsibility once opted in
 */

import type { InferenceParams, InferenceProvider } from './inference-provider';

export interface OpenAIConfig {
  /** Bearer token (`sk-...`). Never log. */
  apiKey: string;
  /** Model id, e.g. "gpt-4o-mini", "gpt-4o", "gpt-4.1-mini". */
  model: string;
  /** Override base URL for proxies / Azure-compatible endpoints. Default OpenAI. */
  baseUrl?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAIProvider implements InferenceProvider {
  readonly name: string;
  readonly isCloud = true;
  private readonly cfg: OpenAIConfig;
  /** Test hook — when undefined we resolve global fetch at generate() time. */
  private readonly fetchImpl?: typeof fetch;

  constructor(cfg: OpenAIConfig, fetchImpl?: typeof fetch) {
    if (!cfg.apiKey) {
      throw new Error('OpenAIProvider requires an apiKey');
    }
    if (!cfg.model) {
      throw new Error('OpenAIProvider requires a model id');
    }
    this.cfg = cfg;
    this.name = `OpenAI (${cfg.model})`;
    this.fetchImpl = fetchImpl;
  }

  async generate(params: InferenceParams): Promise<string> {
    const doFetch = this.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) {
      throw new Error('No fetch available in this runtime');
    }
    const baseUrl = this.cfg.baseUrl ?? 'https://api.openai.com';
    const url = `${baseUrl}/v1/chat/completions`;

    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      // OpenAI prefers `max_completion_tokens` for newer models; the legacy
      // `max_tokens` still works everywhere and keeps Azure parity.
      max_tokens: params.maxTokens ?? 150,
      temperature: params.temperature ?? 0.85,
      top_p: params.topP ?? 0.9,
      stop: params.stop,
    };

    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let errMsg = `${res.status} ${res.statusText}`;
      try {
        const errBody: ChatCompletionResponse = await res.json();
        if (errBody.error?.message) errMsg = `${res.status}: ${errBody.error.message}`;
      } catch {
        // Body not JSON — fall back to status line.
      }
      throw new Error(`OpenAI API error — ${errMsg}`);
    }

    const data: ChatCompletionResponse = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    return text.trim();
  }
}
