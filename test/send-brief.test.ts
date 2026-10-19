// `team send --brief <file>`: the whole draft brief is read into the body, exactly as --file
// does, and a body that is only a path to a brief file is warned about (never refused). The
// scenes use a human seat, whose walk is the drop leg alone, so every run writes one signed
// record and types nothing; the record's body is what the seat would read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import type { NativePane } from '../src/send/native.ts';
import { testIo, type TestIo } from './helpers.ts';

const NOW = new Date('2026-10-19T20:00:00.000Z');
const SESSION = 'briefs';
const SEAT = 'reader';
const HEADER = 'from the owner — admitted by: the owner';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; dir: string; home: string; sockets: string };

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'send-brief-')));
  made.push(base);
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: acme
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - role: coordinator
    name: ${SEAT}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    human: true
`);
  return { base, root, dir, home, sockets };
}

function fake(w: World): SendHost {
  const native: NativePane = {
    typeText: () => {
      throw new Error('a human seat is never typed into');
    },
    pressEnter: () => {
      throw new Error('a human seat is never typed into');
    },
    status: () => 'idle',
    wait: async () => {},
  };
  return {
    agents: () => [{ name: SEAT, pane: 'w1:p1' }],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: w.home,
  };
}

function io(w: World): TestIo {
  return testIo(w.root, { kind: 'owner' });
}

/** The one drop record the send wrote, parsed. */
function record(w: World): { id: string; body: string } {
  const dropDir = join(w.dir, 'send-drops', SESSION, SEAT);
  const names = readdirSync(dropDir);
  expect(names).toHaveLength(1);
  const parsed = JSON.parse(readFileSync(join(dropDir, names[0]!), 'utf8')) as { payload: { id: string; body: string } };
  return parsed.payload;
}

function brief(w: World, name: string, text: string): string {
  const dir = join(w.root, 'briefs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

describe('team send --brief reads the whole draft into the body', () => {
  test('the record carries the file verbatim under the sender header', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'First line.\nSecond line: do the thing.\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(record(w).body).toBe(`${HEADER}\n\nFirst line.\nSecond line: do the thing.\n`);
    expect(on.err).toBe('');
  });

  test('--brief and --file together are a usage refusal naming both', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'text\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path, '--file', path], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('a brief and --file cannot both be given');
  });

  test('--brief and an inline message together are a usage refusal', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'text\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path, 'and', 'this'], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('a message and --brief cannot both be given');
  });

  test('a brief file that cannot be read is a configuration refusal', async () => {
    const w = world();
    const on = io(w);

    const code = await runSend([SEAT, '--brief', join(w.root, 'briefs', 'missing.md')], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('the message file cannot be read');
  });

  test('an empty brief file is refused as an empty message', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', '\n\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path], on, fake(w));

    expect(code).toBe(2);
    expect(on.err).toContain('the message is empty');
  });
});

describe('a body that only points at a brief is warned about', () => {
  test('an inline body that is one path to an existing brief warns and still sends', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'the whole brief\n');
    const on = io(w);

    const code = await runSend([SEAT, path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toContain(`${SEAT}: the body only points at a brief (${path}); send the brief itself`);
    expect(record(w).body).toBe(`${HEADER}\n\n${path}`);
  });

  test('a --brief file whose own text is only another brief path is warned about too', async () => {
    const w = world();
    const inner = brief(w, 'inner.md', 'the whole brief\n');
    const outer = brief(w, 'outer.md', `${inner}\n`);
    const on = io(w);

    const code = await runSend([SEAT, '--brief', outer], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toContain('the body only points at a brief');
    expect(record(w).body).toBe(`${HEADER}\n\n${inner}\n`);
  });

  test('a prose body that mentions a brief path is not a pointer and draws no warning', async () => {
    const w = world();
    const path = brief(w, 'lead-to-reader.md', 'the whole brief\n');
    const on = io(w);

    const code = await runSend([SEAT, `read this and do that: ${path}`], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toBe('');
  });

  test('a path to a file that is not under briefs/ draws no warning', async () => {
    const w = world();
    const notes = join(w.root, 'notes');
    mkdirSync(notes, { recursive: true });
    const path = join(notes, 'task.md');
    writeFileSync(path, 'text\n');
    const on = io(w);

    const code = await runSend([SEAT, path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(on.err).toBe('');
  });

  // `brief-transport` governs the general seat brief a launch delivers, not an ordinary send.
  // A `--brief` send is an ordinary send: it never reads the policy, so a team that chose
  // `memory` for launches still sends this draft through its own legs and writes the record.
  test('a memory brief-transport does not change an ordinary --brief send', async () => {
    const w = world();
    const wrote = writePolicySet(
      w.home,
      { level: 'team', target: w.root, teamRoot: w.root, name: 'brief-transport', value: 'memory' },
      { now: NOW },
    );
    expect(wrote.ok).toBe(true);
    const path = brief(w, 'lead-to-reader.md', 'First line.\nSecond line.\n');
    const on = io(w);

    const code = await runSend([SEAT, '--brief', path], on, fake(w));

    expect(code, on.err).toBe(0);
    expect(record(w).body).toBe(`${HEADER}\n\nFirst line.\nSecond line.\n`);
  });
});
