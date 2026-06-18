/**
 * ManagedProvider spec — LinkMate hosted free tier. Injects mock fetch.
 *
 * Mirrors openai-provider.spec.ts: same wire contract, but auth is the install
 * token (not an API key) and HTTP 402 maps to a typed QuotaExceededError.
 */

import {
  ManagedProvider,
  QuotaExceededError,
  MANAGED_BASE_URL,
} from '../../src/providers/managed-provider';

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

const TOKEN = '00000000-0000-4000-8000-000000000000';

describe('ManagedProvider', () => {
  it('reports isCloud=true and names itself LinkMate', () => {
    const p = new ManagedProvider(
      { installToken: TOKEN, model: 'gpt-4o-mini' },
      makeFetch({ ok: true, body: {} }),
    );
    expect(p.isCloud).toBe(true);
    expect(p.name).toContain('LinkMate');
    expect(p.name).toContain('gpt-4o-mini');
  });

  it('throws at construction if install token is empty', () => {
    expect(() => new ManagedProvider({ installToken: '', model: 'gpt-4o-mini' })).toThrow(
      /install token/,
    );
  });

  it('throws at construction if model is empty', () => {
    expect(() => new ManagedProvider({ installToken: TOKEN, model: '' })).toThrow(/model/);
  });

  it('POSTs to the proxy /v1/chat/completions with the install token as Bearer', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'hello back' } }] },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    const out = await p.generate({ system: 'S', user: 'U' });
    expect(out).toBe('hello back');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${MANAGED_BASE_URL}/v1/chat/completions`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U' },
    ]);
  });

  it('honors a custom baseUrl (e.g. *.workers.dev)', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'x' } }] },
    });
    const p = new ManagedProvider(
      { installToken: TOKEN, model: 'gpt-4o-mini', baseUrl: 'https://lm.workers.dev' },
      fetchMock,
    );
    await p.generate({ system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://lm.workers.dev/v1/chat/completions');
  });

  it('forwards generation params', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: 'x' } }] },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    await p.generate({ system: 's', user: 'u', maxTokens: 200, temperature: 0.3, stop: ['END'] });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBeCloseTo(0.3);
    expect(body.stop).toEqual(['END']);
  });

  it('returns trimmed content from the first choice', async () => {
    const fetchMock = makeFetch({
      ok: true,
      body: { choices: [{ message: { content: '  spaced  ' } }] },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).resolves.toBe('spaced');
  });

  it('throws QuotaExceededError on HTTP 402', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 402,
      body: { error: { code: 'quota_exceeded', message: 'used up', usedUSD: 2, limitUSD: 2 } },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('exposes used/limit on the QuotaExceededError', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 402,
      body: { error: { code: 'quota_exceeded', message: 'used up', usedUSD: 2, limitUSD: 2 } },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    try {
      await p.generate({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const q = err as QuotaExceededError;
      expect(q.code).toBe('quota_exceeded');
      expect(q.limitUSD).toBe(2);
    }
  });

  it('throws a generic error on other non-OK responses', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 500,
      body: { error: { message: 'boom' } },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    await expect(p.generate({ system: 's', user: 'u' })).rejects.toThrow(/500.*boom/);
  });

  it('never includes the install token in error messages (no leak)', async () => {
    const fetchMock = makeFetch({
      ok: false,
      status: 500,
      body: { error: { message: 'server error' } },
    });
    const p = new ManagedProvider({ installToken: TOKEN, model: 'gpt-4o-mini' }, fetchMock);
    try {
      await p.generate({ system: 's', user: 'u' });
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(TOKEN);
    }
  });
});
