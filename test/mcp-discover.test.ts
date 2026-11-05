// The first request of a recorded handshake: `server/discover`, then the tools list.
// No client is started. The line is the request, and `handleLine` is the server's answer.
import { describe, expect, test } from 'bun:test';
import { handleLine } from '../src/mcp/serve.ts';

const serving = {
  project: 'acme',
  seat: 'seat',
  session: 'acme',
  root: '/fixture',
  dropDir: '/fixture/drops',
  home: '/fixture/home',
  team: {},
  channel: false,
} as Parameters<typeof handleLine>[1];

const DISCOVER = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' });
const LIST = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

describe('server/discover', () => {
  test('a recorded discover request is method-not-found, and the tools list is the next line', () => {
    expect(JSON.parse(handleLine(DISCOVER, serving) ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    });
    const listed = JSON.parse(handleLine(LIST, serving) ?? '') as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(['inbox_check', 'inbox_read']);
  });
});
