// `team send` and the owner's send-grants: the command path reads the grants folder and admits a
// pair no registry rule reaches, and refuses — before any drop file exists — everything a record
// does not name. Fake host, synthetic home, no live session and no pane touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import type { NativePane } from '../src/send/native.ts';
import { readSendGrants } from '../src/send/grants.ts';
import { updateState } from '../src/state.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

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
# These scenes walk the typed trigger: the inbox is tried and skipped for want of a listener,
# then the line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function world(): { root: string; dir: string; sockets: string; home: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-grant-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), sockets, home };
}

function fake(sockets: string): SendHost {
  return {
    agents: () => [
      { name: 'helper', pane: 'w2:p1' },
      { name: 'native', pane: 'w9:p1' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async () => ({ ok: true }),
    native: scripted(['idle', 'working']),
    now: () => NOW,
    home: join(base, 'home'),
  };
}

function scripted(samples: string[]): NativePane {
  let read = 0;
  return {
    typeText: () => true,
    pressEnter: () => true,
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

/** The agent record `up` writes for a launched seat, the identity admission reads. */
function registerSeat(seat: string, role: string, pane: string): void {
  const id = `agt_${Buffer.from(seat).toString('hex').slice(0, 12).padEnd(12, '0')}`;
  const file = join(base, 'home', '.config', 'team', 'agents', `${id}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${id}"`,
      `name: "${seat}"`,
      'signing:',
      '  model: "Test"',
      '  version: "1"',
      `  role: "${role}"`,
      'lab: "test"',
      'cli: "claude-code"',
      'launcher: null',
      'launch: "claude"',
      'reach:',
      '  team: "acme"',
      `  seat: "${seat}"`,
      '  session: "acme"',
      `  pane: "${pane}"`,
      '  address: null',
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-16T12:00:00.000Z"',
      '  updated_at: "2026-10-16T12:00:00.000Z"',
      '',
    ].join('\n'),
  );
}

function record(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = { seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } }, worktrees: {} };
  });
}

/** One send-grant record where the owner writes it. */
function grantFile(home: string, stem: string, body: string): string {
  const folder = join(home, '.config', 'team', 'grants');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${stem}.yaml`);
  writeFileSync(file, body);
  return file;
}

const GRANT = (from: string, to: string, expires = '2026-11-16T00:00:00Z'): string =>
  `send:\n  from: ${from}\n  to: ${to}\nexpires: "${expires}"\n`;

/** The helper seat at its recorded pane, sending to the native reviewer. No listed rule reaches
 *  that pair — an implementer to a reviewer is seat to seat — so the grant folder is the only
 *  thing that can admit it. */
function helperSend(root: string, sockets: string): { code: Promise<number>; err: () => string; out: () => string } {
  const io = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
  const code = runSend(['native', 'a note'], io, fake(sockets));
  return { code, err: () => io.err, out: () => io.out };
}

describe('team send: the owner-signed grant on the command path', () => {
  test('a pair no rule admits reaches the drop file once the owner\'s record names it', async () => {
    const { root, dir, sockets, home } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');

    // Without a record: refused, and nothing is written — the refusal names the rules.
    const bare = testIo(root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
    expect(await runSend(['native', 'a note'], bare, fake(sockets))).toBe(1);
    expect(bare.err).toContain('team send: refused:');
    expect(bare.err).toContain('no rule admits it');
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);

    grantFile(home, 'helpers-to-reviewer', GRANT('helper@acme', 'native'));
    const { code, err, out } = helperSend(root, sockets);
    expect(await code).toBe(0);
    expect(err()).toBe('');
    expect(out()).toBe('team acme, session "acme"\nnative: delivered\n');
    const drops = join(dir, 'send-drops', 'acme', 'native');
    const path = join(drops, readdirSync(drops)[0] as string);
    expect(recordBody(path)).toBe(
      'from helper — admitted by: an owner-signed grant naming send (helpers-to-reviewer)\n\na note',
    );
  });

  test('a record naming another sender admits nothing: the caller\'s identity is the registry\'s', async () => {
    const { root, dir, sockets, home } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    // The record names the lead — a valid seat, but not the caller.
    grantFile(home, 'lead-to-reviewer', GRANT('lead@acme', 'native'));
    // And one naming another agent id outright, the forgery a record could attempt.
    grantFile(home, 'forged', GRANT(`agt_${Buffer.from('lead').toString('hex').padEnd(12, '0')}`, 'native'));

    const { code, err } = helperSend(root, sockets);
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
  });

  test('an expired record admits nothing, at and after its moment', async () => {
    const { root, dir, sockets, home } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    grantFile(home, 'lapsed', GRANT('helper@acme', 'native', '2026-10-16T11:59:59Z'));
    expect(await helperSend(root, sockets).code).toBe(1);

    grantFile(home, 'lapsed', GRANT('helper@acme', 'native', NOW.toISOString()));
    const { code, err } = helperSend(root, sockets);
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
  });

  test('a record naming another receiver admits nothing', async () => {
    const { root, dir, sockets, home } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    grantFile(home, 'wrong-receiver', GRANT('helper@acme', 'lead@acme'));
    const { code, err } = helperSend(root, sockets);
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
  });

  test('a grant file that is a symbolic link is not read', async () => {
    const { root, dir, sockets, home } = world();
    registerSeat('helper', 'implementer', 'w2:p1');
    record(dir, 'helper', 'w2:p1');
    // The record itself is well-formed; only the link stands where the folder is read, and the
    // folder never follows one — the send is refused as if the folder were empty.
    const elsewhere = join(base, 'outside.yaml');
    writeFileSync(elsewhere, GRANT('helper@acme', 'native'));
    const folder = join(home, '.config', 'team', 'grants');
    mkdirSync(folder, { recursive: true });
    symlinkSync(elsewhere, join(folder, 'linked.yaml'));

    const { code, err } = helperSend(root, sockets);
    expect(await code).toBe(1);
    expect(err()).toContain('no rule admits it');
  });

  test('a caller the store holds no record for is judged as the file\'s seat: its team\'s rules refuse it, grant or no grant', async () => {
    const { root, dir, sockets, home } = world();
    // The placement is recorded (so the caller is placed) but no agent record is registered: the
    // live file's declared seat is the identity, a seat may not send to a fellow seat, and the
    // store is never asked for a caller it holds no record of — the naming grant is not consulted.
    record(dir, 'helper', 'w2:p1');
    grantFile(home, 'helpers-to-reviewer', GRANT('helper@acme', 'native'));
    const { code, err } = helperSend(root, sockets);
    expect(await code).toBe(1);
    expect(err()).toContain('may not send to native@');
    expect(err()).toContain('no rule admits it');
    expect(existsSync(join(dir, 'send-drops'))).toBe(false);
  });
});

describe('readSendGrants: the shapes the folder hands over', () => {
  test('only a record naming a from, a to and a parseable expiry is a grant', () => {
    const { home } = world();
    grantFile(home, 'good', GRANT('helper@acme', 'native'));
    grantFile(home, 'no-send', 'expires: "2026-11-16T00:00:00Z"\n');
    grantFile(home, 'send-not-a-pair', 'send: "helper@acme -> native"\nexpires: "2026-11-16T00:00:00Z"\n');
    grantFile(home, 'no-to', 'send:\n  from: helper@acme\nexpires: "2026-11-16T00:00:00Z"\n');
    grantFile(home, 'no-expiry', 'send:\n  from: helper@acme\n  to: native\n');
    grantFile(home, 'unparseable-expiry', 'send:\n  from: helper@acme\n  to: native\nexpires: "soon"\n');
    grantFile(home, 'blank-from', 'send:\n  from: "  "\n  to: native\nexpires: "2026-11-16T00:00:00Z"\n');

    expect(readSendGrants(home)).toEqual([{ name: 'good', from: 'helper@acme', to: 'native', expires: '2026-11-16T00:00:00Z' }]);
  });

  test('a record may name itself, and a JSON record is read like a YAML one', () => {
    const { home } = world();
    grantFile(home, 'named', `name: the review channel\n${GRANT('helper@acme', 'native')}`);
    writeFileSync(
      join(home, '.config', 'team', 'grants', 'as-json.json'),
      JSON.stringify({ send: { from: 'radio/builder-1', to: 'teamcli/builder-1' }, expires: '2026-11-16T00:00:00Z' }),
    );
    expect(readSendGrants(home)).toEqual([
      { name: 'as-json', from: 'radio/builder-1', to: 'teamcli/builder-1', expires: '2026-11-16T00:00:00Z' },
      { name: 'the review channel', from: 'helper@acme', to: 'native', expires: '2026-11-16T00:00:00Z' },
    ]);
  });

  test('a symlinked grants folder hands over nothing', () => {
    const { home } = world();
    const real = join(home, 'elsewhere');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'good.yaml'), GRANT('helper@acme', 'native'));
    mkdirSync(join(home, '.config', 'team'), { recursive: true });
    symlinkSync(real, join(home, '.config', 'team', 'grants'));
    expect(readSendGrants(home)).toEqual([]);
  });
});
