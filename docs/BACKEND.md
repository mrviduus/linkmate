# LinkMate backend (inference proxy)

How the backend works, how to deploy it, and how it ships as part of a release.
For the **extension** release flow (Chrome Web Store), see [RELEASE.md](./RELEASE.md).

- Code: [`proxy/`](../proxy) — a single Cloudflare Worker (`proxy/src/index.ts`)
- Live URL: `https://linkmate-proxy.linkmate.workers.dev`
- Config: `proxy/wrangler.toml`

## Why it exists

The extension is client-side, so any OpenAI key shipped in the bundle would be
trivially extracted from the Web Store package. The Worker is the **only** place
the real OpenAI key lives (a Worker secret), and the only place a per-user spend
quota can be enforced (a client can't be trusted to count its own usage).

This is what lets LinkMate offer **free AI with no key** ("managed" provider
mode). Users who hit the quota switch to their own key (BYOK), which talks to
OpenAI/Groq directly and never touches this proxy.

## How it works

```
extension (ManagedProvider)                 Worker (proxy/)              OpenAI
  POST /v1/chat/completions  ───────────▶  auth install token
  Authorization: Bearer <UUID>             check quota (KV)
                                           inject real key  ──────────▶  /v1/chat/completions
                                           meter usage → KV  ◀──────────  response (usage)
  response (verbatim)        ◀───────────  return verbatim
```

- **OpenAI key**: a Worker secret (`OPENAI_API_KEY`), never in git or the client.
- **Auth**: an anonymous install UUID the extension generates on first run, sent
  as a bearer token. The proxy maps it to a per-user spend counter.
- **Quota**: cumulative USD per install, tracked in KV. Default **$2** (surfaced
  in the UI as "20 tokens", $0.10 = 1 token). At the limit the proxy returns
  `402 quota_exceeded` and the extension prompts the user to add their own key.
- **Model whitelist**: only the cheap models in `PRICING` (`proxy/src/index.ts`)
  are forwarded, so a crafted request can't drain the shared key on an expensive
  model.
- **Rate limit**: 30 forwarded requests / 60s per token (KV TTL window).
- **CORS**: open to any `chrome-extension://` origin when `ALLOWED_EXTENSION_IDS`
  is empty (dev); pin to the published Web Store ID for production.

### Endpoints

| Method | Path                   | Purpose                                          |
| ------ | ---------------------- | ------------------------------------------------ |
| POST   | `/v1/chat/completions` | OpenAI-compatible passthrough, gated + metered.  |
| GET    | `/quota`               | `{ usedUSD, limitUSD, remainingUSD }` for token. |

Both expect `Authorization: Bearer <install-uuid>`.

## Deploy

### How it ships in a release (recommended)

The backend deploys **automatically** as the last step of the release pipeline
(`.github/workflows/release.yml`), on the same `vX.Y.Z` tag that publishes the
extension:

```yaml
- name: Deploy inference proxy (Cloudflare Worker)
  if: ${{ env.CLOUDFLARE_API_TOKEN != '' }}
  working-directory: proxy
  run: npm ci && npx wrangler deploy
```

So a normal release (`scripts/release.sh X.Y.Z`, or bump + tag + push — see
[RELEASE.md](./RELEASE.md)) **also redeploys the Worker**. The step runs only
when the `CLOUDFLARE_API_TOKEN` repo secret is set, and it does **not** touch the
`OPENAI_API_KEY` Worker secret (that's set once, separately).

> A `wrangler deploy` is idempotent and near-instant — re-running it on every
> release with no proxy changes is harmless.

### Manual deploy (hotfix / first-time)

From the `proxy/` directory:

```bash
cd proxy
npm install
npx wrangler deploy        # needs wrangler auth — see below
```

Auth: either `npx wrangler login` (interactive, opens a browser) or set
`CLOUDFLARE_API_TOKEN` in the env (same token the CI uses).

### Local dev

```bash
cd proxy
npx wrangler dev
# then, against the printed localhost URL:
curl -s localhost:8787/quota -H "Authorization: Bearer 00000000-0000-4000-8000-000000000000"
```

## One-time setup

Already done for the live deployment — listed here for a fresh environment.

1. **KV namespace** (per-token spend + rate-limit counters):
   ```bash
   npx wrangler kv namespace create USAGE   # paste the printed id into wrangler.toml
   ```
2. **OpenAI key** as a Worker secret (never in git/client):
   ```bash
   npx wrangler secret put OPENAI_API_KEY
   ```
3. **CI deploy token** — a Cloudflare API token with scopes **Workers Scripts:Edit**
   + **Workers KV Storage:Edit** (dashboard → My Profile → API Tokens → template
   "Edit Cloudflare Workers"), added to GitHub as the `CLOUDFLARE_API_TOKEN`
   repo secret (Settings → Secrets and variables → Actions).

## Config (`proxy/wrangler.toml` `[vars]`)

| Var                     | Default  | Meaning                                      |
| ----------------------- | -------- | -------------------------------------------- |
| `QUOTA_USD`             | `"2.00"` | Free allowance per install.                  |
| `ALLOWED_EXTENSION_IDS` | `""`     | Comma-separated Web Store IDs (empty = any). |

Served on the default `*.workers.dev` URL (`workers_dev = true`). To move to a
custom domain, add a `[[routes]]` block with `custom_domain = true` (requires an
active Cloudflare zone) and update `MANAGED_BASE_URL` in
`src/providers/managed-provider.ts` + the proxy host in `src/manifest.json`
(CSP `connect-src` and `host_permissions`).

## Production checklist

- [ ] Set `ALLOWED_EXTENSION_IDS` to the published Web Store ID(s) (CORS is open
      to any extension while empty) and redeploy.
- [ ] Keep the `PRICING` table in `proxy/src/index.ts` in sync with OpenAI prices
      (drift is bounded by the $2 cap).
- [ ] Abuse note: the install UUID resets on reinstall, so the quota is
      per-install, not strictly per-person. Bounded by $2 + rate limit; upgrade
      to a server-issued / Google-bound token later without changing the wire
      contract.
