import { chmod, readFile, writeFile } from 'node:fs/promises';
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

/**
 * Write the token file readable by its owner only. `writeFile`'s `mode` applies
 * only when it creates the file, so a token.json left at 0644 by an earlier
 * version is tightened explicitly: its refresh token never expires.
 */
export async function saveToken(token) {
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
  await chmod(TOKEN_PATH, 0o600);
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
  let loading = null;
  let pending = null;

  return {
    async accessToken() {
      // The first load is shared too, so a slow read can't overwrite a token
      // another caller has already refreshed. A failed load is not cached.
      loading ??= load().catch((err) => {
        loading = null;
        throw err;
      });
      token ??= await loading;
      if (Date.now() >= token.expires_at - skewMs) {
        pending ??= (async () => {
          const next = await refresh(token);
          // Use the new token even if saving it fails: for a provider that
          // rotates refresh tokens, the old one is already spent.
          token = next;
          await save(next);
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
  // The token endpoint can answer 200 with {"error": ...}. Saving that would
  // leave an undefined token and a NaN expiry that never triggers a refresh.
  if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) {
    throw new Error(`Reddit token refresh failed: ${data.error ?? 'no access_token in the response'}`);
  }
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
  save: saveToken,
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
