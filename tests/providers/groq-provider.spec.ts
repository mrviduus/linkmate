import { GroqProvider } from '../../src/providers/groq-provider';

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

describe('GroqProvider', () => {
  it('reports isCloud=true and includes model id in name', () => {
    const p = new GroqProvider({ apiKey: 'gsk-xx', model: 'groq/compound' }, makeFetch({ ok: true, body: {} }));
    expect(p.isCloud).toBe(true);
    expect(p.name).toContain('groq/compound');
  });

  it('throws at construction if apiKey is empty', () => {
    expect(() => new GroqProvider({ apiKey: '', model: 'groq/compound' })).toThrow(/apiKey/);
  });

  it('throws at construction if model is empty', () => {
    expect(() => new GroqProvider({ apiKey: 'gsk-xx', model: '' })).toThrow(/model/);
  });

  it('POSTs to /v1/chat/completions on api.groq.com with Bearer auth', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'groq reply' } }] },
    });
    const p = new GroqProvider({ apiKey: 'gsk-test', model: 'groq/compound' }, fetchMock);
    const out = await p.generate({ system: 'System Prompt', user: 'User Prompt' });
    expect(out).toBe('groq reply');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gsk-test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('groq/compound');
    expect(body.messages).toEqual([
      { role: 'system', content: 'System Prompt' },
      { role: 'user', content: 'User Prompt' },
    ]);
  });

  it('forwards max_tokens / temperature / top_p / stop', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'x' } }] },
    });
    const p = new GroqProvider({ apiKey: 'gsk-xx', model: 'groq/compound-mini' }, fetchMock);
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

  it('honors a custom baseUrl', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'x' } }] },
    });
    const p = new GroqProvider(
      { apiKey: 'gsk-xx', model: 'groq/compound', baseUrl: 'https://groq-proxy.com' },
      fetchMock,
    );
    await p.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://groq-proxy.com/v1/chat/completions');
  });

  it('returns empty string when choices is missing', async () => {
    const fetchMock = makeFetch({ ok: true, body: {} });
    const p = new GroqProvider({ apiKey: 'gsk-xx', model: 'groq/compound' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).resolves.toBe('');
  });

  it('throws with status code and Groq error message on non-OK response', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 401,
      body: { error: { message: 'Invalid Authentication' } },
    });
    const p = new GroqProvider({ apiKey: 'gsk-bad', model: 'groq/compound' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).rejects.toThrow(
      /401.*Invalid Authentication/,
    );
  });

  it('never includes apiKey in error messages (no leak on failure)', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 401,
      body: { error: { message: 'bad key' } },
    });
    const apiKey = 'gsk-supersecret-key-do-not-leak';
    const p = new GroqProvider({ apiKey, model: 'groq/compound' }, fetchMock);
    try {
      await p.generate({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(apiKey);
    }
  });
});
