/**
 * v0.5.0 — OpenAIProvider spec. Injects mock fetch.
 */

import { OpenAIProvider } from '../../src/providers/openai-provider';

function makeFetch(opts: {
  ok: boolean;
  status?: number;
  body: unknown;
}): jest.MockedFunction<typeof fetch> {
  return jest.fn().mockResolvedValue({
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    statusText: opts.ok ? 'OK' : 'Internal Server Error',
    json: async () => opts.body,
  } as unknown as Response) as jest.MockedFunction<typeof fetch>;
}

describe('OpenAIProvider', () => {
  it('reports isCloud=true and includes model id in name', () => {
    const p = new OpenAIProvider({ apiKey: 'sk-xx', model: 'gpt-4o-mini' }, makeFetch({ ok: true, body: {} }));
    expect(p.isCloud).toBe(true);
    expect(p.name).toContain('gpt-4o-mini');
  });

  it('throws at construction if apiKey is empty', () => {
    expect(() => new OpenAIProvider({ apiKey: '', model: 'gpt-4o-mini' })).toThrow(/apiKey/);
  });

  it('throws at construction if model is empty', () => {
    expect(() => new OpenAIProvider({ apiKey: 'sk-xx', model: '' })).toThrow(/model/);
  });

  it('POSTs to /v1/chat/completions on api.openai.com with Bearer auth', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'hello back' } }] },
    });
    const p = new OpenAIProvider({ apiKey: 'sk-test', model: 'gpt-4o-mini' }, fetchMock);
    const out = await p.generate({ system: 'S', user: 'U' });
    expect(out).toBe('hello back');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
  });

  it('forwards max_tokens / temperature / top_p / stop', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'x' } }] },
    });
    const p = new OpenAIProvider({ apiKey: 'sk-xx', model: 'gpt-4o-mini' }, fetchMock);
    await p.generate({
      system: 's',
      user: 'u',
      maxTokens: 200,
      temperature: 0.3,
      topP: 0.5,
      stop: ['END'],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBeCloseTo(0.3);
    expect(body.top_p).toBeCloseTo(0.5);
    expect(body.stop).toEqual(['END']);
  });

  it('honors a custom baseUrl (Azure / proxy)', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'x' } }] },
    });
    const p = new OpenAIProvider(
      { apiKey: 'sk-xx', model: 'gpt-4o-mini', baseUrl: 'https://proxy.example.com' },
      fetchMock,
    );
    await p.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example.com/v1/chat/completions');
  });

  it('returns trimmed content from first choice', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: '  spaced  ' } }] },
    });
    const p = new OpenAIProvider({ apiKey: 'sk-xx', model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).resolves.toBe('spaced');
  });

  it('returns empty string when choices is missing', async () => {
    const fetchMock = makeFetch({ ok: true, body: {} });
    const p = new OpenAIProvider({ apiKey: 'sk-xx', model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).resolves.toBe('');
  });

  it('throws with status code and OpenAI error message on non-OK response', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 401,
      body: { error: { message: 'Invalid Authentication' } },
    });
    const p = new OpenAIProvider({ apiKey: 'sk-bad', model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).rejects.toThrow(
      /401.*Invalid Authentication/,
    );
  });

  it('throws a status-only error when response body is not JSON', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response) as jest.MockedFunction<typeof fetch>;
    const p = new OpenAIProvider({ apiKey: 'sk-xx', model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).rejects.toThrow(/500/);
  });

  it('never includes apiKey in error messages (no leak on failure)', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 401,
      body: { error: { message: 'bad key' } },
    });
    const apiKey = 'sk-supersecret-that-must-not-leak';
    const p = new OpenAIProvider({ apiKey, model: 'gpt-4o-mini' }, fetchMock);
    try {
      await p.generate({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(apiKey);
    }
  });
});
