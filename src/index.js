#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRedditTools } from './reddit.js';
import { VERSION } from './shared.js';

const server = new McpServer({ name: 'reddit', version: VERSION });

registerRedditTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
