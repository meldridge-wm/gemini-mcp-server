#!/usr/bin/env node

/**
 * Gemini MCP Server
 * Exposes Gemini (via the authenticated gemini CLI) as a tool for Claude Code.
 * Uses the user's existing OAuth session — no API key needed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const GEMINI_PATH = process.env.GEMINI_PATH || 'gemini';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

const server = new Server(
  { name: 'gemini', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'gemini',
      description:
        'Ask Gemini (Google\'s AI) a question. Use this for creative brainstorming, ' +
        'second opinions on architecture, generating alternative implementations, ' +
        'or when you want a different perspective. Gemini 2.5 Pro is used by default. ' +
        'You can also use gemini-2.5-flash for faster/cheaper queries.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt to send to Gemini'
          },
          model: {
            type: 'string',
            description: 'Model to use: gemini-2.5-pro (default, best quality) or gemini-2.5-flash (faster)',
            enum: ['gemini-2.5-pro', 'gemini-2.5-flash'],
            default: 'gemini-2.5-pro'
          },
          context: {
            type: 'string',
            description: 'Optional file contents or code context to include with the prompt'
          }
        },
        required: ['prompt']
      }
    }
  ]
}));

server.setRequestHandler('tools/call', async (request) => {
  if (request.params.name !== 'gemini') {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }

  const { prompt, model, context } = request.params.arguments;
  const selectedModel = model || DEFAULT_MODEL;

  let fullPrompt = prompt;
  if (context) {
    fullPrompt = `Context:\n${context}\n\n${prompt}`;
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      GEMINI_PATH,
      ['-p', fullPrompt, '-m', selectedModel, '-o', 'json'],
      {
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' }
      }
    );

    // Parse JSON output to extract the response
    let response;
    try {
      const jsonOutput = JSON.parse(stdout);
      response = jsonOutput.response || stdout;
    } catch {
      // If JSON parsing fails, try to extract response from raw output
      const match = stdout.match(/"response"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      response = match ? JSON.parse(`"${match[1]}"`) : stdout;
    }

    // Clean up stderr noise (loaded credentials, extension loading, etc.)
    const warnings = stderr
      ? stderr.split('\n').filter(l => !l.includes('Loaded cached') && !l.includes('Loading extension') && !l.includes('Hook registry') && l.trim()).join('\n')
      : '';

    const text = warnings
      ? `[Gemini ${selectedModel}]\n${response}\n\n[warnings: ${warnings}]`
      : `[Gemini ${selectedModel}]\n${response}`;

    return { content: [{ type: 'text', text }] };

  } catch (err) {
    const msg = err.stderr || err.message || String(err);
    return {
      content: [{ type: 'text', text: `Gemini error (${selectedModel}): ${msg}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
