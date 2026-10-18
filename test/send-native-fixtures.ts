// Stand-ins for the native-send gap tests: a temporary team, a fake socket folder, and a
// scripted pane. Nothing here talks to a live session or a real CLI home.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { senderHeader } from '../src/send/admit.ts';
import type { NativePane } from '../src/send/native.ts';
import { testIo, type TestIo } from './helpers.ts';

export const NOW = new Date('2026-10-05T04:00:00.000Z');

/** The drop file an owner's send writes: the sender header and its empty line, then the body.
 *  The header's own wording is pinned in send.test.ts and send-admit.test.ts; the scenes that
 *  file a body through `runSend` compare against this, so their subject stays the body. */
export function filed(body: string): string {
  return `${senderHeader('owner', 'the owner')}\n${body}`;
}

export type World = { root: string; dir: string; sockets: string; home: string; cleanup: () => void };

function teamFile(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
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
`;
}

export function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-native-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return {
    root,
    dir: join(root, '.agents'),
    sockets,
    home,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export type Fake = SendHost & { frames: string[] };

export function fake(made: World, patch: Partial<SendHost> = {}): Fake {
  const frames: string[] = [];
  return {
    frames,
    agents: () => [{ name: 'lead', pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: made.sockets,
    deliver: async (_socketPath: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
    native: quietNative(),
    now: () => NOW,
    home: made.home,
    ...patch,
  };
}

export function quietNative(): NativePane {
  return {
    typeText: () => false,
    pressEnter: () => false,
    status: () => null,
    wait: async () => {},
  };
}

export type Scripted = NativePane & { typed: string[]; enters: number };

/** Status samples, one per read. `wait` resolves immediately so the polls cost nothing. */
export function scripted(samples: string[], screen: string | null = null): Scripted {
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
    paneText: () => screen,
    wait: async () => {},
  };
}

export function nativeHost(made: World, samples: string[]): { host: Fake; pane: Scripted } {
  const pane = scripted(samples);
  const host = fake(made, {
    agents: () => [{ name: 'native', pane: 'w9:p1' }],
    native: pane,
  });
  return { host, pane };
}

export function owner(root: string): TestIo {
  return testIo(root, { kind: 'owner' });
}

export function dropDir(dir: string, seat = 'native'): string {
  return join(dir, 'send-drops', 'acme', seat);
}
