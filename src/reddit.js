import { z } from 'zod';
import { redditFetch } from './auth.js';

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// Reddit "fullname" ids are prefixed by type: t1_ comment, t3_ link/post, t4_ message, t2_ user.
function withKindPrefix(id, prefix) {
  return id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
}

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
        query: z.string(),
        subreddit: z.string().optional().describe('Restrict search to this subreddit (without r/)'),
        sort: z.enum(['relevance', 'hot', 'top', 'new', 'comments']).optional(),
        time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
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
        subreddit: z.string(),
        feed: z.enum(['hot', 'new', 'top', 'rising']).optional(),
        time: z.enum(['hour', 'day', 'week', 'month', 'year', 'all']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
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
      inputSchema: { subreddit: z.string(), postId: z.string(), commentSort: z.enum(['best', 'top', 'new', 'controversial', 'old']).optional() },
    },
    async ({ subreddit, postId, commentSort }) =>
      json(await redditFetch(`/r/${subreddit}/comments/${postId.replace(/^t3_/, '')}`, { query: { sort: commentSort } }))
  );

  server.registerTool(
    'reddit_get_user',
    {
      title: 'Get a Reddit user profile',
      description: "Public profile info (karma, trophies, account age) for a username.",
      inputSchema: { username: z.string() },
    },
    async ({ username }) => json(await redditFetch(`/user/${encodeURIComponent(username)}/about`))
  );

  server.registerTool(
    'reddit_get_user_activity',
    {
      title: 'Get a user\'s posts or comments',
      description: "List a user's submitted posts, comments, or both (overview).",
      inputSchema: {
        username: z.string(),
        kind: z.enum(['submitted', 'comments', 'overview']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
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
        subreddit: z.string(),
        title: z.string(),
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
      inputSchema: { parentId: z.string().describe('Fullname of the post (t3_...) or comment (t1_...) being replied to'), text: z.string() },
    },
    async ({ parentId, text }) =>
      json(await redditFetch('/api/comment', { method: 'POST', body: { thing_id: parentId, text, api_type: 'json' } }))
  );

  server.registerTool(
    'reddit_vote',
    {
      title: 'Vote on a post or comment',
      description: 'Casts an upvote, downvote, or clears a vote immediately.',
      inputSchema: { id: z.string().describe('Fullname (t1_ comment or t3_ post)'), direction: z.enum(['up', 'down', 'clear']) },
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
        filter: z.enum(['inbox', 'unread', 'messages', 'comments', 'sent']).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ filter = 'inbox', limit }) => json(await redditFetch(`/message/${filter}`, { query: { limit: limit ?? 25 } }))
  );

  server.registerTool(
    'reddit_send_message',
    {
      title: 'Send a private message',
      description: 'Sends a real private message to a user immediately. No confirmation step.',
      inputSchema: { to: z.string(), subject: z.string(), text: z.string() },
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
