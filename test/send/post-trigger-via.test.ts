// The post-trigger outcomes, after 0.5.9: a pane that already holds an unsent draft, or a screen
// the classifier reads as a dialog, is left exactly as it is — nothing is typed into a seat — and
// the send's history names the bus drop that carried it, with the typed leg's refusal recorded as
// the reason the pane was never walked. The seat is a Codex seat, whose profile declares the typed
// wake: this fake host binds no pane writer, so the recorded refusal is that missing binding, and
// the composer is never read or typed into. Fixtures only: a fake seat and a scripted pane; no
// live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../../src/commands/send.ts';
import { lobbyDir } from '../../src/lobby/gate.ts';
import { readHistory } from '../../src/send/history.ts';
import type { NativePane } from '../../src/send/native.ts';
import { sendFrame, type SendOutcome } from '../../src/send/uds.ts';
import { recordBody, testIo } from '../helpers.ts';
import { filed } from '../send-native-fixtures.ts';

const NOW = new Date('2026-10-16T04:00:00.000Z');

/** The refusal a typed wake records when the send host binds no pane-writer operations, as this
 *  fake's host does not: the profile gate lets the typed leg be walked, and the wake refuses
 *  before a read or a key for want of that binding. */
const NO_PANE_WRITER = 'the send host binds no pane writer; nothing was typed';

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

describe('the history names the channel that carried the send', () => {
  test('a composer that already holds an unsent draft is left as it is, and the history names the drop', async () => {
    const { root, home, sockets } = world();
    const draft = readFileSync(new URL('../fixtures/codex/0.157.0/unsent.txt', import.meta.url), 'utf8');
    const pane = scripted(['idle']);
    pane.paneText = () => draft;
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(0);

    // The box is never touched: the draft stays the seat's own, and nothing is typed or entered.
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    // The signed record is the drop file, and the history names that channel; the typed leg's
    // refusal is the recorded reason the pane was not walked. The walk puts the seat's native
    // route before the typed wake, so its own missing-session refusal is recorded first.
    const dir = join(root, '.agents', 'send-drops', 'acme', 'native');
    const id = readdirSync(dir).filter((name) => !name.includes('.'))[0] as string;
    expect(recordBody(join(dir, id))).toBe(filed('hello'));
    const entry = lastEntry(root, home);
    expect(entry).toMatchObject({ id, outcome: 'queued, not woken', via: 'drop', body: filed('hello') });
    expect(entry.failed).toEqual([
      'native: no trusted runtime session is recorded for this seat (no agent record for this seat)',
      `typed: ${NO_PANE_WRITER}`,
    ]);
  });

  test('a screen that reads as a dialog is left alone, and the history names the drop', async () => {
    const { root, home, sockets } = world();
    const permission = readFileSync(new URL('../fixtures/codex/0.157.0/permission.txt', import.meta.url), 'utf8');
    const pane = scripted(['idle']);
    pane.paneText = () => permission;
    const host = fake(sockets, { native: pane });
    const io = owner(root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(0);

    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
    const dir = join(root, '.agents', 'send-drops', 'acme', 'native');
    const id = readdirSync(dir).filter((name) => !name.includes('.'))[0] as string;
    expect(recordBody(join(dir, id))).toBe(filed('hello'));
    const entry = lastEntry(root, home);
    expect(entry).toMatchObject({ id, outcome: 'queued, not woken', via: 'drop', body: filed('hello') });
    // Same walk order as the draft scene: the native route's refusal first, the typed wake's
    // missing pane writer second.
    expect(entry.failed).toEqual([
      'native: no trusted runtime session is recorded for this seat (no agent record for this seat)',
      `typed: ${NO_PANE_WRITER}`,
    ]);
  });
});
