import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

import { registerRedditTools, withKindPrefix } from '../src/reddit.js';
import { USER_AGENT, API_BASE, TOKEN_ENDPOINT } from '../src/auth.js';

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
  assert.match(USER_AGENT, /^[a-z]+:[a-z0-9-]+:v\d+\.\d+\.\d+ \(by \/u\/.+\)$/);
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
// Passing a bare id to /api/vote silently does nothing rather than erroring.
test('withKindPrefix adds the type prefix when it is absent', () => {
  assert.equal(withKindPrefix('abc123', 't3'), 't3_abc123');
  assert.equal(withKindPrefix('xyz', 't1'), 't1_xyz');
});

test('withKindPrefix leaves an already-prefixed fullname alone', () => {
  assert.equal(withKindPrefix('t3_abc123', 't3'), 't3_abc123');
  assert.equal(withKindPrefix('t1_xyz', 't1'), 't1_xyz');
});

test('withKindPrefix does not confuse a different type prefix for its own', () => {
  // A comment id handed to a post-shaped call must still be prefixed t3_,
  // producing an id the API rejects, rather than being silently accepted.
  assert.equal(withKindPrefix('t1_abc', 't3'), 't3_t1_abc');
});
