// `team archive`: the snapshot it writes — the team file, the state and the queues, verbatim, with
// a manifest that names them — and the stop it runs afterwards, which is `down`'s own run, with
// its own refusals and its own exit. A refused stop leaves the snapshot behind.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runArchive, sha256, writeArchive } from '../src/commands/archive.ts';
import type { DownSources } from '../src/commands/down.ts';
import { updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T12:00:00Z');
const STAMP = '20261015T120000Z';
const owner = { kind: 'owner' } as const;
const DETACHED = { kind: 'owner-no-tty' } as const;
const SEAT = { kind: 'seat', name: 'worker', pane: 'w2:p1', session: 'acme' } as const;

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function file(root: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5

  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

/** A project with a team file, a recorded state, two seats' queues and a link where a third
 *  seat's queue would be: everything an archive holds, and one thing it must not follow. */
function repo(): { root: string; home: string; agents: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-archive-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  const agents = join(root, '.agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(agents, 'team.yaml'), file(root));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  updateState(agents, (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'ready', pane: 'w1:p1' } } } as never;
  });
  for (const [seat, ids] of [['lead', ['c4a1']], ['worker', ['9b02', '9b03']]] as const) {
    for (const id of ids) {
      mkdirSync(join(agents, 'send-drops', 'acme', seat), { recursive: true });
      writeFileSync(join(agents, 'send-drops', 'acme', seat, id), `to ${seat}: ${id}\n`);
    }
  }
  mkdirSync(join(agents, 'send-drops', 'acme', 'observer'), { recursive: true });
  symlinkSync('/etc/hosts', join(agents, 'send-drops', 'acme', 'observer', 'linked'));
  return { root, home, agents };
}

/** What the tests stand in for `down`'s own reads: an idle session, and one that counts the
 *  stops it was asked for. A stop is only ever asked for through the real `runDown`. A stopped
 *  session reports stopped — that is what lets `down` clear it, and its own run tests that. */
function downSources(home: string, stopped: { n: number } = { n: 0 }, running = false): DownSources {
  return {
    sessionRunning: () => running && stopped.n === 0,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    sleep: async () => {},
    home,
    launch: {
      typeText: () => true,
      sendKey: () => true,
      pressEnter: () => true,
      agentPanes: () => [],
      closeWorkspace: () => true,
      stopSession: () => {
        stopped.n += 1;
        return true;
      },
      deleteSession: () => true,
      kill: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  };
}

const archiveRoot = (home: string): string => join(home, '.config', 'team', 'archive');

test('archives the team file, the state and the queues, then runs the stop', async () => {
  const { root, home, agents } = repo();
  const before = {
    team: readFileSync(join(agents, 'team.yaml')),
    state: readFileSync(join(agents, 'team.state.json')),
  };
  const io = testIo(root, owner);
  expect(await runArchive([], io, downSources(home))).toBe(0);

  const folders = readdirSync(archiveRoot(home));
  expect(folders).toHaveLength(1);
  const folder = folders[0] as string;
  expect(folder).toMatch(new RegExp(`^acme-[0-9a-f]{12}-${STAMP}$`));
  const dir = join(archiveRoot(home), folder);
  expect(io.out).toBe(
    `archived ${dir}:\n` +
    '  team.yaml\n' +
    '  team.state.json\n' +
    '  send-drops (3 files)\n' +
    'session acme is not running: nothing to stop\n',
  );

  expect(readFileSync(join(dir, 'team.yaml'))).toEqual(before.team);
  expect(readFileSync(join(dir, 'team.state.json'))).toEqual(before.state);
  expect(readFileSync(join(dir, 'send-drops', 'acme', 'worker', '9b02'), 'utf8')).toBe('to worker: 9b02\n');
  // The link is not a file this team wrote: it is left out, and nothing is read through it.
  expect(existsSync(join(dir, 'send-drops', 'acme', 'observer', 'linked'))).toBe(false);
  expect(lstatSync(join(dir, 'send-drops', 'acme', 'worker', '9b02')).isFile()).toBe(true);

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({
    format: 1,
    kind: 'teamcli-archive',
    project: 'acme',
    session: 'acme',
    root,
    stampedAt: NOW.toISOString(),
    by: 'owner',
  });
  expect(manifest.team.sha256).toBe(sha256(before.team));
  expect(manifest.team.bytes).toBe(before.team.byteLength);
  expect(manifest.state.sha256).toBe(sha256(before.state));
  expect(manifest.drops).toEqual({ files: 3, seats: { 'acme/lead': 1, 'acme/worker': 2 } });
  expect(manifest.teamcli).toMatch(/^\d+\.\d+\.\d+/);

  // The stop's own run wrote its `last_valid` after the snapshot: the copy is the state as it
  // was, never a state this run made.
  expect(readFileSync(join(agents, 'team.state.json'))).not.toEqual(before.state);
  expect(readFileSync(join(agents, 'team.log'), 'utf8'))
    .toMatch(new RegExp(` archive \\[owner\\] ${folder}: team\\.yaml, team\\.state\\.json, send-drops \\(3 files\\); stopping`));
});

test('a team that never launched has no state and no drops, and the archive holds neither', async () => {
  const { root, home, agents } = repo();
  rmSync(join(agents, 'team.state.json'));
  rmSync(join(agents, 'send-drops'), { recursive: true });
  const io = testIo(root, owner);
  expect(await runArchive([], io, downSources(home))).toBe(0);
  expect(io.out).toContain('  team.yaml\n');
  expect(io.out).not.toContain('team.state.json');
  expect(io.out).not.toContain('send-drops');
  const dir = join(archiveRoot(home), readdirSync(archiveRoot(home))[0] as string);
  expect(readdirSync(dir).sort()).toEqual(['manifest.json', 'team.yaml']);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  expect(manifest.state).toBe(null);
  expect(manifest.drops).toBe(null);
});

test('--keep-running takes the snapshot alone and never reaches the stop', async () => {
  const { root, home } = repo();
  const stopped = { n: 0 };
  const io = testIo(root, owner);
  expect(await runArchive(['--keep-running'], io, downSources(home, stopped, true))).toBe(0);
  expect(io.out).toMatch(/^archived .*\n  team\.yaml\n  team\.state\.json\n  send-drops \(3 files\)\n--keep-running: the stop is skipped\.\n$/);
  expect(stopped.n).toBe(0);
  expect(readdirSync(archiveRoot(home))[0]).toMatch(new RegExp(`-${STAMP}$`));
  expect(readFileSync(join(root, '.agents', 'team.log'), 'utf8')).toMatch(/; the stop was skipped/);
});

test('--dry-run prints both halves and writes nothing at all', async () => {
  const { root, home } = repo();
  const io = testIo(root, owner);
  expect(await runArchive(['--dry-run'], io, downSources(home))).toBe(0);
  expect(io.out).toContain('would archive to ');
  expect(io.out).toContain('  team.yaml\n');
  expect(io.out).toContain('  send-drops (3 files)\n');
  expect(io.out).toContain('dry run: nothing was archived\nwould stop the team:\n');
  expect(io.out).toContain('dry run: nothing was run');
  expect(existsSync(archiveRoot(home))).toBe(false);
  expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
});

test('the stop is the real one: a running session is stopped, and the snapshot is already there', async () => {
  const { root, home } = repo();
  const stopped = { n: 0 };
  const io = testIo(root, owner);
  expect(await runArchive([], io, downSources(home, stopped, true))).toBe(0);
  expect(io.out).toContain('stopped and cleared');
  expect(stopped.n).toBe(1);
  expect(readdirSync(archiveRoot(home))).toHaveLength(1);
});

test("a refused stop leaves the snapshot behind, in the stop's own words", async () => {
  const { root, home } = repo();
  // A running session and a seat that is neither the orchestrator nor the operator: stopping is
  // `down`'s refusal, and the archive this run wrote before asking stays where it is.
  const io = testIo(root, SEAT);
  expect(await runArchive([], io, downSources(home, { n: 0 }, true))).toBe(1);
  expect(io.err).toContain('team down: ');
  expect(io.out).toContain('archived ');
  expect(readdirSync(archiveRoot(home))).toHaveLength(1);
});

test('--out is the owner\'s, --file is the owner\'s, and a run with no terminal is refused', async () => {
  const { root, home } = repo();
  const outIo = testIo(root, SEAT);
  expect(await runArchive(['--out', join(home, 'elsewhere')], outIo, downSources(home))).toBe(1);
  expect(outIo.err).toBe("team archive: --out is the owner's, from a terminal outside herdr; this call is worker\n");
  expect(existsSync(join(home, 'elsewhere'))).toBe(false);

  const fileIo = testIo(root, SEAT);
  expect(await runArchive(['--file', join(root, '.agents', 'team.yaml')], fileIo, downSources(home))).toBe(1);
  expect(fileIo.err).toBe("team archive: --file is the owner's, from a terminal outside herdr; this call is worker\n");

  const detachedIo = testIo(root, DETACHED);
  expect(await runArchive([], detachedIo, downSources(home))).toBe(1);
  expect(detachedIo.err).toBe('team archive: only the owner runs this, from a terminal outside herdr\n');
  expect(existsSync(archiveRoot(home))).toBe(false);
});

test("--keep-running with the stop's own flags is refused rather than quietly ignored", async () => {
  const { root, home } = repo();
  for (const flags of [['--keep-running', '--abandon'], ['--keep-running', '--wait'], ['--keep-running', '--session', 'other']]) {
    const io = testIo(root, owner);
    expect(await runArchive(flags, io, downSources(home))).toBe(2);
    expect(io.err).toContain('--keep-running takes the snapshot alone');
    expect(io.out).toBe('');
    expect(io.err).not.toContain('Usage:');
  }
  const extra = testIo(root, owner);
  expect(await runArchive(['extra'], extra, downSources(home))).toBe(2);
  expect(extra.err).toContain('team archive: unexpected "extra"');
  expect(extra.err).toContain('Usage: team archive');
  expect(existsSync(archiveRoot(home))).toBe(false);
});

test('a relative --out is the caller\'s own folder, never the process\'s', async () => {
  const { root, home } = repo();
  const io = testIo(root, owner);
  expect(await runArchive(['--keep-running', '--out', 'archives'], io, downSources(home))).toBe(0);
  const dir = join(root, 'archives');
  expect(readdirSync(dir)).toHaveLength(1);
  expect(io.out).toBe(
    `archived ${dir}/${readdirSync(dir)[0] as string}:\n` +
    '  team.yaml\n' +
    '  team.state.json\n' +
    '  send-drops (3 files)\n' +
    '--keep-running: the stop is skipped.\n',
  );
});

test('an archive is never overwritten: the same run twice is refused the second time', async () => {
  const { root, home } = repo();
  expect(await runArchive(['--keep-running'], testIo(root, owner), downSources(home))).toBe(0);
  const again = testIo(root, owner);
  expect(await runArchive(['--keep-running'], again, downSources(home))).toBe(1);
  expect(again.err).toMatch(/exists already: an archive is never overwritten\n$/);
  expect(readdirSync(archiveRoot(home))).toHaveLength(1);
});

test('a folder that is not a repository is refused, and nothing is written', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-archive-bare-')));
  dirs.push(base);
  const home = join(base, 'home');
  mkdirSync(home);
  const io = testIo(base, owner);
  expect(await runArchive([], io, downSources(home))).toBe(2);
  expect(io.err).toContain('not inside a git repository: run team from a project, or pass --file');
  expect(existsSync(archiveRoot(home))).toBe(false);
});

test('writeArchive plans, writes once, and refuses the folder it already wrote', () => {
  const { root, home } = repo();
  const out = join(home, 'archives');
  const options = {
    file: join(root, '.agents', 'team.yaml'),
    root,
    project: 'acme',
    session: 'acme',
    home,
    out,
    caller: 'owner',
    now: NOW,
    dry: true,
  };
  const planned = writeArchive(options);
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  expect(basename(planned.dir)).toMatch(new RegExp(`^acme-[0-9a-f]{12}-${STAMP}$`));
  expect(planned.lines).toEqual(['team.yaml', 'team.state.json', 'send-drops (3 files)']);
  expect(existsSync(planned.dir)).toBe(false);

  const first = writeArchive({ ...options, dry: false });
  expect(first).toEqual(planned);
  expect(existsSync(planned.dir)).toBe(true);
  const second = writeArchive({ ...options, dry: false });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.reason).toContain('exists already');
});
