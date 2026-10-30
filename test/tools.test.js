import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { assertAccepted, registerRedditTools, subredditName, toFullname, username } from '../src/reddit.js';
import { USER_AGENT, API_BASE, TOKEN_ENDPOINT, createTokenStore } from '../src/auth.js';
import { REQUEST_TIMEOUT_MS, VERSION, fetchWithTimeout, responseError } from '../src/shared.js';

const authModule = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'auth.js'
);

function collectTools() {
  const tools = new Map();
  registerRedditTools({
    registerTool(name, config, handler) {
      tools.set(name, { name, config, handler });
    },
  });
  return tools;
}

/** Read USER_AGENT from a fresh process so module-load-time env is honoured. */
function userAgentWith(env) {
  // Must be a file:// URL: on Windows a bare drive path makes the ESM loader
  // read "C:" as an unsupported protocol.
  const script = `import('${pathToFileURL(authModule).href}').then(m => console.log(m.USER_AGENT))`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
  }).trim();
}

test('registers all twelve Reddit tools', () => {
  assert.equal(collectTools().size, 12);
});

test('tool names are unique and namespaced with reddit_', () => {
  const names = [...collectTools().keys()];
  assert.equal(new Set(names).size, names.length, 'duplicate tool name');
  for (const name of names) {
    assert.match(name, /^reddit_[a-z0-9_]+$/, `"${name}" is not namespaced`);
  }
});

test('every tool declares a title, description and input schema', () => {
  for (const { name, config } of collectTools().values()) {
    assert.ok(config.title?.trim(), `${name} has no title`);
    assert.ok(config.description?.trim(), `${name} has no description`);
    assert.ok(config.inputSchema, `${name} has no inputSchema`);
  }
});

// These post publicly under the account's real identity. The description is all
// the model sees before calling one.
test('tools that write to Reddit say so in their descriptions', () => {
  const tools = collectTools();
  for (const name of ['reddit_submit_post', 'reddit_submit_comment', 'reddit_send_message']) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} is not registered`);
    assert.match(
      tool.config.description,
      /public|post|comment|message|visible|immediat/i,
      `${name} does not describe its external effect`
    );
  }
});

test('the API base is the OAuth host, not the cookie-authed www host', () => {
  // oauth.reddit.com is the only host that accepts bearer tokens; www.reddit.com
  // silently returns logged-out content instead of failing.
  assert.equal(API_BASE, 'https://oauth.reddit.com');
  assert.match(TOKEN_ENDPOINT, /^https:\/\/www\.reddit\.com\//);
});

test('the default User-Agent follows Reddit\'s platform:app:version format', () => {
  assert.match(USER_AGENT, /^[a-z0-9]+:[a-z0-9-]+:v\d+\.\d+\.\d+ \(by \/u\/.+\)$/);
  assert.ok(USER_AGENT.includes(`:v${VERSION} `), 'User-Agent does not carry the package version');
});

test('REDDIT_USERNAME is substituted into the User-Agent', () => {
  const ua = userAgentWith({ REDDIT_USERNAME: 'someuser', REDDIT_USER_AGENT: '' });
  assert.match(ua, /by \/u\/someuser/);
  assert.doesNotMatch(ua, /<reddit-username>/);
});

test('REDDIT_USER_AGENT overrides the whole string', () => {
  const ua = userAgentWith({ REDDIT_USER_AGENT: 'custom:agent:v9.9.9 (by /u/x)' });
  assert.equal(ua, 'custom:agent:v9.9.9 (by /u/x)');
});

// Reddit addresses objects by "fullname": a type prefix plus the base36 id.
// Its write endpoints answer a wrong-typed id with a 200 and do nothing, so a
// mismatch has to be caught before the request is sent.
test('toFullname prefixes a bare id when the call has an obvious kind', () => {
  assert.equal(toFullname('abc123', ['t3'], { bareKind: 't3' }), 't3_abc123');
  assert.equal(toFullname('XYZ', ['t4', 't1'], { bareKind: 't4' }), 't4_xyz');
});

test('toFullname keeps an accepted fullname as it is', () => {
  assert.equal(toFullname('t3_abc123', ['t3', 't1']), 't3_abc123');
  assert.equal(toFullname('t1_xyz', ['t4', 't1'], { bareKind: 't4' }), 't1_xyz');
});

test('toFullname refuses an id of the wrong kind instead of mangling it', () => {
  // This used to produce "t3_t1_abc", which the API accepts and ignores.
  assert.throws(() => toFullname('t1_abc', ['t3']), /comment id; this call needs a post \(t3_\) id/);
  assert.throws(() => toFullname('t4_abc', ['t3', 't1']), /message id/);
});

test('toFullname refuses a bare id when the kind would be a guess', () => {
  assert.throws(() => toFullname('abc', ['t3', 't1']), /ambiguous: include the type prefix \(t3_ or t1_\)/);
});

test('toFullname refuses anything that is not an id at all', () => {
  for (const id of ['', '../me', 't3_', 'abc def', 't9_abc']) {
    assert.throws(() => toFullname(id, ['t3'], { bareKind: 't3' }), /not a Reddit id/, JSON.stringify(id));
  }
});

// ---------------------------------------------------------------------------
// Path segments. Subreddit names and usernames are interpolated into the URL
// path, and URL resolution collapses "..", so an unchecked value walks out of
// /r/ or /user/ into any endpoint, carrying the account's bearer token.

test('a subreddit name that would traverse the path is refused', () => {
  assert.equal(new URL(`${API_BASE}/r/../api/v1/me/hot`).pathname, '/api/v1/me/hot', 'precondition: URL collapses ..');
  for (const name of ['../api/v1/me', 'mcp/../../api', 'mcp?x=1', 'a b', '']) {
    assert.throws(() => subredditName(name), /is not a subreddit name/, JSON.stringify(name));
  }
});

test('subreddit names tolerate the r/ prefix and allow a+b multireddits', () => {
  assert.equal(subredditName('mcp'), 'mcp');
  assert.equal(subredditName('r/mcp'), 'mcp');
  assert.equal(subredditName('/r/mcp'), 'mcp');
  assert.equal(subredditName('pics+AskReddit'), 'pics+AskReddit');
});

test('subreddit names accept profile subreddits, exclusions and pasted links', () => {
  assert.equal(subredditName(`u_${'a'.repeat(20)}`), `u_${'a'.repeat(20)}`);
  assert.equal(subredditName('all-politics-news'), 'all-politics-news');
  assert.equal(subredditName('r/mcp/'), 'mcp');
  assert.equal(subredditName('https://www.reddit.com/r/mcp/'), 'mcp');
  for (const name of ['mcp-x', 'all-../api', 'https://evil.example/r/mcp', 'https://www.reddit.com/../api']) {
    assert.throws(() => subredditName(name), /is not a subreddit name/, name);
  }
});

test('a username that would traverse the path is refused', () => {
  // encodeURIComponent, which this used to rely on, leaves ".." untouched.
  assert.equal(encodeURIComponent('..'), '..');
  for (const name of ['..', '../api', 'a/b', 'spez?x']) {
    assert.throws(() => username(name), /is not a Reddit username/, JSON.stringify(name));
  }
  assert.equal(username('u/spez'), 'spez');
  assert.equal(username('/user/spez/'), 'spez');
  assert.equal(username('https://old.reddit.com/user/spez'), 'spez');
});

test('tools reject a hostile path segment before any request is made', async () => {
  const tools = collectTools();
  const calls = [
    ['reddit_get_subreddit_posts', { subreddit: '../api/v1/me' }],
    ['reddit_search', { query: 'x', subreddit: '../message/inbox' }],
    ['reddit_get_post', { subreddit: 'mcp', postId: '../../api/v1/me' }],
    ['reddit_get_user', { username: '..' }],
    ['reddit_get_user_activity', { username: '../api' }],
    ['reddit_vote', { id: 'abc', direction: 'up' }],
  ];
  // No credentials exist in CI, so reaching the network would fail with a
  // "No token found" error instead of the validation error asserted here.
  for (const [name, args] of calls) {
    await assert.rejects(() => tools.get(name).handler(args), /not a|ambiguous/, name);
  }
});

// ---------------------------------------------------------------------------
// Rejections Reddit reports as success.

test('a 200 carrying json.errors becomes an error naming Reddit\'s reasons', () => {
  const body = { json: { errors: [['SUBREDDIT_NOEXIST', "that subreddit doesn't exist", 'sr'], ['RATELIMIT', 'take a break', 'ratelimit']] } };
  assert.throws(
    () => assertAccepted(body, 'post'),
    /Reddit rejected the post: SUBREDDIT_NOEXIST: that subreddit doesn't exist; RATELIMIT: take a break/
  );
});

test('an accepted api_type=json response is passed through', () => {
  const body = { json: { errors: [], data: { url: 'https://reddit.com/r/mcp/comments/abc' } } };
  assert.equal(assertAccepted(body, 'post'), body);
  assert.deepEqual(assertAccepted({}, 'vote'), {});
});

// ---------------------------------------------------------------------------
// Token refresh.

function expiredToken() {
  return { access_token: 'old', refresh_token: 'r1', expires_at: Date.now() - 1000 };
}

test('parallel calls at expiry share a single refresh', async () => {
  let refreshes = 0;
  const saved = [];
  const store = createTokenStore({
    load: async () => expiredToken(),
    save: async (t) => saved.push(t),
    refresh: async (t) => {
      refreshes += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { access_token: 'new', refresh_token: t.refresh_token, expires_at: Date.now() + 3_600_000 };
    },
  });

  const results = await Promise.all([store.accessToken(), store.accessToken(), store.accessToken()]);
  assert.deepEqual(results, ['new', 'new', 'new']);
  assert.equal(refreshes, 1);
  assert.equal(saved.length, 1);
});

test('a token that is not near expiry is used without refreshing', async () => {
  const store = createTokenStore({
    load: async () => ({ access_token: 'fresh', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }),
    save: async () => assert.fail('nothing to save'),
    refresh: async () => assert.fail('should not refresh'),
  });
  assert.equal(await store.accessToken(), 'fresh');
});

test('a refreshed token is kept in memory even when saving it fails', async () => {
  let refreshes = 0;
  const store = createTokenStore({
    load: async () => expiredToken(),
    save: async () => {
      throw new Error('EACCES');
    },
    refresh: async () => ({ access_token: `a${++refreshes}`, refresh_token: 'r', expires_at: Date.now() + 3_600_000 }),
  });
  await assert.rejects(store.accessToken(), /EACCES/);
  assert.equal(await store.accessToken(), 'a1');
  assert.equal(refreshes, 1);
});

test('a failed refresh is retried on the next call rather than cached', async () => {
  let attempt = 0;
  const store = createTokenStore({
    load: async () => expiredToken(),
    save: async () => {},
    refresh: async (t) => {
      attempt += 1;
      if (attempt === 1) throw new Error('network down');
      return { access_token: 'new', refresh_token: t.refresh_token, expires_at: Date.now() + 3_600_000 };
    },
  });
  await assert.rejects(() => store.accessToken(), /network down/);
  assert.equal(await store.accessToken(), 'new');
});

// ---------------------------------------------------------------------------
// Failure messages.

test('a 429 says how long Reddit asked us to wait', async () => {
  const res = new Response('Too Many Requests', { status: 429, headers: { 'x-ratelimit-reset': '42' } });
  const err = await responseError(res, 'Reddit API', '/r/mcp/hot');
  assert.match(err.message, /rate limit reached for \/r\/mcp\/hot; retry after 42s/);
});

test('an error body is bounded, so an HTML error page cannot flood the context', async () => {
  const res = new Response(`<html>${'x'.repeat(50_000)}</html>`, { status: 502 });
  const err = await responseError(res, 'Reddit API', '/api/v1/me');
  assert.match(err.message, /^Reddit API error 502 for \/api\/v1\/me: /);
  assert.ok(err.message.length < 700, `message is ${err.message.length} chars`);
});

test('every request carries a timeout, and a timeout reads as one', async () => {
  const original = globalThis.fetch;
  try {
    let signal;
    globalThis.fetch = async (_url, init) => {
      signal = init.signal;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    };
    await assert.rejects(
      () => fetchWithTimeout('https://oauth.reddit.com/api/v1/me', {}, 'Reddit API'),
      new RegExp(`Reddit API did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`)
    );
    assert.ok(signal instanceof AbortSignal, 'no abort signal was passed to fetch');
  } finally {
    globalThis.fetch = original;
  }
});
