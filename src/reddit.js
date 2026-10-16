import { z } from 'zod';
import { redditFetch } from './auth.js';
import { json, text } from './shared.js';

const KIND_NAMES = { t1: 'comment', t2: 'account', t3: 'post', t4: 'message', t5: 'subreddit' };

/**
 * Normalise an id to a Reddit "fullname": a type prefix plus the base36 id.
 *
 * `kinds` lists the types this call accepts. A fullname of any other type is
 * refused — Reddit's write endpoints answer a wrong-typed id with a quiet 200
 * and do nothing, so the error has to come from here. A bare id is given
 * `bareKind` when the call has an obvious default, and refused as ambiguous
 * when it doesn't.
 */
export function toFullname(id, kinds, { bareKind } = {}) {
  const prefixed = id.match(/^(t[1-5])_([a-z0-9]+)$/i);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    if (!kinds.includes(kind)) {
      const wanted = kinds.map((k) => `${KIND_NAMES[k]} (${k}_)`).join(' or ');
      throw new Error(`"${id}" is a ${KIND_NAMES[kind]} id; this call needs a ${wanted} id.`);
    }
    return `${kind}_${prefixed[2].toLowerCase()}`;
  }
  if (/^[a-z0-9]+$/i.test(id)) {
    if (!bareKind) {
      throw new Error(`"${id}" is ambiguous: include the type prefix (${kinds.map((k) => `${k}_`).join(' or ')}).`);
    }
    return `${bareKind}_${id.toLowerCase()}`;
  }
  throw new Error(`"${id}" is not a Reddit id.`);
}

/**
 * Validate a subreddit name for use in a URL path, tolerating the "r/" prefix
 * Reddit's own docs use everywhere. Names are interpolated into the path, and
 * an unchecked "../api/v1/me" would walk out of /r/ to another endpoint with
 * the account's bearer token attached. "a+b" multireddit syntax is allowed.
 */
export function subredditName(name) {
  const bare = name.replace(/^\/?r\//i, '');
  if (!bare.split('+').every((part) => /^[A-Za-z0-9_]{1,21}$/.test(part))) {
    throw new Error(`"${name}" is not a subreddit name. Use letters, digits and underscores, e.g. "mcp".`);
  }
  return bare;
}

/** Validate a username for use in a URL path, tolerating the "u/" prefix. */
export function username(name) {
  const bare = name.replace(/^\/?u\//i, '');
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(bare)) {
    throw new Error(`"${name}" is not a Reddit username.`);
  }
  return bare;
}

/**
 * Reddit reports the failure of an api_type=json call as HTTP 200 with the
 * reasons in json.errors — a misspelt subreddit, a rate limit, a locked
 * thread. Passing that body through would let the model announce a post that
 * was never made.
 */
export function assertAccepted(data, action) {
  const errors = data?.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const reasons = errors.map((e) => (Array.isArray(e) ? e.slice(0, 2).join(': ') : String(e)));
    throw new Error(`Reddit rejected the ${action}: ${reasons.join('; ')}`);
  }
  return data;
}

// Reddit's own docs use "r/name" everywhere, so a caller passing the prefix is
// the predictable mistake — every path here interpolates the bare name.
const SUBREDDIT = z.string().describe('Subreddit name without the "r/" prefix, e.g. "mcp".');
const USERNAME = z.string().describe('Reddit username without the "u/" prefix, e.g. "spez".');
const LIMIT = z.number().int().min(1).max(100).optional().describe('Maximum items to return, 1-100. Defaults to 25.');
const TIME = z
  .enum(['hour', 'day', 'week', 'month', 'year', 'all'])
  .optional()
  .describe('Time window to restrict results to. Only affects "top" and "controversial" sorting.');

export function registerRedditTools(server) {
  server.registerTool(
    'reddit_get_me',
    {
      title: 'Get authorized Reddit account',
      description: 'Profile of the Reddit account this server is authorized as.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => json(await redditFetch('/api/v1/me'))
  );

  server.registerTool(
    'reddit_search',
    {
      title: 'Search Reddit',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Search posts across Reddit or within a specific subreddit.',
      inputSchema: {
        query: z.string().describe('Search terms. Supports Reddit search syntax such as author:name or flair:"text".'),
        subreddit: z.string().optional().describe('Restrict search to this subreddit, name only without the "r/" prefix. Omit to search all of Reddit.'),
        sort: z.enum(['relevance', 'hot', 'top', 'new', 'comments']).optional().describe('Result ordering. Defaults to relevance.'),
        time: TIME,
        limit: LIMIT,
      },
    },
    async ({ query, subreddit, sort, time, limit }) =>
      json(
        await redditFetch(subreddit ? `/r/${subredditName(subreddit)}/search` : '/search', {
          query: { q: query, sort, t: time, limit: limit ?? 25, restrict_sr: subreddit ? 'true' : undefined },
        })
      )
  );

  server.registerTool(
    'reddit_get_subreddit_posts',
    {
      title: 'Get subreddit posts',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'List posts from a subreddit feed (hot, new, top, rising).',
      inputSchema: {
        subreddit: SUBREDDIT,
        feed: z.enum(['hot', 'new', 'top', 'rising']).optional().describe('Which feed to read. Defaults to "hot".'),
        time: TIME,
        limit: LIMIT,
      },
    },
    async ({ subreddit, feed = 'hot', time, limit }) =>
      json(await redditFetch(`/r/${subredditName(subreddit)}/${feed}`, { query: { t: time, limit: limit ?? 25 } }))
  );

  server.registerTool(
    'reddit_get_post',
    {
      title: 'Get a post with comments',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Fetch a post (submission) and its comment tree by post id (t3_... or bare id) or subreddit+id.',
      inputSchema: {
        subreddit: SUBREDDIT,
        postId: z
          .string()
          .describe('Post id, either bare (e.g. "1abc2de") or the t3_-prefixed fullname. The t3_ prefix is stripped automatically.'),
        commentSort: z.enum(['best', 'top', 'new', 'controversial', 'old']).optional().describe('Ordering of the comment tree. Defaults to "best".'),
      },
    },
    async ({ subreddit, postId, commentSort }) => {
      const id = toFullname(postId, ['t3'], { bareKind: 't3' }).slice('t3_'.length);
      return json(await redditFetch(`/r/${subredditName(subreddit)}/comments/${id}`, { query: { sort: commentSort } }));
    }
  );

  server.registerTool(
    'reddit_get_user',
    {
      title: 'Get a Reddit user profile',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: "Public profile info (karma, trophies, account age) for a username.",
      inputSchema: { username: USERNAME },
    },
    async (args) => json(await redditFetch(`/user/${username(args.username)}/about`))
  );

  server.registerTool(
    'reddit_get_user_activity',
    {
      title: 'Get a user\'s posts or comments',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: "List a user's submitted posts, comments, or both (overview).",
      inputSchema: {
        username: USERNAME,
        kind: z
          .enum(['submitted', 'comments', 'overview'])
          .optional()
          .describe('Which activity to list: "submitted" for posts only, "comments" for comments only, "overview" for both. Defaults to "overview".'),
        limit: LIMIT,
      },
    },
    async ({ kind = 'overview', limit, ...args }) =>
      json(await redditFetch(`/user/${username(args.username)}/${kind}`, { query: { limit: limit ?? 25 } }))
  );

  server.registerTool(
    'reddit_submit_post',
    {
      title: 'Submit a post',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Creates a real post in a subreddit immediately. No confirmation step.',
      inputSchema: {
        subreddit: SUBREDDIT,
        title: z.string().describe('Post title, max 300 characters. Cannot be edited after submission.'),
        text: z.string().optional().describe('Self-post body (markdown). Omit if using url.'),
        url: z.string().url().optional().describe('Link-post URL. Omit if using text.'),
      },
    },
    async ({ subreddit, title, text: body, url }) => {
      const data = await redditFetch('/api/submit', {
        method: 'POST',
        body: {
          sr: subredditName(subreddit),
          title,
          kind: url ? 'link' : 'self',
          text: body ?? '',
          url: url ?? '',
          api_type: 'json',
        },
      });
      return json(assertAccepted(data, 'post'));
    }
  );

  server.registerTool(
    'reddit_submit_comment',
    {
      title: 'Submit a comment / reply',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Posts a real comment reply to a post or comment immediately. No confirmation step.',
      inputSchema: {
        parentId: z.string().describe('Fullname of the post (t3_...) or comment (t1_...) being replied to. The type prefix is required here.'),
        text: z.string().describe('Comment body in markdown.'),
      },
    },
    async ({ parentId, text: body }) => {
      const data = await redditFetch('/api/comment', {
        method: 'POST',
        body: { thing_id: toFullname(parentId, ['t3', 't1']), text: body, api_type: 'json' },
      });
      return json(assertAccepted(data, 'comment'));
    }
  );

  server.registerTool(
    'reddit_vote',
    {
      title: 'Vote on a post or comment',
      // Idempotent: re-sending the same direction leaves the vote as it is.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'Casts an upvote, downvote, or clears a vote immediately.',
      inputSchema: {
        id: z.string().describe('Fullname (t1_ comment or t3_ post). The type prefix is required here.'),
        direction: z.enum(['up', 'down', 'clear']).describe('"up" to upvote, "down" to downvote, "clear" to remove an existing vote.'),
      },
    },
    async ({ id, direction }) => {
      const fullname = toFullname(id, ['t3', 't1']);
      const dir = direction === 'up' ? '1' : direction === 'down' ? '-1' : '0';
      await redditFetch('/api/vote', { method: 'POST', body: { id: fullname, dir } });
      return text(`Voted ${direction} on ${fullname}`);
    }
  );

  server.registerTool(
    'reddit_get_inbox',
    {
      title: 'Read private messages / inbox',
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: 'Lists inbox items: private messages, comment replies, and mentions.',
      inputSchema: {
        filter: z
          .enum(['inbox', 'unread', 'messages', 'comments', 'sent'])
          .optional()
          .describe('Which inbox view to read. Defaults to "inbox" (everything).'),
        limit: LIMIT,
      },
    },
    async ({ filter = 'inbox', limit }) => json(await redditFetch(`/message/${filter}`, { query: { limit: limit ?? 25 } }))
  );

  server.registerTool(
    'reddit_send_message',
    {
      title: 'Send a private message',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description: 'Sends a real private message to a user immediately. No confirmation step.',
      inputSchema: {
        to: z.string().describe('Recipient username without the "u/" prefix, or "/r/<subreddit>" to message a subreddit\'s moderators.'),
        subject: z.string().describe('Message subject, max 100 characters.'),
        text: z.string().describe('Message body in markdown.'),
      },
    },
    async ({ to, subject, text: body }) => {
      const data = await redditFetch('/api/compose', { method: 'POST', body: { to, subject, text: body, api_type: 'json' } });
      return json(assertAccepted(data, 'message'));
    }
  );

  server.registerTool(
    'reddit_mark_read',
    {
      title: 'Mark inbox messages read',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: 'Marks one or more inbox items as read.',
      inputSchema: {
        ids: z
          .array(z.string())
          .min(1)
          .describe('Inbox item fullnames from reddit_get_inbox: t4_ for private messages, t1_ for comment replies and mentions. A bare id is treated as a message.'),
      },
    },
    async ({ ids }) => {
      // Comment replies sit in the inbox as t1_ items. These used to be
      // rewritten to "t4_t1_…", which Reddit ignores without complaint.
      const fullnames = ids.map((id) => toFullname(id, ['t4', 't1'], { bareKind: 't4' }));
      await redditFetch('/api/read_message', { method: 'POST', body: { id: fullnames.join(',') } });
      return text(`Marked ${fullnames.length} item(s) read`);
    }
  );
}
