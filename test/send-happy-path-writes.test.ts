// The send path diet (step 2): a send whose first leg delivers writes no fallback episode (no
// `<id>.fallback.json` marker, no `fallback-attempts-*.jsonl` ledger) and no `.unread.json` hint.
// The episode starts only when a fallback leg does. Fixtures only: a synthetic team, a listener
// written by this test, and the push marker written where the seat's server would write it.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { markChannelNotified, recordChannelPush } from '../src/mcp/channel.ts';
import { MESSAGE_ID, writeListener } from '../src/mcp/inbox.ts';
import { NOW, dropDir, fake, owner, world, type World } from './send-native-fixtures.ts';

const SEND_ID = 'aaaaaaaa-0000-4000-8000-000000000301';
const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** Every file under `top` modified after `since` (ms), as paths relative to `base`. */
function writtenSince(top: string, since: number, base: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of existsSync(at) ? readdirSync(at) : []) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.mtimeMs > since) out.push(relative(base, path));
    }
  };
  walk(top);
  return out.sort();
}

function channelScene(): { made: World; dir: string } {
  const made = world(null, [], { lead: CHANNEL_LAUNCH });
  cleanup = made.cleanup;
  const dir = dropDir(made.dir, 'lead');
  mkdirSync(dir, { recursive: true });
  const root = realpathSync(made.root);
  writeListener(dir, { v: 1, seat: 'lead', session: 'acme', root, cli: 'claude-code', pid: process.pid, ts: NOW.toISOString(), channel: true });
  return { made, dir };
}

describe('the happy path writes no fallback episode and no unread hint', () => {
  test('a channel push that lands: no marker, no attempt ledger, no unread hint', async () => {
    const { made, dir } = channelScene();
    const root = realpathSync(made.root);
    const host = fake(made, {
      sendId: () => SEND_ID,
      channelGraceMs: 500,
      native: {
        typeText: () => false,
        pressEnter: () => false,
        status: () => 'idle',
        paneText: () => null,
        wait: async () => {
          const id = readdirSync(dir).find((name) => MESSAGE_ID.test(name));
          if (id === undefined) return;
          recordChannelPush(dir, {
            v: 1, kind: 'channel-push', id, seat: 'lead', session: 'acme', root, at: NOW.toISOString(),
            meta: { id, from: 'owner', seat: 'lead', team: 'acme' }, content_sha256: 'a'.repeat(64), status: 'sent (channel)',
          });
          markChannelNotified(dir, id);
        },
      },
    } as never);
    const mark = join(made.root, '..', 'mark');
    writeFileSync(mark, '');
    const since = statSync(mark).mtimeMs;
    const code = await runSend(['lead', 'hello'], owner(made.root), host);
    expect(code).toBe(0);
    const base = join(made.root, '..');
    const written = [...writtenSince(made.dir, since, base), ...writtenSince(made.home, since, base)];
    if (process.env.SEND_DIET_LIST === '1') process.stderr.write(`${String(written.length)} files\n${written.join('\n')}\n`);
    expect(written.some((path) => path.endsWith(`${SEND_ID}.fallback.json`))).toBe(false);
    expect(written.some((path) => /fallback-attempts-.*\.jsonl$/.test(path))).toBe(false);
    expect(written.some((path) => path.endsWith('.unread.json'))).toBe(false);
    expect(written.some((path) => path.endsWith(SEND_ID))).toBe(true);
  });
});
