#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRedditTools } from './reddit.js';

const server = new McpServer({ name: 'reddit', version: '1.0.0' });

registerRedditTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
