/**
 * Provider factory — OpenAI only.
 *
 * LinkMate ships cloud-only (OpenAI BYOK). The provider abstraction is kept
 * so future backends (Anthropic, Groq, Azure-compatible proxies) can be
 * added without rewriting callers.
 */

import { getProviderConfig } from '../storage-schema';
import type { ProviderConfig } from '../storage-schema';
import type { InferenceProvider } from './inference-provider';
import { OpenAIProvider } from './openai-provider';
import { GroqProvider } from './groq-provider';

export type { InferenceProvider, InferenceParams } from './inference-provider';
export { OpenAIProvider } from './openai-provider';
export { GroqProvider } from './groq-provider';

/** Build the active provider from stored config. Throws if no API key is set. */
export async function getActiveProvider(): Promise<InferenceProvider> {
  const cfg = await getProviderConfig();
  return buildProvider(cfg);
}

/** Pure: build provider from an explicit config. Used in tests + getActiveProvider. */
export function buildProvider(cfg: ProviderConfig): InferenceProvider {
  if (cfg.mode === 'groq') {
    if (!cfg.groq?.apiKey) {
      throw new Error('Groq API key not configured. Open the popup → Settings to add one.');
    }
    return new GroqProvider({
      apiKey: cfg.groq.apiKey,
      model: cfg.groq.model || 'groq/compound',
      baseUrl: cfg.groq.baseUrl,
    });
  }

  if (!cfg.openai?.apiKey) {
    throw new Error('OpenAI API key not configured. Open the popup → Settings to add one.');
  }
  return new OpenAIProvider({
    apiKey: cfg.openai.apiKey,
    model: cfg.openai.model || 'gpt-4o-mini',
    baseUrl: cfg.openai.baseUrl,
  });
}
