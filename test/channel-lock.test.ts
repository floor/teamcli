// Commit-lock ownership and an unfinished channel handoff.
// The lock name is published only after the owner pid is durable. An empty name is not taken,
// even when it is older than one second. A dead pid can be replaced, and the replacement is
// exclusive. Release removes only the inode this holder recorded. A failed owner write leaves
// no lock name. A handoff whose completion flag cannot be published stays recoverable: the
// record remains, no read receipt is written, and the sender does not treat it as a held fallback.
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNEL_HELD_RECEIPT,
  channelCommitActive,
  channelCommitLockPath,
  channelEmitted,
  channelNotified,
  channelPushPath,
  recordChannelEmitted,
  reserveChannelFallback,
  withChannelCommit,
} from '../src/mcp/channel.ts';
import { listenerPath, receiptPath } from '../src/mcp/inbox.ts';
import { runMcpServe } from '../src/mcp/serve.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signRecord } from '../src/send/record.ts';
import { testIo } from './helpers.ts';

const ID = 'aaaaaaaa-0000-4000-8000-000000000201';

function dirOf(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'channel-lock-')));
}

function deadPid(): Promise<number> {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('sleep did not start');
  child.kill('SIGKILL');
  return new Promise((resolve, reject) => {
    child.once('exit', () => resolve(pid));
    child.once('error', reject);
  });
}

describe('commit lock ownership', () => {
  test('an empty lock older than one second is not taken', () => {
    const dir = dirOf();
    try {
      const path = channelCommitLockPath(dir, ID);
      writeFileSync(path, '');
      const old = new Date(Date.now() - 2_000);
      utimesSync(path, old, old);
      let ran = false;
      const result = withChannelCommit(dir, ID, () => {
        ran = true;
        return 'ran';
      });
      expect(ran).toBe(false);
      expect(result).toBe('busy');
      expect(channelCommitActive(dir, ID)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('a publish delayed more than one second does not overlap another taker', () => {
    const dir = dirOf();
    try {
      let depth = 0;
      let max = 0;
      const enter = (): void => {
        depth += 1;
        max = Math.max(max, depth);
      };
      const leave = (): void => {
        depth -= 1;
      };
      const result = withChannelCommit(dir, ID, () => {
        enter();
        leave();
        return 'holder';
      }, {
        beforePublish() {
          expect(existsSync(channelCommitLockPath(dir, ID))).toBe(false);
          const started = Date.now();
          while (Date.now() - started < 1_100) {
            // The public name stays absent for longer than the old one-second grace.
          }
          expect(existsSync(channelCommitLockPath(dir, ID))).toBe(false);
          const other = withChannelCommit(dir, ID, () => {
            enter();
            leave();
            return 'other';
          });
          expect(other).toBe('other');
        },
      });
      expect(result).toBe('holder');
      expect(max).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('one reclaimer of a dead pid excludes the other', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      writeFileSync(channelCommitLockPath(dir, ID), `${String(pid)}\n`);
      const seen = { nested: 'pending' as 'pending' | 'busy' };
      const outer = withChannelCommit(dir, ID, () => {
        const inner = withChannelCommit(dir, ID, (): 'ran' => 'ran');
        seen.nested = inner === 'busy' ? 'busy' : 'pending';
        return 'outer';
      });
      expect(outer).toBe('outer');
      expect(seen.nested).toBe('busy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dead lock with a leftover reclaim link is recovered', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      writeFileSync(path, `${String(pid)}\n`);
      linkSync(path, claim);
      const seen = { nested: 'pending' as 'pending' | 'busy' };
      const outer = withChannelCommit(dir, ID, () => {
        expect(readFileSync(path, 'utf8')).toBe(`${String(process.pid)}\n`);
        expect(existsSync(claim)).toBe(false);
        const inner = withChannelCommit(dir, ID, (): 'ran' => 'ran');
        seen.nested = inner === 'busy' ? 'busy' : 'pending';
        return 'outer';
      });
      expect(outer).toBe('outer');
      expect(seen.nested).toBe('busy');
      expect(existsSync(claim)).toBe(false);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a held claim is not moved and a rival stays out of the lock', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      const dead = `${String(pid)}\n`;
      writeFileSync(path, dead);
      linkSync(path, claim);
      let depth = 0;
      let max = 0;
      const seen = { rival: 'pending' as 'pending' | 'busy' };
      const outer = withChannelCommit(dir, ID, () => {
        depth += 1;
        max = Math.max(max, depth);
        const during = withChannelCommit(dir, ID, (): 'during' => 'during');
        seen.rival = during === 'busy' ? 'busy' : 'pending';
        depth -= 1;
        return 'outer';
      }, {
        beforeLockRename() {
          expect(readFileSync(claim, 'utf8')).toBe(dead);
          expect(readFileSync(path, 'utf8')).toBe(dead);
          const other = withChannelCommit(dir, ID, (): 'other' => 'other');
          expect(other).toBe('busy');
          expect(readFileSync(claim, 'utf8')).toBe(dead);
          expect(readFileSync(path, 'utf8')).toBe(dead);
        },
      });
      expect(outer).toBe('outer');
      expect(seen.rival).toBe('busy');
      expect(max).toBe(1);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(claim)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('another process cannot enter while a holder owns the claim', async () => {
    const dir = dirOf();
    const pid = await deadPid();
    const path = channelCommitLockPath(dir, ID);
    const claim = join(dir, `${ID}.channel-commit.reclaim`);
    const dead = `${String(pid)}\n`;
    writeFileSync(path, dead);
    linkSync(path, claim);
    const paused = join(dir, 'paused');
    const go = join(dir, 'go');
    const holding = join(dir, 'holding');
    const release = join(dir, 'release');
    const channelFile = fileURLToPath(new URL('../src/mcp/channel.ts', import.meta.url));
    writeFileSync(join(dir, 'holder.ts'), `import { withChannelCommit } from ${JSON.stringify(channelFile)};
import { existsSync, writeFileSync } from 'node:fs';
const dir = ${JSON.stringify(dir)};
const id = ${JSON.stringify(ID)};
const paused = ${JSON.stringify(paused)};
const go = ${JSON.stringify(go)};
const holding = ${JSON.stringify(holding)};
const release = ${JSON.stringify(release)};
const waitFor = (flag) => {
  const started = Date.now();
  while (!existsSync(flag)) {
    if (Date.now() - started > 8000) throw new Error('timed out waiting for ' + flag);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
};
const result = withChannelCommit(dir, id, () => {
  writeFileSync(holding, '1');
  waitFor(release);
  return 'held';
}, {
  skipFlock: true,
  beforeLockRename() {
    writeFileSync(paused, '1');
    waitFor(go);
  },
});
if (result !== 'held') throw new Error('holder did not enter: ' + String(result));
`);
    const child = spawn(process.execPath, [join(dir, 'holder.ts')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childOut = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      childOut += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      childOut += String(chunk);
    });
    try {
      const waitFor = async (flag: string): Promise<void> => {
        for (let at = 0; at < 400; at += 1) {
          if (existsSync(flag)) return;
          if (child.exitCode !== null) throw new Error(childOut || `holder exited ${String(child.exitCode)}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(childOut || `timed out waiting for ${flag}`);
      };
      await waitFor(paused);
      expect(readFileSync(claim, 'utf8')).toBe(dead);
      expect(readFileSync(path, 'utf8')).toBe(`${String(child.pid)}\n`);
      const rival = withChannelCommit(dir, ID, (): 'in' => 'in', { skipFlock: true });
      expect(rival).toBe('busy');
      expect(readFileSync(claim, 'utf8')).toBe(dead);
      expect(readFileSync(path, 'utf8')).toBe(`${String(child.pid)}\n`);
      writeFileSync(go, '1');
      await waitFor(holding);
      const during = withChannelCommit(dir, ID, (): 'in' => 'in', { skipFlock: true });
      expect(during).toBe('busy');
      writeFileSync(release, '1');
      const code = await new Promise<number>((resolve, reject) => {
        child.once('exit', (status) => resolve(status ?? 1));
        child.once('error', reject);
      });
      expect(code).toBe(0);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(claim)).toBe(false);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // The holder already exited.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a published holder keeps the lock if its helper dies', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      writeFileSync(path, `${String(pid)}\n`);
      linkSync(path, claim);
      const seen = { helper: 0, rival: 'pending' as 'pending' | 'busy' };
      const outer = withChannelCommit(dir, ID, (): 'outer' => 'outer', {
        skipFlock: true,
        helperPid(helper) {
          seen.helper = helper;
        },
        beforeLockRename() {
          process.kill(seen.helper, 'SIGKILL');
          const rival = withChannelCommit(dir, ID, (): 'in' => 'in', { skipFlock: true });
          seen.rival = rival === 'busy' ? 'busy' : 'pending';
          expect(readFileSync(path, 'utf8')).toBe(`${String(process.pid)}\n`);
        },
      });
      expect(outer).toBe('outer');
      expect(seen.helper > 0).toBe(true);
      expect(seen.rival).toBe('busy');
      expect(existsSync(path)).toBe(false);
      expect(existsSync(claim)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a helper stopped before publish does not leave this process holding the lock', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      const dead = `${String(pid)}\n`;
      writeFileSync(path, dead);
      linkSync(path, claim);
      writeFileSync(`${claim}.stall`, '1\n');
      const stalled = withChannelCommit(dir, ID, (): 'outer' => 'outer', {
        skipFlock: true,
        helperWaitMs: 200,
      });
      expect(stalled).toBe('busy');
      expect(readFileSync(path, 'utf8')).toBe(dead);
      unlinkSync(`${claim}.stall`);
      const outer = withChannelCommit(dir, ID, (): 'outer' => 'outer', { skipFlock: true });
      expect(outer).toBe('outer');
      expect(existsSync(path)).toBe(false);
      expect(existsSync(claim)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dead lock is recovered when flock cannot be bound', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      writeFileSync(path, `${String(pid)}\n`);
      linkSync(path, claim);
      const seen = { nested: 'pending' as 'pending' | 'busy' };
      const outer = withChannelCommit(dir, ID, () => {
        const inner = withChannelCommit(dir, ID, (): 'ran' => 'ran', { skipFlock: true });
        seen.nested = inner === 'busy' ? 'busy' : 'pending';
        return 'outer';
      }, { skipFlock: true });
      expect(outer).toBe('outer');
      expect(seen.nested).toBe('busy');
      expect(existsSync(claim)).toBe(false);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live claim stays put when flock cannot be bound', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      writeFileSync(path, `${String(pid)}\n`);
      writeFileSync(claim, `${String(process.pid)}\n`);
      let ran = false;
      const result = withChannelCommit(dir, ID, () => {
        ran = true;
        return 'ran' as const;
      }, { skipFlock: true });
      expect(ran).toBe(false);
      expect(result).toBe('busy');
      expect(readFileSync(path, 'utf8')).toBe(`${String(pid)}\n`);
      expect(readFileSync(claim, 'utf8')).toBe(`${String(process.pid)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live reclaim claim is not taken', async () => {
    const dir = dirOf();
    try {
      const pid = await deadPid();
      const path = channelCommitLockPath(dir, ID);
      const claim = join(dir, `${ID}.channel-commit.reclaim`);
      writeFileSync(path, `${String(pid)}\n`);
      writeFileSync(claim, `${String(process.pid)}\n`);
      let ran = false;
      const result = withChannelCommit(dir, ID, () => {
        ran = true;
        return 'ran';
      });
      expect(ran).toBe(false);
      expect(result).toBe('busy');
      expect(readFileSync(path, 'utf8')).toBe(`${String(pid)}\n`);
      expect(readFileSync(claim, 'utf8')).toBe(`${String(process.pid)}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an old holder does not remove a replacement lock', () => {
    const dir = dirOf();
    try {
      const path = channelCommitLockPath(dir, ID);
      withChannelCommit(dir, ID, () => 'held', {
        beforeRelease() {
          unlinkSync(path);
          writeFileSync(path, '2\n');
        },
      });
      expect(readFileSync(path, 'utf8')).toBe('2\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a failed owner write closes the private file and publishes nothing', () => {
    const dir = dirOf();
    try {
      const before = readdirSync('/dev/fd').length;
      let ran = false;
      const result = withChannelCommit(dir, ID, () => {
        ran = true;
        return 'ran';
      }, { failOwnerWrite: true });
      expect(ran).toBe(false);
      expect(result).toBe('busy');
      expect(existsSync(channelCommitLockPath(dir, ID))).toBe(false);
      expect(readdirSync(dir).filter((name) => name.includes('channel-commit'))).toEqual([]);
      expect(readdirSync('/dev/fd').length).toBe(before);
      expect(withChannelCommit(dir, ID, () => 'after')).toBe('after');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an active lock is busy and a released lock is not', () => {
    const dir = dirOf();
    try {
      expect(channelCommitActive(dir, ID)).toBe(false);
      withChannelCommit(dir, ID, () => {
        expect(channelCommitActive(dir, ID)).toBe(true);
      });
      expect(channelCommitActive(dir, ID)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an unfinished handoff', () => {
  test('a handoff marker is not a held fallback', () => {
    const dir = dirOf();
    try {
      expect(recordChannelEmitted(dir, ID, '2026-11-05T00:00:00.000Z')).toBe(true);
      const claim = reserveChannelFallback(dir, {
        v: 1,
        kind: CHANNEL_HELD_RECEIPT,
        id: ID,
        at: '2026-11-05T00:00:00.000Z',
        reason: 'no push receipt within 0 ms',
      });
      expect(claim).toBe('uncertain');
      expect(channelEmitted(dir, ID)).toBe(true);
      expect(channelNotified(dir, ID)).toBe(false);
      expect(existsSync(channelPushPath(dir, ID))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a notification whose completion flag fails leaves the record recoverable', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'channel-lock-serve-')));
    const home = join(root, 'home');
    const session = 'acme';
    mkdirSync(join(root, '.agents'));
    mkdirSync(home, { mode: 0o700 });
    const launch = 'claude --dangerously-load-development-channels server:team-inbox';
    writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: ${session}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
`);
    writeFileSync(join(root, '.agents', 'team.state.json'), `${JSON.stringify({ format: 1, sessions: { [session]: { seats: { lead: { stage: 'ready', pane: 'pane-lead' } }, worktrees: {} } } })}\n`);
    upsertTeam(home, teamIdOf(root), {
      project: 'acme',
      session,
      root,
      roster: [{ agent: 'agt_000000000001', seat: 'lead', role: 'coordinator' }],
    });
    const dropDir = join(root, '.agents', 'send-drops', session, 'lead');
    const id = 'bbbbbbbb-0000-4000-8000-000000000202';
    try {
      const io = testIo(root, { kind: 'seat', name: 'lead', pane: 'pane-lead', session });
      const pending: string[] = [];
      const gate: { wake: (() => void) | null } = { wake: null };
      let ended = false;
      const replies: string[] = [];
      const lines = (async function* () {
        for (;;) {
          if (pending.length > 0) {
            yield pending.shift()!;
            continue;
          }
          if (ended) return;
          await new Promise<void>((resolve) => {
            gate.wake = resolve;
          });
        }
      })();
      const running = runMcpServe({ seat: 'lead', session }, io, {
        lines,
        write: (line) => replies.push(line),
      }, {
        home,
        channelMark: () => false,
      });
      for (let at = 0; at < 400 && !existsSync(listenerPath(dropDir)); at += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const record = signRecord({
        kind: 'message',
        id,
        to: 'lead',
        to_id: null,
        root,
        session,
        at: '2026-10-22T09:00:00.000Z',
        body: 'from the owner — admitted by: the owner\n\nhello there',
        from: 'owner',
        from_id: null,
        rule: 'the owner',
        thread: id,
      }, home);
      mkdirSync(dropDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dropDir, id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      for (let at = 0; at < 400 && !replies.some((line) => line.includes('notifications/claude/channel')); at += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(replies.some((line) => line.includes('notifications/claude/channel'))).toBe(true);
      expect(channelNotified(dropDir, id)).toBe(false);
      expect(channelEmitted(dropDir, id)).toBe(true);
      expect(existsSync(receiptPath(dropDir, id))).toBe(false);
      expect(existsSync(join(dropDir, id))).toBe(true);
      const claim = reserveChannelFallback(dropDir, {
        v: 1,
        kind: CHANNEL_HELD_RECEIPT,
        id,
        at: '2026-10-22T09:00:01.000Z',
        reason: 'no push receipt within 0 ms',
      });
      expect(claim).toBe('uncertain');
      ended = true;
      gate.wake?.();
      expect(await running).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
