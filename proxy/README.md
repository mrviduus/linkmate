# LinkMate inference proxy

A tiny Cloudflare Worker that lets LinkMate ship **without** asking every user
for an OpenAI key. It holds the real key server-side and gives each anonymous
install a free spend allowance (default **$2**), enforced server-side because a
client-side extension can't be trusted to count its own usage.

This folder is **independent** of the extension build (Parcel only reads
`../src/manifest.json`). It deploys separately to Cloudflare.

## How it works

```
extension (ManagedProvider)                 this Worker                 OpenAI
  POST /v1/chat/completions  ───────────▶  auth install token
  Authorization: Bearer <UUID>             check quota (KV)
                                           inject real key  ──────────▶  /v1/chat/completions
                                           meter usage → KV  ◀──────────  response (with usage)
  response (verbatim)        ◀───────────  return verbatim
```

- **No key in the client.** `OPENAI_API_KEY` is a Worker secret.
- **Per-user quota.** Keyed by an anonymous install UUID the extension generates
  on first run. Cumulative USD spend is tracked in KV; once it hits `QUOTA_USD`
  the Worker returns `402 quota_exceeded` and the extension prompts the user to
  add their own key (BYOK, unlimited).
- **Model whitelist.** Only the cheap models in `PRICING` (`src/index.ts`) are
  forwarded, so a crafted request can't drain the shared key on an expensive
  model.
- **Rate limit.** 30 forwarded requests / 60s per token (KV TTL window).
- **CORS.** Open to any `chrome-extension://` origin in dev; pin to the
  published Web Store ID in production via `ALLOWED_EXTENSION_IDS`.

> Abuse note: anonymous UUIDs reset on reinstall, so the $2 cap is per-install,
> not strictly per-person. At $2 with `gpt-4o-mini` the farm-by-reinstall payoff
> is cents — the rate limit + whitelist keep the blast radius small. Upgrade to
> a server-issued/Google-bound token later without changing the wire contract.

## Endpoints

| Method | Path                    | Purpose                                         |
| ------ | ----------------------- | ----------------------------------------------- |
| POST   | `/v1/chat/completions`  | OpenAI-compatible passthrough, gated + metered. |
| GET    | `/quota`                | `{ usedUSD, limitUSD, remainingUSD }` for token.|

Both expect `Authorization: Bearer <install-uuid>`.

## Deploy

```bash
cd proxy
npm install

# 1. Create the KV namespace and paste the printed id into wrangler.toml (<KV_ID>)
npx wrangler kv namespace create USAGE

# 2. Store the real OpenAI key (never goes in git or the client)
npx wrangler secret put OPENAI_API_KEY

# 3. Ship it
npx wrangler deploy
```

By default this serves on `api.textstack.app` (see `[[routes]]` in
`wrangler.toml`); `textstack.app` must be an active zone on the account. To use
the free `*.workers.dev` URL instead, delete the `[[routes]]` block before
deploying — then point the extension's `MANAGED_BASE_URL` at the workers.dev URL.

## Config (`wrangler.toml` `[vars]`)

| Var                     | Default  | Meaning                                        |
| ----------------------- | -------- | ---------------------------------------------- |
| `QUOTA_USD`             | `"2.00"` | Free allowance per install.                    |
| `ALLOWED_EXTENSION_IDS` | `""`     | Comma-separated Web Store IDs (empty = any).   |

## Local test

```bash
npx wrangler dev
# then, against the printed localhost URL:
curl -s localhost:8787/quota -H "Authorization: Bearer 00000000-0000-4000-8000-000000000000"
```
