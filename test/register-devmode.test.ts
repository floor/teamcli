// `team register` under dev mode, and its dry run: the caller gate becomes a warning and the
// run continues — the shape `up` and `down` keep — while everything else stays enforced; a dry
// run is never a bare refusal, and a registration dev mode admitted says so in its record.
//
// (a) TEAMCLI_DEV_MODE=1: an unplaced caller registers with the caller gate said once as a
//     warning on stderr, the folded gate written to the audit log, and the run writes its own
//     record line;
// (b) unset: the same call is refused with the bare sentence, and nothing is written;
// (c) TEAMCLI_DEV_MODE=1: a pane herdr does not place as the seat — none of the name in the
//     session, or one whose foreground is not the file-cli's program — is still refused;
// (d) --dry-run: the refusal is never bare — it is said as `! register would refuse:` with the
//     owner's own command beside it (`! to unblock:`) — and under dev mode the gate is the
//     warning instead: the run reports the record it would write, and writes nothing either way.
// Fake herdr throughout, a temporary home and a pinned caller: no live session is read.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { describeCaller } from '../src/caller.ts';
import { runRegister, type RegisterSources } from '../src/commands/register.ts';
import { setHerdrRun, type HerdrAgent } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readAgents } from '../src/registry/agents.ts';
import { LOG_FILE, readState, STATE_FILE } from '../src/state.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const OWNER = { kind: 'owner' as const };
// A caller under herdr that herdr does not place as the seat, and that no file section admits:
// the one shape the caller gate is for.
const UNPLACED = { kind: 'unplaced' as const, reason: 'it runs under herdr' };
// The pane the fake herdr places the seat in.
const PANE = 'w1:p1';
const WORKSPACE = 'ws-1';

/** The caller gate's sentence, as both the refusal and the warning carry it. */
const CALLER_GATE =
  'only the owner or a seat of this team registers a running seat; this call is unplaced (it runs under herdr)';
/** The one command behind that gate: the owner's own run, from the same folder. */
const UNBLOCK = '! to unblock: a seat of this team runs `team register lead` from its own pane (the owner runs it from this folder, at a terminal outside herdr)';

const made: string[] = [];
// The address refresh reads herdr on its own; no pane of this machine's is behind it here, and
// an unreadable pane is the reading that leaves a record alone.
beforeEach(() => {
  setHerdrRun(() => {
    throw new Error('herdr is not there');
  });
});
afterEach(() => {
  setHerdrRun(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; home: string; root: string; dir: string };

/** A temporary home and one root with `.agents/team.yaml` — the shape `team register` reads. */
function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'reg-dev-')));
  made.push(base);
  const home = join(base, 'h');
  mkdirSync(lobbyDir(home), { recursive: true });
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
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
`);
  return { base, home, root, dir: join(root, '.agents') };
}

/** The agent herdr reports for the seat: a pane running a program in front of its own shell. */
function agent(name: string): HerdrAgent {
  return { name, agent: 'claude', pane: PANE, workspace: WORKSPACE, status: 'idle', cwd: null, session: 'claude-session-1' };
}

/** The reads `register` takes, faked; only the readers a scene replaces differ. */
function sources(w: World, over: Partial<RegisterSources> = {}): RegisterSources {
  return {
    home: w.home,
    sessionState: () => 'running',
    agents: () => [agent('lead')],
    processInfo: () => ({ shell: 400, foreground: [401] }),
    foreground: () => ['claude'],
    paneText: () => CLAUDE_IDLE,
    now: () => NOW,
    ...over,
  };
}

async function register(
  w: World,
  argv: string[],
  options: { caller?: Caller; dev?: boolean; over?: Partial<RegisterSources> } = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(w.root, options.caller ?? OWNER);
  if (options.dev) io.env = { TEAMCLI_DEV_MODE: '1' };
  const code = await runRegister(argv, io, sources(w, options.over ?? {}));
  return { code, out: io.out, err: io.err };
}

/** What the run left on disk: the state file, agent records, the log and the pane pointers. */
function written(w: World): { state: boolean; agents: number; log: boolean; panes: boolean } {
  return {
    state: existsSync(join(w.dir, STATE_FILE)),
    agents: readAgents(w.home).length,
    log: existsSync(join(w.dir, LOG_FILE)),
    panes: existsSync(join(w.home, '.config', 'team', 'panes')),
  };
}

const NOTHING = { state: false, agents: 0, log: false, panes: false };

/** A team file naming one delegate pane for `up` — the section that asks the approval gate. */
function withDelegate(w: World): void {
  const file = join(w.dir, 'team.yaml');
  writeFileSync(file, `${readFileSync(file, 'utf8')}delegates:
  - pane: floor/w2:p1
    commands: [up, add, remove]
`);
}

/** The caller the delegate section names: a seat on the file's delegate pane, outside the team's
 *  own session. The delegation gates past approval still judge this placement. */
const DELEGATE = { kind: 'seat' as const, name: 'lead', pane: 'w2:p1', session: 'floor' };

test('TEAMCLI_DEV_MODE=1: the delegate approval precondition folds exactly as add and remove fold it', async () => {
  const w = world();
  withDelegate(w);
  // Herdr answers with no agents: the delegate evidence passes, and the caller is the file's
  // delegate pane, so the only gate in the way is the approval precondition.
  setHerdrRun(() => ({ agents: [] }));
  const r = await register(w, ['lead'], { caller: DELEGATE, dev: true });
  expect(r.code).toBe(0);
  // The live complaint, now a warning: the approval precondition is folded, and the run says so.
  expect(r.err).toContain('team register: warning: delegation needs a verified approval: the file was never approved on this machine; the live team file ');
  expect(r.err).toContain('counts as approved; dev mode continues');
  // The record the run writes carries the fold, the mark `add` and `remove` keep.
  expect(r.err).not.toContain('team register: delegation needs a verified approval');
  expect(readFileSync(join(w.dir, LOG_FILE), 'utf8')).toContain('warning: delegation needs a verified approval: the file was never approved on this machine');
  expect(readState(w.dir).sessions.acme?.seats.lead?.stage).toBe('ready');
});

test('without dev mode the same delegate file is still refused by the approval gate', async () => {
  const w = world();
  withDelegate(w);
  setHerdrRun(() => ({ agents: [] }));
  const r = await register(w, ['lead'], { caller: DELEGATE });
  expect(r.code).toBe(1);
  expect(r.err).toBe('team register: delegation needs a verified approval: the file was never approved on this machine\n');
  expect(written(w)).toEqual(NOTHING);
});

test('TEAMCLI_DEV_MODE=1: an unplaced caller registers with the caller gate as a warning', async () => {
  const w = world();
  const r = await register(w, ['lead'], { caller: UNPLACED, dev: true });
  expect(r.code).toBe(0);
  expect(r.err).toContain(`team register: warning: ${CALLER_GATE}; dev mode continues\n`);
  expect(r.err).not.toContain(`team register: ${CALLER_GATE}`);
  expect(written(w)).toEqual({ state: true, agents: 1, log: true, panes: true });
  // Two audit lines: the folded gate, written where the gate is used, and the record's own.
  const log = readFileSync(join(w.dir, LOG_FILE), 'utf8');
  expect(log).toContain(`warning: ${CALLER_GATE}; dev mode continues\n`);
  expect(log).toContain('lead: registered seat_');
  expect(log).toContain(PANE);
  expect(readState(w.dir).sessions.acme?.seats.lead?.stage).toBe('ready');
  // The record says so: the provenance carries the mark, and the caller the run kept beside it.
  const record = readAgents(w.home)[0];
  expect(record?.provenance.dev_mode).toBe(true);
  expect(record?.provenance.registered_by).toBe(describeCaller(UNPLACED));
  const file = readFileSync(join(w.home, '.config', 'team', 'agents', `${record?.id}.yaml`), 'utf8');
  expect(file).toContain('  dev_mode: true\n');
});

test('a run in force writes the record again and the mark comes off', async () => {
  const w = world();
  const dev = await register(w, ['lead'], { caller: UNPLACED, dev: true });
  expect(dev.code).toBe(0);
  expect(readAgents(w.home)[0]?.provenance.dev_mode).toBe(true);

  // The owner's own run: the seat is already on that pane, so the already path rewrites the
  // registry record from the file — the repair the mark's own finding names (`team check`).
  const again = await register(w, ['lead'], { caller: OWNER });
  expect(again.code).toBe(0);
  expect(again.out).toContain(`lead: already registered — pane ${PANE}`);
  const record = readAgents(w.home)[0];
  expect(record?.provenance.dev_mode).toBeUndefined();
  expect(readFileSync(join(w.home, '.config', 'team', 'agents', `${record?.id}.yaml`), 'utf8')).not.toContain('dev_mode');
});

test('a dev-mode re-registration by another caller keeps the registrant and names that caller', async () => {
  const w = world();
  // The owner registers first: `registered_by` is the owner's from here on, in every write.
  expect((await register(w, ['lead'], { caller: OWNER })).code).toBe(0);
  const before = readAgents(w.home)[0];
  expect(before?.provenance.registered_by).toBe('owner');

  // A dev-mode run by a caller the gate folds writes the same record again. The mark is kept
  // beside the registrant, and the caller that run admitted is recorded with it — not the owner
  // the record still names, which is the difference `team check` must not point at.
  const again = await register(w, ['lead'], { caller: UNPLACED, dev: true });
  expect(again.code).toBe(0);
  const record = readAgents(w.home)[0];
  expect(record?.id).toBe(before?.id);
  expect(record?.provenance.registered_by).toBe('owner');
  expect(record?.provenance.dev_mode).toBe(true);
  expect(record?.provenance.dev_mode_by).toBe(describeCaller(UNPLACED));
  expect(record?.provenance.dev_mode_at).toBeDefined();
  const file = readFileSync(join(w.home, '.config', 'team', 'agents', `${record?.id}.yaml`), 'utf8');
  expect(file).toContain(`  dev_mode_by: ${JSON.stringify(describeCaller(UNPLACED))}\n`);
});

test('unset, and the same call is refused with the bare sentence', async () => {
  const w = world();
  const r = await register(w, ['lead'], { caller: UNPLACED });
  expect(r.code).toBe(1);
  expect(r.err).toBe(`team register: ${CALLER_GATE}\n`);
  expect(r.out).toBe('');
  expect(written(w)).toEqual(NOTHING);
});

test('TEAMCLI_DEV_MODE=1: a pane herdr does not place as the seat is still refused', async () => {
  // No agent of the name in the session: the placement check, still enforced past the warning.
  const missing = world();
  const noAgent = await register(missing, ['lead'], { caller: UNPLACED, dev: true, over: { agents: () => [] } });
  expect(noAgent.code).toBe(1);
  expect(noAgent.err).toContain('team register: warning:');
  expect(noAgent.err).toContain('no agent named lead is running in session "acme"');
  // Nothing was registered, and the folded gate is on record all the same.
  expect(written(missing)).toEqual({ ...NOTHING, log: true });
  expect(readFileSync(join(missing.dir, LOG_FILE), 'utf8')).toContain(`warning: ${CALLER_GATE}; dev mode continues\n`);

  // An agent of the name whose foreground process is not the file-cli's program: still refused.
  const foreign = world();
  const other = await register(foreign, ['lead'], { caller: UNPLACED, dev: true, over: { foreground: () => ['bash'] } });
  expect(other.code).toBe(1);
  expect(other.err).toContain('team register: warning:');
  expect(other.err).toContain('lead: pane w1:p1 holds no `claude-code` process; nothing was registered');
  expect(written(foreign)).toEqual({ ...NOTHING, log: true });
  expect(readFileSync(join(foreign.dir, LOG_FILE), 'utf8')).toContain(`warning: ${CALLER_GATE}; dev mode continues\n`);
});

test('--dry-run says the refusal and the owner\'s own command, and under dev mode the record instead', async () => {
  const w = world();
  const r = await register(w, ['lead', '--dry-run'], { caller: UNPLACED });
  expect(r.code).toBe(1);
  expect(r.err).toBe('');
  expect(r.out).toContain(`! register would refuse: ${CALLER_GATE}\n`);
  expect(r.out).toContain(`${UNBLOCK}\n`);
  expect(r.out).not.toContain('would register');
  expect(written(w)).toEqual(NOTHING);

  // The live complaint: with dev mode the same dry run says the warning instead of the refusal,
  // reports the record it would write, and exits 0 — nothing refused, nothing written.
  const mounted = world();
  const dev = await register(mounted, ['lead', '--dry-run'], { caller: UNPLACED, dev: true });
  expect(dev.code).toBe(0);
  expect(dev.out).toContain(`! warning: ${CALLER_GATE}; dev mode continues\n`);
  expect(dev.out).not.toContain('! register would refuse:');
  expect(dev.out).not.toContain('! to unblock:');
  expect(dev.out).toContain('lead: would register — pane w1:p1; nothing would be launched');
  expect(written(mounted)).toEqual(NOTHING);
});
