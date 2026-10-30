import { readFileSync } from 'node:fs';

/**
 * The installed package version. The server reports it in `initialize` and the
 * User-Agent carries it, so it is read from package.json rather than written as
 * a literal that drifts.
 */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Upper bound on any single upstream request. Without one, a stalled
 * connection holds the tool call open until the client gives up, and the model
 * learns nothing about why.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A tool result carrying JSON. Compact rather than indented: the text goes
 * straight into the model's context, where indentation is pure token cost.
 */
export function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** A tool result carrying a short confirmation message. */
export function text(message) {
  return { content: [{ type: 'text', text: message }] };
}

/** `fetch` with a timeout, and a readable error when the timeout is what failed. */
export async function fetchWithTimeout(url, init, label) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new Error(`${label} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s.`, { cause: err });
    }
    throw err;
  }
}

/**
 * Turn a failed response into an error a model can act on: the status, a
 * bounded slice of the body (an HTML error page can run to hundreds of
 * kilobytes, all of it landing in the model's context), and — when rate
 * limited — how long the upstream asked us to wait.
 */
export async function responseError(res, label, pathname) {
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  const detail = body.length > 500 ? `${body.slice(0, 500)}…` : body;

  if (res.status === 429) {
    const wait = res.headers?.get('retry-after') ?? res.headers?.get('x-ratelimit-reset');
    return new Error(
      `${label} rate limit reached for ${pathname}${wait ? `; retry after ${wait}s` : ''}.${detail ? ` ${detail}` : ''}`
    );
  }
  return new Error(`${label} error ${res.status} for ${pathname}${detail ? `: ${detail}` : ''}`);
}
