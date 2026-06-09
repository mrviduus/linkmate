import type { InferenceParams, InferenceProvider } from './inference-provider';

export interface GroqConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string; type?: string; code?: string };
}

export class GroqProvider implements InferenceProvider {
  readonly name: string;
  readonly isCloud = true;
  private readonly cfg: GroqConfig;
  private readonly fetchImpl?: typeof fetch;

  constructor(cfg: GroqConfig, fetchImpl?: typeof fetch) {
    if (!cfg.apiKey) {
      throw new Error('GroqProvider requires an apiKey');
    }
    if (!cfg.model) {
      throw new Error('GroqProvider requires a model id');
    }
    this.cfg = cfg;
    this.name = `Groq (${cfg.model})`;
    this.fetchImpl = fetchImpl;
  }

  async generate(params: InferenceParams): Promise<string> {
    const doFetch = this.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!doFetch) {
      throw new Error('No fetch available in this runtime');
    }
    const baseUrl = this.cfg.baseUrl ?? 'https://api.groq.com/openai';
    const url = `${baseUrl}/v1/chat/completions`;

    const body = {
      model: params.model ?? this.cfg.model,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
      max_tokens: params.maxTokens ?? 150,
      temperature: params.temperature ?? 0.85,
      top_p: params.topP ?? 0.9,
      stop: params.stop,
    };

    console.log(`🤖 [LinkMate Provider] Dispatching Groq request to model "${this.cfg.model}"...`);

    const timeoutMs = params.timeoutMs ?? 60_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Groq request timed out after ${timeoutMs / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      let errMsg = `${res.status} ${res.statusText}`;
      try {
        const errBody: ChatCompletionResponse = await res.json();
        if (errBody.error?.message) errMsg = `${res.status}: ${errBody.error.message}`;
      } catch {
        // Fall back
      }
      throw new Error(`Groq API error — ${errMsg}`);
    }

    const data: ChatCompletionResponse = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    console.log(
      `🤖 [LinkMate Provider] Groq response successfully received: ${text.slice(0, 50)}...`
    );
    return text.trim();
  }
}
