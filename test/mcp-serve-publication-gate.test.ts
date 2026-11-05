// The seat declaration is checked when a call starts, and a signed record is then opened and
// verified — time in which the seat can be stopped, dropped or moved. These scenes stop the seat
// exactly while its record is open, through the module-level file open (the same interposition
// the review of this branch used), and pin the second look: once the declaration is gone, a read
// serves no body and writes no receipt, an ack writes no receipt, and a push writes no marker and
// sends no notification. Fixtures only: a synthetic team, home and signed records; no live seat,
// process or herdr is touched.
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.ts';
import type { BuildIdentity } from '../src/version.ts';

const ID_READ = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ID_ACK = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e';
const ID_PUSH_OK = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4f';
const ID_PUSH_REFUSED = '5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c50';
const EPOCH = 'run_0123456789ab';
const CHANNEL_METHOD = 'notifications/claude/channel';
const BUILD: BuildIdentity = { version: 'fixture', build: 'a'.repeat(16), builtAt: 0, head: null };

/** Called with each path opened through the module before the real open runs. */
let open: ((path: string) => void) | null = null;
const realOpenSync = realFs.openSync;
const bases: string[] = [];

let runMcpServe: typeof import('../src/mcp/serve.ts').runMcpServe;
let signRecord: typeof import('../src/send/record.ts').signRecord;
let receiptPath: typeof import('../src/mcp/inbox.ts').receiptPath;
let channelPushed: typeof import('../src/mcp/channel.ts').channelPushed;
let upsertTeam: typeof import('../src/registry/teams.ts').upsertTeam;
let teamIdOf: typeof import('../src/registry/teams.ts').teamIdOf;

beforeAll(async () => {
  // Bun binds a named import to the function itself, so the wrapper must exist before the source
  // module loads; a patch registered after the import never fires (the broker test's finding).
  mock.module('node:fs', () => {
    const proxied = Object.assign({}, realFs);
    proxied.openSync = ((path: unknown, ...rest: unknown[]) => {
      open?.(String(path));
      return (realOpenSync as unknown as (path: unknown, ...rest: unknown[]) => number)(path, ...rest);
    }) as typeof realFs.openSync;
    return proxied;
  });
  ({ runMcpServe } = await import('../src/mcp/serve.ts'));
  ({ signRecord } = await import('../src/send/record.ts'));
  ({ receiptPath } = await import('../src/mcp/inbox.ts'));
  ({ channelPushed } = await import('../src/mcp/channel.ts'));
  ({ upsertTeam, teamIdOf } = await import('../src/registry/teams.ts'));
});
// Bun's module mocks are process-wide and every test file of a run shares one process: put the
// captured real open back when this file ends.
afterAll(() => {
  mock.module('node:fs', () => ({ ...realFs, openSync: realOpenSync }));
  open = null;
  for (const base of bases) realFs.rmSync(base, { recursive: true, force: true });
});

type Fixture = {
  root: string;
  home: string;
  lobby: string;
  file: string;
  drop: string;
  message(id: string): void;
  stop(): void;
};

function world(channel = false): Fixture {
  const base = realFs.mkdtempSync(join(tmpdir(), 'team-publication-gate-'));
  bases.push(base);
  const root = join(base, 'project');
  const home = join(base, 'home');
  const lobby = join(base, 'lobby');
  for (const dir of [join(root, '.agents'), home, lobby]) realFs.mkdirSync(dir, { recursive: true });
  const file = join(root, '.agents/team.yaml');
  const launch = channel ? 'claude --dangerously-load-development-channels server:team-inbox' : 'codex';
  const text = `format: 1
project: fixture-team
session: fixture-session
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
  - role: worker
    name: worker
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: ${launch}
`;
  realFs.writeFileSync(file, text);
  const state = {
    format: 1,
    sessions: {
      'fixture-session': {
        seats: { worker: { stage: 'ready', pane: 'fixture-pane' } },
        worktrees: {},
        briefs: {
          worker: {
            id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
            at: '2026-11-02T00:00:00Z',
            incarnation: 'inc_0123456789ab',
            epoch: EPOCH,
            sha256: 'a'.repeat(64),
            stage: 'claimed',
          },
        },
      },
    },
  };
  realFs.writeFileSync(join(root, '.agents/team.state.json'), JSON.stringify(state));
  upsertTeam(home, teamIdOf(root), {
    project: 'fixture-team',
    session: 'fixture-session',
    root,
    roster: [{ agent: 'agt_000000000001', seat: 'worker', role: 'coordinator' }],
  });
  const drop = join(root, '.agents/send-drops/fixture-session/worker');
  realFs.mkdirSync(drop, { recursive: true, mode: 0o700 });
  return {
    root,
    home,
    lobby,
    file,
    drop,
    message: (id) => {
      const record = signRecord({
        kind: 'message',
        id,
        to: 'worker',
        to_id: null,
        root,
        session: 'fixture-session',
        at: '2026-11-02T00:00:00Z',
        body: `SYNTHETIC_MESSAGE:${id}`,
        from: 'fixture-sender',
        from_id: null,
        rule: 'synthetic fixture',
        thread: id,
      }, home);
      realFs.writeFileSync(join(drop, id), JSON.stringify(record), { mode: 0o600 });
    },
    stop: () => {
      realFs.writeFileSync(file, text.replace('    name: worker\n', '    name: worker\n    stopped: true\n'));
    },
  };
}

function ioFor(w: Fixture, stderr: string[] = []): Io {
  return {
    cwd: w.lobby,
    env: {},
    stdinIsTTY: false,
    stdout: () => {},
    stderr: (line) => stderr.push(line),
    callerSources: () => ({
      env: {},
      stdinIsTTY: false,
      ancestors: () => [
        { pid: 301, name: 'codex' },
        { pid: 302, name: 'sh' },
        { pid: 303, name: 'sh' },
        { pid: 304, name: 'herdr' },
        { pid: 1, name: 'init' },
      ],
      agents: () => [
        { name: 'worker', agent: 'codex', pane: 'fixture-pane', workspace: 'fixture', status: 'idle', cwd: null },
      ],
      paneRootPid: () => 303,
      managedEndpointSeat: () => null,
    }),
  };
}

function serve(w: Fixture, lines: AsyncGenerator<string>, replies: unknown[], stderr: string[]) {
  return runMcpServe(
    { seat: 'worker', session: 'fixture-session', file: w.file, epoch: EPOCH },
    ioFor(w, stderr),
    { lines, write: (line: string) => replies.push(JSON.parse(line)) },
    { home: w.home, build: BUILD },
  );
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
}

describe('a seat stopped while its record is open', () => {
  for (const name of ['inbox_read', 'ack'] as const) {
    test(`${name} serves nothing and writes no receipt`, async () => {
      const w = world(name === 'ack');
      const id = name === 'ack' ? ID_ACK : ID_READ;
      w.message(id);
      const replies: unknown[] = [];
      const stderr: string[] = [];
      const lines = (async function* () {
        yield toolCall(1, 'inbox_check');
        // The check passed; the record's own open is where the seat is stopped.
        open = (path) => {
          if (path !== join(w.drop, id)) return;
          open = null;
          w.stop();
        };
        yield toolCall(2, name, { id });
      })();
      const code = await serve(w, lines, replies, stderr);
      expect(code).toBe(0);
      const answered = replies.filter((reply) => (reply as { id?: number }).id === 2);
      expect(answered).toHaveLength(1);
      expect((answered[0] as { result: { isError?: boolean; content: Array<{ text: string }> } }).result.isError).toBe(true);
      expect((answered[0] as { result: { content: Array<{ text: string }> } }).result.content[0]?.text).toContain('stopped');
      // No exposure, no proof of exposure.
      expect(realFs.existsSync(receiptPath(w.drop, id))).toBe(false);
      expect(JSON.stringify(replies)).not.toContain(`SYNTHETIC_MESSAGE:${id}`);
    });
  }
});

test('a channel push writes no marker and sends no notification for a record opened while the seat stops', async () => {
  const w = world(true);
  const replies: unknown[] = [];
  const stderr: string[] = [];
  let flipped = false;
  const lines = (async function* () {
    yield JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    // The positive control: an ordinary message written after startup is pushed once, so the
    // schedule below is known to reach the push.
    w.message(ID_PUSH_OK);
    await Bun.sleep(450);
    let opens = 0;
    open = (path) => {
      if (path !== join(w.drop, ID_PUSH_REFUSED)) return;
      opens += 1;
      // The inbox listing opens a record once; the second open is the push's own verification,
      // after the call's first declaration check.
      if (opens === 2) {
        open = null;
        flipped = true;
        w.stop();
      }
    };
    w.message(ID_PUSH_REFUSED);
    await Bun.sleep(700);
  })();
  const code = await serve(w, lines, replies, stderr);
  expect(code).toBe(0);
  const pushed = replies.filter((reply) => (reply as { method?: string }).method === CHANNEL_METHOD);
  expect(flipped).toBe(true);
  expect(pushed).toHaveLength(1);
  expect(JSON.stringify(pushed[0])).toContain(ID_PUSH_OK);
  expect(channelPushed(w.drop, ID_PUSH_OK)).toBe(true);
  expect(channelPushed(w.drop, ID_PUSH_REFUSED)).toBe(false);
  expect(JSON.stringify(replies)).not.toContain(`SYNTHETIC_MESSAGE:${ID_PUSH_REFUSED}`);
});
