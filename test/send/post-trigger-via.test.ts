// The typed path's post-trigger outcomes: a pane that already holds an unsent draft (`held`) or a
// screen the classifier reads as a dialog (`unreachable`) records the path the send took —
// `via: 'typed'`, the same field the daemon's own handler writes at those points. Fixtures only:
// a fake seat and a scripted pane; no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { readHistory } from '../../src/send/history.ts';
import type { NativePane } from '../../src/send/native.ts';
import { sendFrame, type SendOutcome } from '../../src/send/uds.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-16T04:00:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFile(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function world(): { root: string; home: string; sockets: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-post-trigger-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, home, sockets };
}

type Scripted = NativePane & { typed: string[]; enters: number };

/** A native pane that walks its samples, one per status read, with the screen the caller sets. */
function scripted(samples: string[]): Scripted {
  const typed: string[] = [];
  let enters = 0;
  let read = 0;
  return {
    typed,
    get enters() {
      return enters;
    },
    typeText: (_session, _pane, text) => {
      typed.push(text);
      return true;
    },
    pressEnter: () => {
      enters += 1;
      return true;
    },
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

type Fake = SendHost & { frames: string[]; socketsTried: string[] };

function fake(sockets: string, patch: Partial<SendHost> = {}): Fake {
  const frames: string[] = [];
  const socketsTried: string[] = [];
  return {
    frames,
    socketsTried,
    agents: () => [{ name: 'native', pane: 'w9:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (socketPath: string, frame: string): Promise<SendOutcome> => {
      socketsTried.push(socketPath);
      frames.push(frame);
      return { ok: true };
    },
    native: scripted(['idle']),
    now: () => NOW,
    home: join(base, 'home'),
    ...patch,
  };
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

/** The run's last history entry: fixed clock, so its `ms` is 0. */
function lastEntry(root: string, home: string): Record<string, unknown> {
  const read = readHistory('acme', root, home);
  if (!read.ok) throw new Error(read.reason);
  const last = read.entries.at(-1);
  if (last === undefined) throw new Error('no history entry was written');
  return last as unknown as Record<string, unknown>;
}

describe('the typed path names itself after the trigger', () => {
  test('a composer that already holds a draft is held, and the history says via typed', async () => {
    const { root, home, sockets } = world();
    const draft = readFileSync(new URL('../fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8');
    const pane = scripted(['idle']);
    pane.paneText = () => draft;
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('held: the composer already holds unsent text');
    // The draft is never clobbered: nothing was typed and no Enter landed.
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);

    // The fixed clock reads 0 ms; the path still has to be named.
    expect(lastEntry(root, home)).toMatchObject({ to: 'native', outcome: 'held', ms: 0, via: 'typed' });
  });

  test('a screen that reads as a dialog is unreachable, and the history says via typed', async () => {
    const { root, home, sockets } = world();
    const permission = readFileSync(new URL('../fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const pane = scripted(['idle']);
    pane.paneText = () => permission;
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(1);
    expect(io.err).toContain('unreachable now (the screen reads permission); a running watch retries it when the seat is idle');
    expect(io.err).toContain('the screen reads permission');
    expect(pane.enters).toBe(0);

    expect(lastEntry(root, home)).toMatchObject({ to: 'native', outcome: 'unreachable', ms: 0, via: 'typed' });
  });
});
