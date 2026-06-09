/**
 * LinkMate inference proxy (Cloudflare Worker).
 *
 * Why this exists: a Chrome extension is client-side, so any API key we shipped
 * in the bundle would be trivially extracted from the Web Store package. This
 * Worker is the only place the real OpenAI key lives (a Worker secret), and the
 * only place a per-user spend quota can be enforced — the client cannot be
 * trusted to count its own usage.
 *
 * Wire contract: OpenAI-compatible. The extension's ManagedProvider POSTs the
 * exact same body it would send to api.openai.com to `/v1/chat/completions`,
 * but authenticates with an anonymous install token instead of an API key. We
 * swap in the real key server-side, meter the response `usage`, and stop the
 * user once they cross QUOTA_USD of cumulative spend.
 *
 * Endpoints:
 *   POST /v1/chat/completions  → auth + quota gate → OpenAI passthrough → meter
 *   GET  /quota                → { usedUSD, limitUSD, remainingUSD } for a token
 */

export interface Env {
  /** Real OpenAI key. Set with: wrangler secret put OPENAI_API_KEY */
  OPENAI_API_KEY: string;
  /** KV namespace holding per-token cumulative spend + rate-limit counters. */
  USAGE: KVNamespace;
  /** Optional override of the free allowance in USD (string). Default "1.00". */
  QUOTA_USD?: string;
  /** Comma-separated allowed chrome-extension IDs. Empty = allow any (dev). */
  ALLOWED_EXTENSION_IDS?: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

// $1.00 free allowance → reads as 10 tokens in the UI ($0.10 = 1 token).
const DEFAULT_QUOTA_USD = 1.0;

/** Models the proxy will forward. Anything else is rejected so a user can't
 *  ask for an expensive model and drain the shared key. Prices are USD per
 *  1M tokens (input, output) — keep in sync with OpenAI's pricing page. */
const PRICING: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1-nano': { in: 0.1, out: 0.4 },
};

/** Per-token rate limit: max forwarded requests inside RATE_WINDOW_S. */
const RATE_LIMIT = 30;
const RATE_WINDOW_S = 60;

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ─── Types ─────────────────────────────────────────────────────────────────

interface ChatBody {
  model?: string;
  [k: string]: unknown;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface OpenAIResponse {
  usage?: OpenAIUsage;
  [k: string]: unknown;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    // Preflight.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/quota' && request.method === 'GET') {
        return await handleQuota(request, env, cors);
      }
      if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
        return await handleCompletion(request, env, cors);
      }
      return json({ error: { message: 'Not found' } }, 404, cors);
    } catch (err) {
      // Never leak the OpenAI key or the install token in error text.
      const message = err instanceof Error ? err.message : 'Internal error';
      return json({ error: { message } }, 500, cors);
    }
  },
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleQuota(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ error: { message: 'Missing install token' } }, 401, cors);

  const limit = quotaLimit(env);
  const used = await getUsed(env, token);
  return json(
    { usedUSD: round(used), limitUSD: limit, remainingUSD: round(Math.max(0, limit - used)) },
    200,
    cors,
  );
}

async function handleCompletion(
  request: Request,
  env: Env,
  cors: HeadersInit,
): Promise<Response> {
  const token = bearer(request);
  if (!token || !isValidToken(token)) {
    return json({ error: { message: 'Missing or malformed install token' } }, 401, cors);
  }

  // Rate limit per token (blunt abuse / runaway loops).
  const allowed = await underRateLimit(env, token);
  if (!allowed) {
    return json(
      { error: { code: 'rate_limited', message: 'Too many requests. Slow down.' } },
      429,
      cors,
    );
  }

  // Quota gate — refuse before spending another cent.
  const limit = quotaLimit(env);
  const used = await getUsed(env, token);
  if (used >= limit) {
    return json(
      {
        error: {
          code: 'quota_exceeded',
          message: `Free AI allowance used ($${limit.toFixed(2)}). Add your own OpenAI key for unlimited use.`,
          usedUSD: round(used),
          limitUSD: limit,
        },
      },
      402,
      cors,
    );
  }

  // Parse + validate the requested model against the whitelist.
  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return json({ error: { message: 'Invalid JSON body' } }, 400, cors);
  }
  const model = typeof body.model === 'string' ? body.model : '';
  if (!PRICING[model]) {
    return json(
      { error: { message: `Model "${model}" not available on the free tier.` } },
      400,
      cors,
    );
  }

  // Forward to OpenAI with the real key.
  const upstream = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await upstream.text();

  // Meter usage on success and accumulate spend. We read tokens from the
  // response; if absent (e.g. an error) we charge nothing.
  if (upstream.ok) {
    try {
      const parsed = JSON.parse(text) as OpenAIResponse;
      const cost = priceOf(model, parsed.usage);
      if (cost > 0) await addUsed(env, token, cost);
    } catch {
      // Non-JSON success is unexpected; skip metering rather than guess.
    }
  }

  // Return OpenAI's response verbatim (status + body), plus CORS.
  return new Response(text, {
    status: upstream.status,
    headers: { ...(cors as Record<string, string>), 'Content-Type': 'application/json' },
  });
}

// ─── Usage accounting (KV) ─────────────────────────────────────────────────────

function usageKey(token: string): string {
  return `usage:${token}`;
}

async function getUsed(env: Env, token: string): Promise<number> {
  const raw = await env.USAGE.get(usageKey(token));
  const n = raw ? parseFloat(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function addUsed(env: Env, token: string, deltaUSD: number): Promise<void> {
  const next = (await getUsed(env, token)) + deltaUSD;
  await env.USAGE.put(usageKey(token), next.toFixed(6));
}

function priceOf(model: string, usage?: OpenAIUsage): number {
  const p = PRICING[model];
  if (!p || !usage) return 0;
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

// ─── Rate limiting (KV sliding-ish window) ──────────────────────────────────────

async function underRateLimit(env: Env, token: string): Promise<boolean> {
  const key = `rate:${token}`;
  const raw = await env.USAGE.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= RATE_LIMIT) return false;
  // TTL-based window: first request in the window sets the expiry.
  await env.USAGE.put(key, String(count + 1), { expirationTtl: RATE_WINDOW_S });
  return true;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function quotaLimit(env: Env): number {
  const n = env.QUOTA_USD ? parseFloat(env.QUOTA_USD) : DEFAULT_QUOTA_USD;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_QUOTA_USD;
}

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/** Install tokens are client-generated UUID v4 strings. Accept that shape only. */
function isValidToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowList = (env.ALLOWED_EXTENSION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Allow any chrome-extension origin in dev (empty allowlist); pin to the
  // published extension ID(s) in production via ALLOWED_EXTENSION_IDS.
  let allowOrigin = '*';
  if (origin && origin.startsWith('chrome-extension://')) {
    const id = origin.slice('chrome-extension://'.length);
    allowOrigin = allowList.length === 0 || allowList.includes(id) ? origin : 'null';
  } else if (allowList.length > 0) {
    allowOrigin = 'null';
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...(cors as Record<string, string>), 'Content-Type': 'application/json' },
  });
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
