// A team whose root is a plain folder, not a git repository: the record is in the registry under
// the folder's id, so `config get` already resolves the team from that folder. The write door
// must resolve the same team the same way: the owner-seat request path used to demand a git root,
// refusing `set --request` and `--approval` in the team's own folder. The gates (who writes, what
// needs a request, what is owner-only) are untouched; only the team's location changes.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import type { Io } from '../src/io.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Machine } from '../src/watch/machine.ts';
import { intoRegistry, storedTeam } from './helpers/registry-team.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const NOW = new Date('2026-10-31T12:00:00.000Z');
const detached: Caller = { kind: 'owner-no-tty' };
const fine: Machine = { loadPerCore: 1, memoryFree: 50, diskFree: 200e9, swapTotal: 9e9, swapFree: 8e9, swapUsed: 1e9 };

const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    inbound: hold
delivery_order: [mcp-inbox, typed]
`;

/** The same team with the worker stopped, as `remove worker --keep` leaves it. */
const STOPPED_TEAM = TEAM.replace('    inbound: hold\n', '    inbound: hold\n    stopped: true\n');

/** One team, its `.agents` folder, a temp home, and the owner seat: the root is a git checkout
 *  only when the scene asks for one. The team is moved into the home's registry, as migrate does. */
function place(git: boolean, team = TEAM): { home: string; root: string; store: FakeStore } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'config-root-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'code', 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  if (git) execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), team);
  const store = seatOwner(home);
  intoRegistry(root, home);
  return { home, root, store };
}

function ioOf(root: string, caller: Caller = detached): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(text: string) { io.out += text; },
    stderr(text: string) { io.err += text; },
    cwd: root,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    caller,
  };
  return io;
}

function sourcesOf(p: { home: string; store: FakeStore }): ConfigSources {
  return {
    home: p.home,
    env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' },
    now: () => NOW,
    ownerSeatStore: p.store,
  };
}

function requestId(text: string): string {
  return /owner-seat request (oa_[0-9a-f]{24})/.exec(text)?.[1] ?? '';
}

/** The registry's record of the fixture's team, exactly as the next run reads it. */
function recordText(p: { home: string; root: string }): string {
  return storedTeam(p.root, p.home)?.text ?? '';
}

describe('a team root that is not a git repository', () => {
  test('get and set --request resolve the same registry team, and an unset goes through the same door', async () => {
    const p = place(false);
    const sources = sourcesOf(p);
    const got = ioOf(p.root);
    expect(await runConfig(['get', 'project'], got, sources), got.err).toBe(0);
    expect(got.out.trim()).toBe('acme');

    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.inbound', 'accept', '--request'], ask, sources), ask.err).toBe(0);
    expect(ask.err).toBe('');
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    // A request writes nothing; the record still says the old word.
    expect(recordText(p)).toContain('inbound: hold');

    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.inbound', 'accept', '--approval', id], ran, sources), ran.err).toBe(0);
    expect(recordText(p)).toContain('inbound: accept');

    const after = ioOf(p.root);
    expect(await runConfig(['get', 'seats.worker.inbound'], after, sources), after.err).toBe(0);
    expect(after.out.trim()).toBe('accept');

    const unsetAsk = ioOf(p.root);
    expect(await runConfig(['unset', 'seats.worker.inbound', '--request'], unsetAsk, sources), unsetAsk.err).toBe(0);
    const unsetId = requestId(unsetAsk.out);
    expect(unsetId).not.toBe('');
    expect(recordText(p)).toContain('inbound: accept');
    expect(approveOwnerAction(p.home, unsetId, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const unset = ioOf(p.root);
    expect(await runConfig(['unset', 'seats.worker.inbound', '--approval', unsetId], unset, sources), unset.err).toBe(0);
    expect(recordText(p)).not.toContain('inbound: accept');
    const gone = ioOf(p.root);
    expect(await runConfig(['get', 'seats.worker.inbound'], gone, sources)).toBe(1);
  });

  test('the request still needs its approval: no write lands without it', async () => {
    const p = place(false);
    const sources = sourcesOf(p);
    const before = recordText(p);
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'project', 'touched', '--request'], ask, sources), ask.err).toBe(0);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    expect(recordText(p)).toBe(before);
    const other = ioOf(p.root);
    expect(await runConfig(['set', 'project', 'other', '--approval', id], other, sources)).toBe(1);
    expect(recordText(p)).toBe(before);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'project', 'touched', '--approval', id], ran, sources), ran.err).toBe(0);
    expect(recordText(p)).toContain('project: touched');
  });

  test('edit writes the same registry record from the same folder', async () => {
    const p = place(false);
    const sources = {
      ...sourcesOf(p),
      editor: (path: string) => {
        writeFileSync(path, readFileSync(path, 'utf8').replace('project: acme', 'project: edited'));
        return 0;
      },
    };
    const io = ioOf(p.root, { kind: 'owner' });
    expect(await runConfig(['edit'], io, sources), io.err).toBe(0);
    expect(recordText(p)).toContain('project: edited');
    const got = ioOf(p.root);
    expect(await runConfig(['get', 'project'], got, sources), got.err).toBe(0);
    expect(got.out.trim()).toBe('edited');
  });
});

describe('a git team root', () => {
  test('the same request and approval work, resolved from the git root', async () => {
    const p = place(true);
    const sources = sourcesOf(p);
    const got = ioOf(p.root);
    expect(await runConfig(['get', 'project'], got, sources), got.err).toBe(0);
    expect(got.out.trim()).toBe('acme');
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'project', 'touched', '--request'], ask, sources), ask.err).toBe(0);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    expect(recordText(p)).toContain('project: acme');
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'project', 'touched', '--approval', id], ran, sources), ran.err).toBe(0);
    expect(recordText(p)).toContain('project: touched');
  });
});

function addSourcesOf(p: { home: string; store: FakeStore }): AddSources {
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home: p.home,
  };
  return {
    home: p.home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor,
    machine: () => fine,
    now: () => NOW,
    launch: {} as Launch,
    ownerSeatStore: p.store,
  };
}

describe('add from a team root that is not a git repository', () => {
  test('its request files from the folder, and the approval opens the same door', async () => {
    const p = place(false);
    const sources = addSourcesOf(p);
    const before = recordText(p);
    const ask = ioOf(p.root);
    expect(await runAdd(['worker-2', '--like', 'worker', '--request'], ask, sources), ask.err).toBe(0);
    const id = requestId(ask.out);
    expect(id).not.toBe('');
    // A request records nothing in the team's record.
    expect(recordText(p)).toBe(before);
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const run = ioOf(p.root);
    expect(await runAdd(['worker-2', '--like', 'worker', '--approval', id, '--dry-run'], run, sources), run.err).toBe(0);
    // The approval admitted this run past the door: it reached the plan it would run.
    expect(run.out).toContain('workspace create');
    expect(run.err).not.toContain('not inside a git repository');
    expect(recordText(p)).toBe(before);
  });

  test('control: a git root files the same request', async () => {
    const p = place(true);
    const sources = addSourcesOf(p);
    const ask = ioOf(p.root);
    expect(await runAdd(['worker-2', '--like', 'worker', '--request'], ask, sources), ask.err).toBe(0);
    expect(requestId(ask.out)).not.toBe('');
  });
});

// A stopped seat's sign-off is its own team's to lift: the lead clears exactly
// `seats.<seat>.stopped` with no owner card and no dev mode, on its own recorded pane. Every
// other key, and every other seat, keeps the owner-only door.
describe('a lead clears its own team\'s stopped mark', () => {
  const leadCaller: Caller = { kind: 'seat', name: 'lead', pane: 'pane-lead', session: 'acme' };
  const workerCaller: Caller = { kind: 'seat', name: 'worker', pane: 'pane-old', session: 'acme' };
  const rivalCaller: Caller = { kind: 'seat', name: 'rival-lead', pane: 'pane-rival', session: 'acme' };

  /** The state places the seat on its own recorded pane, ready — the proof the map reads. */
  function placed(root: string, caller: Caller): void {
    if (caller.kind !== 'seat' || caller.pane === undefined) throw new Error('a placed seat names its pane');
    updateState(join(root, '.agents'), (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats[caller.name] = { stage: 'ready', pane: caller.pane, workspace: `ws-${caller.name}` };
    });
  }

  test('the team\'s lead unsets its stopped seat\'s mark with no card, and the registry records it', async () => {
    const p = place(false, STOPPED_TEAM);
    placed(p.root, leadCaller);
    expect(recordText(p)).toContain('stopped: true');
    const io = ioOf(p.root, leadCaller);
    expect(await runConfig(['unset', 'seats.worker.stopped'], io, sourcesOf(p)), io.err).toBe(0);
    // No owner-seat request was filed: the write was admitted on the lead's placement alone.
    expect(io.out).not.toContain('owner-seat request');
    expect(recordText(p)).not.toContain('stopped: true');
    const got = ioOf(p.root);
    expect(await runConfig(['get', 'seats.worker.stopped'], got, sourcesOf(p))).toBe(1);
  });

  test('a worker is refused the same unset, and the mark stays', async () => {
    const p = place(false, STOPPED_TEAM);
    placed(p.root, workerCaller);
    const io = ioOf(p.root, workerCaller);
    expect(await runConfig(['unset', 'seats.worker.stopped'], io, sourcesOf(p))).toBe(1);
    expect(io.err).toContain("only the owner edits the team's record");
    expect(recordText(p)).toContain('stopped: true');
  });

  test('another team\'s lead is refused the same unset, and the mark stays', async () => {
    const p = place(false, STOPPED_TEAM);
    placed(p.root, rivalCaller);
    const io = ioOf(p.root, rivalCaller);
    expect(await runConfig(['unset', 'seats.worker.stopped'], io, sourcesOf(p))).toBe(1);
    expect(io.err).toContain("only the owner edits the team's record");
    expect(recordText(p)).toContain('stopped: true');
  });

  test('the lead is refused every other key: only the stopped mark is its to lift', async () => {
    const p = place(false, STOPPED_TEAM);
    placed(p.root, leadCaller);
    const io = ioOf(p.root, leadCaller);
    expect(await runConfig(['unset', 'seats.worker.inbound'], io, sourcesOf(p))).toBe(1);
    expect(io.err).toContain("only the owner edits the team's record");
    expect(recordText(p)).toContain('inbound: hold');
  });
});

