#!/usr/bin/env node
/**
 * One-shot helper to obtain a Chrome Web Store API refresh token.
 *
 * Usage:
 *   node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * Flow:
 *   1. Starts a local HTTP server on http://localhost:8910
 *   2. Opens the Google OAuth consent screen in your default browser
 *   3. After you grant access, Google redirects back to localhost with a code
 *   4. The script exchanges the code for an access + refresh token
 *   5. Prints the refresh token to stdout — copy it into your GitHub secret
 *
 * Notes:
 * - Refresh tokens for "Desktop app" client IDs do not expire as long as
 *   the project stays in "Testing" mode with you as a test user, and you
 *   keep using the token at least once every ~6 months.
 * - If you ever revoke access at https://myaccount.google.com/permissions
 *   you'll need to rerun this script.
 */

import http from 'node:http';
import { exec } from 'node:child_process';
import { URL } from 'node:url';

const [, , CLIENT_ID, CLIENT_SECRET] = process.argv;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>');
  process.exit(1);
}

const PORT = 8910;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPE);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, REDIRECT_URI);
  const code = reqUrl.searchParams.get('code');
  const error = reqUrl.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`OAuth error: ${error}\nYou can close this tab.`);
    console.error(`\n[!] OAuth error: ${error}`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400);
    res.end('No code parameter');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    '<html><body style="font-family: sans-serif; padding: 2rem;">' +
      '<h2>Done.</h2><p>You can close this tab and return to the terminal.</p>' +
      '</body></html>',
  );

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenRes.json();

    if (!tokens.refresh_token) {
      console.error('\n[!] No refresh_token in response.');
      console.error('    This usually means you have already granted consent for this client.');
      console.error('    Revoke at https://myaccount.google.com/permissions and try again.');
      console.error('    Raw response:', tokens);
      process.exit(1);
    }

    console.log('\n========================================');
    console.log('SUCCESS — copy these values into GitHub secrets:');
    console.log('========================================');
    console.log(`CWS_CLIENT_ID=${CLIENT_ID}`);
    console.log(`CWS_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`CWS_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('========================================\n');
    console.log('Do NOT commit these values. Add them at:');
    console.log('  https://github.com/mrviduus/linkmate/settings/secrets/actions');
    console.log('');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('\n[!] Token exchange failed:', err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\nLocal redirect listener on ${REDIRECT_URI}`);
  console.log('Opening browser for Google OAuth consent...\n');
  console.log('If the browser does not open, paste this URL manually:\n');
  console.log(authUrl.toString());
  console.log('');

  const openCmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCmd} "${authUrl.toString()}"`);
});
