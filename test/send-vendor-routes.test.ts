// Which route `team send` picks for each vendor's CLI when the team declares no order, read
// from the send's own dry run: the Claude seat with the development channel and a live channel
// listener takes the push first, then its socket; Codex walks its native runtime queue first;
// the other CLIs walk the build's default. One matrix, so a change to any vendor's implied
// order shows up here. Fixtures only: a synthetic checkout and home; nothing is written.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { writeListener } from '../src/mcp/inbox.ts';
import { NOW, dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const CHANNEL = 'claude --dangerously-load-development-channels server:team-inbox';
let made: World | null = null;
afterEach(() => {
  made?.cleanup();
  made = null;
});

function seat(name: string, cli: string, launch: string): string {
  return `  - role: reviewer\n    name: ${name}\n    cli: ${cli}\n    vendor: test\n    model: Test\n    version: "1"\n    launch: ${launch}\n`;
}

function mixed(): World {
  made = world(null, [{ name: 'claude-ch', role: 'implementer', launch: CHANNEL }]);
  const file = join(made.root, '.agents', 'team.yaml');
  const text = readFileSync(file, 'utf8').replace(
    '# The team\'s word',
    `${seat('gem', 'gemini', 'gemini')}${seat('grk', 'grok', 'grok')}${seat('cur', 'cursor', 'cursor-agent')}# The team's word`,
  );
  writeFileSync(file, text);
  // The channel seat's own inbox server is listening and declared the channel.
  const dir = dropDir(made.dir, 'claude-ch');
  mkdirSync(dir, { recursive: true });
  writeListener(dir, { v: 1, seat: 'claude-ch', session: 'acme', root: realpathSync(made.root), cli: 'claude-code', pid: process.pid, ts: NOW.toISOString(), channel: true });
  return made;
}

async function plan(at: World, to: string): Promise<string> {
  const io = owner(at.root);
  const code = await runSend([to, 'hello', '--dry-run'], io, fake(at));
  return `${code} ${io.out}${io.err}`;
}

describe('the route each vendor CLI gets with no declared order', () => {
  test('Claude with the channel: the push first; Claude without: never the channel; Codex: its runtime queue; the others: the default', async () => {
    const at = mixed();
    const routes: Record<string, string> = {};
    for (const to of ['claude-ch', 'helper', 'native', 'gem', 'grk', 'cur']) routes[to] = await plan(at, to);
    console.log(Object.entries(routes).map(([to, out]) => `${to}: ${out.trim().split('\n').pop()}`).join('\n'));
    for (const out of Object.values(routes)) expect(out.startsWith('0 ')).toBe(true);
    expect(routes['claude-ch']).toMatch(/claude-ch: dry-run: claude-code via [^\n]*channel/);
    expect(routes.helper).not.toMatch(/channel/);
    expect(routes.native).toContain('codex via its native runtime queue');
    for (const to of ['gem', 'grk', 'cur']) {
      expect(routes[to]).not.toMatch(/channel|native runtime queue/);
      expect(routes[to]).toContain(`${to}: dry-run:`);
    }
  });
});
