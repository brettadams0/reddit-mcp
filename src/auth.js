import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, fetchWithTimeout, responseError } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const CREDENTIALS_DIR = path.join(__dirname, '..', 'credentials');
export const CLIENT_SECRET_PATH = path.join(CREDENTIALS_DIR, 'client_secret.json');
export const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'token.json');

// Reddit requires every API consumer to send a distinctive User-Agent of the
// form <platform>:<app id>:<version> (by /u/<username>), and throttles generic
// ones hard. Set REDDIT_USERNAME to the account this app is registered under,
// or override the whole string with REDDIT_USER_AGENT. The placeholder fallback
// still works, but Reddit treats it as generic traffic.
export const USER_AGENT =
  process.env.REDDIT_USER_AGENT ||
  `${process.platform}:reddit-mcp:v${VERSION} (by /u/${process.env.REDDIT_USERNAME || '<reddit-username>'})`;

export const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';
export const API_BASE = 'https://oauth.reddit.com';

export async function loadClientSecret() {
  const raw = await readFile(CLIENT_SECRET_PATH, 'utf-8').catch(() => {
    throw new Error(
      `Missing ${CLIENT_SECRET_PATH}. Create it with {"client_id": "...", "client_secret": "..."} from https://www.reddit.com/prefs/apps`
    );
  });
  return JSON.parse(raw);
}

export function basicAuthHeader(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/**
 * Hand out access tokens, refreshing shortly before expiry.
 *
 * Clients call tools in parallel, so several calls can find the token expired
 * at once. They share one refresh rather than each starting their own: for a
 * provider that rotates refresh tokens, the losers of that race would present
 * a token the winner had just spent. The storage and the refresh itself are
 * injected so this logic can be tested without credentials or a network.
 */
export function createTokenStore({ load, save, refresh, skewMs = 60_000 }) {
  let token = null;
  let pending = null;

  return {
    async accessToken() {
      token ??= await load();
      if (Date.now() >= token.expires_at - skewMs) {
        pending ??= (async () => {
          const next = await refresh(token);
          await save(next);
          token = next;
        })().finally(() => {
          pending = null;
        });
        await pending;
      }
      return token.access_token;
    },
  };
}

async function refreshWithReddit(current) {
  const { client_id, client_secret } = await loadClientSecret();
  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(client_id, client_secret),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh_token }),
    },
    'Reddit token endpoint'
  );
  if (!res.ok) throw await responseError(res, 'Reddit token refresh', TOKEN_ENDPOINT);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: current.refresh_token, // Reddit doesn't rotate the refresh token
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

const tokens = createTokenStore({
  load: async () => {
    const raw = await readFile(TOKEN_PATH, 'utf-8').catch(() => {
      throw new Error(`No token found at ${TOKEN_PATH}. Run "npm run authorize" first.`);
    });
    return JSON.parse(raw);
  },
  save: (token) => writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 }),
  refresh: refreshWithReddit,
});

export const getAccessToken = () => tokens.accessToken();

export async function redditFetch(pathname, { method = 'GET', body, query } = {}) {
  const accessToken = await getAccessToken();
  const url = new URL(`${API_BASE}${pathname}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }

  const res = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
    },
    'Reddit API'
  );

  if (!res.ok) throw await responseError(res, 'Reddit API', pathname);
  return res.json();
}
