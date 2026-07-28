import http from 'node:http';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadClientSecret, CREDENTIALS_DIR, TOKEN_PATH, USER_AGENT, TOKEN_ENDPOINT } from '../src/auth.js';

const SCOPES = ['identity', 'read', 'submit', 'edit', 'vote', 'privatemessages', 'mysubreddits', 'history', 'save'];

const PORT = 53683;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

async function main() {
  const { client_id, client_secret } = await loadClientSecret();
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl = new URL('https://www.reddit.com/api/v1/authorize');
  authUrl.searchParams.set('client_id', client_id);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('duration', 'permanent');
  authUrl.searchParams.set('scope', SCOPES.join(' '));

  console.log('\nOpen this URL and sign in / approve with the Reddit account you want the server to use:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for the redirect back to localhost...\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      if (error) {
        res.end('Authorization failed. Check the terminal for details.');
        server.close();
        reject(new Error(`Reddit returned an error: ${error}`));
        return;
      }
      if (returnedState !== state) {
        res.end('State mismatch. Aborting.');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF, aborting.'));
        return;
      }
      if (code) {
        res.end('Authorized! You can close this tab and return to the terminal.');
        server.close();
        resolve(code);
        return;
      }
      res.end('Waiting for authorization...');
    });
    server.listen(PORT);
  });

  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const data = await tokenRes.json();

  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await writeFile(
    TOKEN_PATH,
    JSON.stringify(
      {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
      },
      null,
      2
    )
  );
  console.log(`Saved token to ${TOKEN_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
