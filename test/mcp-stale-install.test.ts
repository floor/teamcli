// A running `team mcp serve` keeps the code it started with: installing a build neither reloads
// it nor ends it, so a long-lived server can hold a seat's channel from an install the sender has
// already replaced. These scenes pin both halves of the repair: the server notices the install on
// disk and starts the installed entry, and a sender that falls back from a stale serving channel
// holds the push marker's name, so the old server's late push cannot follow its wake as a second
// one. Fixtures only: a synthetic team, homes and listener markers this test writes; no live
// session or pane is touched, and no process is spawned.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import {
  CHANNEL_HELD_RECEIPT,
  channelPushPath,
  channelPushed,
} from '../src/mcp/channel.ts';
import {
  listenerRuntime,
  readListener,
  writeListener,
  type InboxListener,
} from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import type { BuildIdentity, InstallIdentity } from '../src/version.ts';
import { testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

const SESSION = 'acme';
const CHANNEL_LAUNCH = 'claude --dangerously-load-development-channels server:team-inbox';
const SEND_ID = 'aaaaaaaa-0000-4000-8000-000000000301';
const TRIGGER = 'hello';

/** The install this server started from and the one installed under it: same seat, another
 *  version and another packed commit, so either word alone is enough to tell them apart. */
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const OLD: BuildIdentity = {
  version: '0.5.4-hotfix.9',
  build: 'aaaaaaaaaaaaaaaa',
  builtAt: Date.parse('2026-10-20T00:00:00.000Z'),
  head: OLD_HEAD,
};
const NEW: BuildIdentity = {
  version: '0.5.5',
  build: 'bbbbbbbbbbbbbbbb',
  builtAt: Date.parse('2026-10-22T00:00:00.000Z'),
  head: NEW_HEAD,
};

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** A channel seat's world: no declared delivery order, and the lead's launch carries the flag. */
function channelWorld(): World {
  const made = world(null, [], { lead: CHANNEL_LAUNCH });
  cleanup = made.cleanup;
  return made;
}

type Feed = {
  lines: AsyncIterable<string>;
  write(line: string): void;
  push(line: string): void;
  end(): void;
  close(): void;
  replies: string[];
};

/** The server's stdio, driven by the scene: one reply per written line, and `close` ends the
 *  input the way the real stdin's reader does. */
function feed(): Feed {
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const replies: string[] = [];
  const bump = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const end = (): void => {
    ended = true;
    bump();
  };
  const lines = (async function* () {
    for (;;) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    lines,
    write: (line) => replies.push(line),
    push: (line) => {
      pending.push(line);
      bump();
    },
    end,
    close: end,
    replies,
  };
}

function notices(replies: readonly string[]): Record<string, unknown>[] {
  return replies
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((one) => one.method === 'notifications/claude/channel');
}

async function until(check: () => boolean, limit = 600): Promise<void> {
  for (let at = 0; at < limit && !check(); at += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('the listener identity', () => {
  test('a listener is stale for another version, another packed commit, or no recorded commit', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-stale-identity-')));
    try {
      const marker: InboxListener = {
        v: 1,
        seat: 'lead',
        session: SESSION,
        root: base,
        cli: 'claude-code',
        pid: process.pid,
        ts: NOW.toISOString(),
        version: OLD.version,
        build: OLD.build,
        head: OLD_HEAD,
      };
      writeListener(base, marker);
      const read = readListener(base);
      expect(read).not.toBeNull();
      expect(read?.head).toBe(OLD_HEAD);
      expect(listenerRuntime(read as InboxListener, OLD)).toEqual({ kind: 'current' });

      // Another version is stale, as before.
      const newer = listenerRuntime(read as InboxListener, NEW);
      expect(newer.kind).toBe('stale');

      // The same version from another packed commit is another install: the version alone does
      // not vouch for the parsers in memory.
      const sameVersion = listenerRuntime(read as InboxListener, { ...NEW, version: OLD.version });
      expect(sameVersion.kind).toBe('stale');
      if (sameVersion.kind === 'stale') expect(sameVersion.reason).toContain('another install');

      // A marker written before the commit was recorded cannot vouch for its install either.
      const { head: _head, ...withoutHead } = read as InboxListener;
      expect(listenerRuntime(withoutHead, { ...NEW, version: OLD.version }).kind).toBe('stale');
      // Two markers that both record no head are compared as they were: the entry digest decides.
      expect(listenerRuntime(withoutHead, { ...OLD, head: null })).toEqual({ kind: 'current' });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('an install under a running server', () => {
  test('the installed identity replaces the stale process, and the next send is taken by it', async () => {
    const made = channelWorld();
    const dir = dropDir(made.dir, 'lead');
    let onDisk: InstallIdentity = { version: OLD.version, head: OLD.head };
    const restarts: InstallIdentity[] = [];
    const staleIo = testIo(made.root);
    const staleFeed = feed();
    const stale = runMcpServe({ seat: 'lead', session: SESSION }, staleIo, staleFeed, {
      home: made.home,
      build: OLD,
      installed: () => onDisk,
      restart: (installed) => restarts.push(installed),
    });
    try {
      await until(() => readListener(dir)?.head === OLD.head);
      expect(readListener(dir)).toMatchObject({
        version: OLD.version,
        build: OLD.build,
        head: OLD.head,
        channel: true,
      });

      // The install lands while the server serves. Its channel must stop before the next push,
      // and the process must start the entry on disk.
      onDisk = { version: NEW.version, head: NEW.head };
      await until(() => restarts.length === 1);
      expect(restarts).toEqual([{ version: NEW.version, head: NEW.head }]);
      expect(await stale).toBe(0);
      // The stale process removed its own marker before the fresh one writes its own.
      expect(readListener(dir)).toBeNull();
      expect(staleFeed.replies).toEqual([]);
      expect(staleIo.err).toBe('');

      // The fresh process the launch starts from the installed entry.
      const installedIo = testIo(made.root);
      const installedFeed = feed();
      const installed = runMcpServe({ seat: 'lead', session: SESSION }, installedIo, installedFeed, {
        home: made.home,
        build: NEW,
      });
      try {
        await until(() => readListener(dir)?.head === NEW.head);
        expect(readListener(dir)).toMatchObject({ version: NEW.version, head: NEW.head });

        // The next send runs the installed build too, and the installed server's channel takes
        // it: nothing is typed, and exactly one notification is written.
        const pane = scripted(['idle', 'working']);
        const host = fake(made, {
          sendId: () => SEND_ID,
          build: () => NEW,
          channelGraceMs: 2_000,
          native: { ...pane, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
        });
        const sendIo = owner(made.root);
        expect(await runSend(['lead', TRIGGER], sendIo, host)).toBe(0);
        expect(sendIo.out).toContain('sent (channel)');
        expect(pane.typed).toEqual([]);
        expect(pane.enters).toBe(0);
        await until(() => notices(installedFeed.replies).length === 1);
        expect(notices(installedFeed.replies)).toHaveLength(1);
        expect(channelPushed(dir, SEND_ID)).toBe(true);
      } finally {
        installedFeed.end();
        expect(await installed).toBe(0);
      }
    } finally {
      staleFeed.end();
      await stale.catch(() => 0);
    }
  });
});

describe('a sender falling back from a stale channel', () => {
  test('the sender holds the push name, so the stale server cannot wake the seat twice', async () => {
    const made = channelWorld();
    const dir = dropDir(made.dir, 'lead');
    const serverIo = testIo(made.root);
    const serverFeed = feed();
    // The server believes it still runs OLD: its own install check agrees with its build, so only
    // the sender's held marker can stop its push.
    const running = runMcpServe({ seat: 'lead', session: SESSION }, serverIo, serverFeed, {
      home: made.home,
      build: OLD,
      installed: () => ({ version: OLD.version, head: OLD.head }),
    });
    try {
      await until(() => readListener(dir)?.head === OLD.head);

      // The sender is the installed build: it cannot vouch for the listener, so the channel and
      // inbox legs fall through and the typed trigger wakes the seat.
      const pane = scripted(['idle', 'working']);
      const host = fake(made, { sendId: () => SEND_ID, build: () => NEW, native: pane });
      const sendIo = owner(made.root);
      expect(await runSend(['lead', TRIGGER], sendIo, host)).toBe(0);
      expect(sendIo.out).toContain('(typed');
      expect(sendIo.out).not.toContain('sent (channel)');
      expect(pane.typed).toHaveLength(1);
      expect(pane.enters).toBe(1);

      // Let the 250 ms watcher tick over the record more than once: no push is written, so the
      // stale server added no second wake to the typed trigger's one.
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(notices(serverFeed.replies)).toEqual([]);
      expect(pane.typed).toHaveLength(1);

      // The held marker landed before the record, at the push marker's own name; it is not a
      // push, so a channel wait for this id still does not read it as delivered.
      const marker = JSON.parse(readFileSync(channelPushPath(dir, SEND_ID), 'utf8')) as Record<string, unknown>;
      expect(marker).toMatchObject({ v: 1, kind: CHANNEL_HELD_RECEIPT, id: SEND_ID });
      expect(channelPushed(dir, SEND_ID)).toBe(false);
    } finally {
      serverFeed.end();
      expect(await running).toBe(0);
    }
  });
});
