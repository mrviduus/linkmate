/**
 * buildProvider spec — pure factory branch coverage (managed / openai / groq).
 */

import { buildProvider, ManagedProvider, OpenAIProvider, GroqProvider } from '../../src/providers';
import type { ProviderConfig } from '../../src/storage-schema';

const TOKEN = '00000000-0000-4000-8000-000000000000';

describe('buildProvider', () => {
  it('builds a ManagedProvider for managed mode with an install token', () => {
    const cfg: ProviderConfig = { mode: 'managed', managed: { model: 'gpt-4o-mini' } };
    const p = buildProvider(cfg, TOKEN);
    expect(p).toBeInstanceOf(ManagedProvider);
  });

  it('throws for managed mode without an install token', () => {
    const cfg: ProviderConfig = { mode: 'managed', managed: { model: 'gpt-4o-mini' } };
    expect(() => buildProvider(cfg)).toThrow(/install token/);
  });

  it('builds an OpenAIProvider for openai mode with a key', () => {
    const cfg: ProviderConfig = { mode: 'openai', openai: { apiKey: 'sk-x', model: 'gpt-4o-mini' } };
    expect(buildProvider(cfg)).toBeInstanceOf(OpenAIProvider);
  });

  it('throws for openai mode without a key', () => {
    const cfg: ProviderConfig = { mode: 'openai', openai: { apiKey: '', model: 'gpt-4o-mini' } };
    expect(() => buildProvider(cfg)).toThrow(/OpenAI API key/);
  });

  it('builds a GroqProvider for groq mode with a key', () => {
    const cfg: ProviderConfig = { mode: 'groq', groq: { apiKey: 'gsk-x', model: 'groq/compound' } };
    expect(buildProvider(cfg)).toBeInstanceOf(GroqProvider);
  });
});
