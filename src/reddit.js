import { z } from 'zod';
import { redditFetch } from './auth.js';

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Reddit "fullname" ids are prefixed by type: t1_ comment, t3_ link/post, t4_ message, t2_ user.
export function withKindPrefix(id, prefix) {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
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
    { title: 'Get authorized Reddit account', description: 'Profile of the Reddit account this server is authorized as.', inputSchema: {} },
    async () => json(await redditFetch('/api/v1/me'))
  );

  server.registerTool(
    'reddit_search',
    {
      title: 'Search Reddit',
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
        await redditFetch(subreddit ? `/r/${subreddit}/search` : '/search', {
          query: { q: query, sort, t: time, limit: limit ?? 25, restrict_sr: subreddit ? 'true' : undefined },
        })
      )
  );

  server.registerTool(
    'reddit_get_subreddit_posts',
    {
      title: 'Get subreddit posts',
      description: 'List posts from a subreddit feed (hot, new, top, rising).',
      inputSchema: {
        subreddit: SUBREDDIT,
        feed: z.enum(['hot', 'new', 'top', 'rising']).optional().describe('Which feed to read. Defaults to "hot".'),
        time: TIME,
        limit: LIMIT,
      },
    },
    async ({ subreddit, feed = 'hot', time, limit }) =>
      json(await redditFetch(`/r/${subreddit}/${feed}`, { query: { t: time, limit: limit ?? 25 } }))
  );

  server.registerTool(
    'reddit_get_post',
    {
      title: 'Get a post with comments',
      description: 'Fetch a post (submission) and its comment tree by post id (t3_... or bare id) or subreddit+id.',
      inputSchema: {
        subreddit: SUBREDDIT,
        postId: z
          .string()
          .describe('Post id, either bare (e.g. "1abc2de") or the t3_-prefixed fullname. The t3_ prefix is stripped automatically.'),
        commentSort: z.enum(['best', 'top', 'new', 'controversial', 'old']).optional().describe('Ordering of the comment tree. Defaults to "best".'),
      },
    },
    async ({ subreddit, postId, commentSort }) =>
      json(await redditFetch(`/r/${subreddit}/comments/${postId.replace(/^t3_/, '')}`, { query: { sort: commentSort } }))
  );

  server.registerTool(
    'reddit_get_user',
    {
      title: 'Get a Reddit user profile',
      description: "Public profile info (karma, trophies, account age) for a username.",
      inputSchema: { username: USERNAME },
    },
    async ({ username }) => json(await redditFetch(`/user/${encodeURIComponent(username)}/about`))
  );

  server.registerTool(
    'reddit_get_user_activity',
    {
      title: 'Get a user\'s posts or comments',
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
    async ({ username, kind = 'overview', limit }) =>
      json(await redditFetch(`/user/${encodeURIComponent(username)}/${kind}`, { query: { limit: limit ?? 25 } }))
  );

  server.registerTool(
    'reddit_submit_post',
    {
      title: 'Submit a post',
      description: 'Creates a real post in a subreddit immediately. No confirmation step.',
      inputSchema: {
        subreddit: SUBREDDIT,
        title: z.string().describe('Post title, max 300 characters. Cannot be edited after submission.'),
        text: z.string().optional().describe('Self-post body (markdown). Omit if using url.'),
        url: z.string().url().optional().describe('Link-post URL. Omit if using text.'),
      },
    },
    async ({ subreddit, title, text, url }) =>
      json(
        await redditFetch('/api/submit', {
          method: 'POST',
          body: {
            sr: subreddit,
            title,
            kind: url ? 'link' : 'self',
            text: text ?? '',
            url: url ?? '',
            api_type: 'json',
          },
        })
      )
  );

  server.registerTool(
    'reddit_submit_comment',
    {
      title: 'Submit a comment / reply',
      description: 'Posts a real comment reply to a post or comment immediately. No confirmation step.',
      inputSchema: {
        parentId: z.string().describe('Fullname of the post (t3_...) or comment (t1_...) being replied to. The type prefix is required here.'),
        text: z.string().describe('Comment body in markdown.'),
      },
    },
    async ({ parentId, text }) =>
      json(await redditFetch('/api/comment', { method: 'POST', body: { thing_id: parentId, text, api_type: 'json' } }))
  );

  server.registerTool(
    'reddit_vote',
    {
      title: 'Vote on a post or comment',
      description: 'Casts an upvote, downvote, or clears a vote immediately.',
      inputSchema: {
        id: z.string().describe('Fullname (t1_ comment or t3_ post). The type prefix is required here.'),
        direction: z.enum(['up', 'down', 'clear']).describe('"up" to upvote, "down" to downvote, "clear" to remove an existing vote.'),
      },
    },
    async ({ id, direction }) => {
      const dir = direction === 'up' ? '1' : direction === 'down' ? '-1' : '0';
      await redditFetch('/api/vote', { method: 'POST', body: { id, dir } });
      return { content: [{ type: 'text', text: `Voted ${direction} on ${id}` }] };
    }
  );

  server.registerTool(
    'reddit_get_inbox',
    {
      title: 'Read private messages / inbox',
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
      description: 'Sends a real private message to a user immediately. No confirmation step.',
      inputSchema: {
        to: z.string().describe('Recipient username without the "u/" prefix, or "/r/<subreddit>" to message a subreddit\'s moderators.'),
        subject: z.string().describe('Message subject, max 100 characters.'),
        text: z.string().describe('Message body in markdown.'),
      },
    },
    async ({ to, subject, text }) =>
      json(await redditFetch('/api/compose', { method: 'POST', body: { to, subject, text, api_type: 'json' } }))
  );

  server.registerTool(
    'reddit_mark_read',
    {
      title: 'Mark inbox messages read',
      description: 'Marks one or more inbox items as read.',
      inputSchema: { ids: z.array(z.string()).describe('Fullnames, e.g. t4_... for messages') },
    },
    async ({ ids }) => {
      await redditFetch('/api/read_message', { method: 'POST', body: { id: ids.map((id) => withKindPrefix(id, 't4')).join(',') } });
      return { content: [{ type: 'text', text: `Marked ${ids.length} item(s) read` }] };
    }
  );
}
