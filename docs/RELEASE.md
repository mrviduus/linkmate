# Releasing LinkMate

How to cut a release and (optionally) auto-publish to the Chrome Web Store.

- Extension ID: `ehakmbhencmboidbhjecighefplfbgmh`
- Pipeline: `.github/workflows/release.yml` (triggers on `v*.*.*` tags)

## How a release works

1. Bump `version` in `package.json` **and** `src/manifest.json` (keep them equal).
2. Update `CHANGELOG.md`.
3. Commit, then create an annotated tag `vX.Y.Z` and push it.
4. The `release` workflow runs `type-check → lint → test → npm run zip`, creates a
   GitHub Release with `linkmate.zip` attached and auto-generated notes, and — if
   the four `CWS_*` secrets exist — uploads + submits the zip to the Chrome Web Store.
5. **The same tag also redeploys the backend proxy** (Cloudflare Worker) when the
   `CLOUDFLARE_API_TOKEN` secret is set. See [BACKEND.md](./BACKEND.md) for how the
   backend works and how to deploy it standalone.

The helper `scripts/release.sh X.Y.Z` does steps 1–3 (bump, commit, tag, push) in
one command. The version must be plain semver with no leading `v`.

```bash
scripts/release.sh 1.0.1
```

## One-time: Chrome Web Store API credentials

The optional publish step needs OAuth2 credentials so GitHub Actions can call the
Chrome Web Store API on your behalf. You only do this once.

### 1. Create / pick a Google Cloud project

- Go to <https://console.cloud.google.com> and create a project (or reuse one).

### 2. Enable the Chrome Web Store API

- APIs & Services → Library → search **"Chrome Web Store API"** → **Enable**.

### 3. Configure the OAuth consent screen

- APIs & Services → OAuth consent screen → **External** → fill app name + your
  email → Save. Add your Google account under **Test users** (so the consent
  screen works while the app is in "Testing").

### 4. Create an OAuth Client ID (Desktop app)

- APIs & Services → Credentials → **Create Credentials → OAuth client ID**.
- Application type: **Desktop application**.
- Save the **Client ID** and **Client secret**.

### 5. Get a refresh token

Reference: <https://developer.chrome.com/docs/webstore/using-api/#beforeyoubegin>

**Quick path — use the helper script** (does steps a + b for you: starts a
localhost server, opens the consent screen, exchanges the code, prints the token):

```bash
node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
```

Copy the printed `refresh_token` into the GitHub secret (step 6). The manual flow
below is the fallback if you'd rather not run the script.

Replace `$CLIENT_ID` / `$CLIENT_SECRET` below.

**a. Authorize.** Open this URL in a browser (logged in as the publisher account),
approve access, and copy the `code` value from the redirect page:

```
https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=$CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob
```

> If you see "redirect_uri urn:ietf:wg:oauth:2.0:oob is not supported", use
> `http://localhost` as the `redirect_uri` instead and grab the `code` query
> param from the (failed) localhost redirect URL.

**b. Exchange the code for a refresh token** (the `code` is single-use):

```bash
curl "https://oauth2.googleapis.com/token" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "code=$CODE" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

The JSON response contains `refresh_token`. Save it — refresh tokens are long-lived.

### 6. Add the secrets to GitHub

Repo → **Settings → Secrets and variables → Actions → New repository secret**.
Add all four:

| Secret | Value |
| --- | --- |
| `CWS_EXTENSION_ID` | `ehakmbhencmboidbhjecighefplfbgmh` |
| `CWS_CLIENT_ID` | OAuth client ID from step 4 |
| `CWS_CLIENT_SECRET` | OAuth client secret from step 4 |
| `CWS_REFRESH_TOKEN` | refresh token from step 5 |

With all four present, the next `vX.Y.Z` tag push uploads and submits the new
version automatically. Without them, the workflow still builds the GitHub Release
and just skips the store upload.

## Notes

- The store still reviews each submission; "submitted" is not "live".
- First-ever listing fields (description, screenshots, privacy practices) must be
  filled in the Developer Dashboard manually — the API only updates the package.
- If a token stops working, re-run step 5 to mint a fresh refresh token.
