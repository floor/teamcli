// The lead's routine record writes under dev mode. A team's resolved lead — placed on the pane
// its own state records, in the team's session — edits the team record (`team config set` and
// `unset`) and a seat's settings (`team settings set`) with the same warning sentence and audit
// line the sibling owner-only writers print; with dev mode off, and for every other seat, each
// refusal stands byte for byte. Dev mode is read through the one resolver every existing lift
// uses (`devModeState`, by way of `devModeOwnerLiftAtCwd`): the machine `development-mode` record
// first — `local-fast` lifts, `off` lifts nothing even with the variable set — then the policy
// chain, then `TEAMCLI_DEV_MODE=1`. The owner-only authority edits `grant`, `delegate` and
// `revoke` are already lifted by the same call; the last scenes pin that they stay so. Every
// file, caller, key and pane below is synthetic.
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfig } from '../src/commands/config.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { runSettings } from '../src/commands/settings.ts';
import { devModeState } from '../src/dev_mode.ts';
import { writeDevelopmentMode } from '../src/development_mode.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { keyOf } from '../src/store/keys.ts';
import { agentsDir } from '../src/registry/agents.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T09:00:00Z');
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'pane1', session: 'acme' };
const WORKER = { kind: 'seat' as const, name: 'worker', pane: 'pane2', session: 'acme' };
const OWNER = { kind: 'owner' as const };

const CONFIG_LINE = "only the owner edits the team's record, from a terminal outside herdr; this call is lead";
const SETTINGS_LINE = "only the owner sets a seat's settings, from a terminal outside herdr; this call is lead";
const AUTHORITY_LINE = 'only the owner runs this, from a terminal outside herdr; this call is lead';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A repository with a lead seat and a worker seat, both panes recorded in the state, and a home
 *  holding the owner key the machine setting is signed with. */
function repo(): { root: string; home: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-lead-record-')));
  dirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
rules:
  - never squash
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
`);
  recordSeat(root, 'lead', 'pane1');
  recordSeat(root, 'worker', 'pane2');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  keyOf(home);
  return { root, home };
}

/** Write one seat into the state the placement check reads: session, name, recorded pane. */
function recordSeat(root: string, name: string, pane: string): void {
  const path = join(root, '.agents', 'team.state.json');
  const state = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { format: number; sessions: Record<string, { seats: Record<string, unknown>; worktrees: Record<string, unknown> }> })
    : { format: 1, sessions: {} };
  const session = (state.sessions.acme ??= { seats: {}, worktrees: {} });
  session.seats[name] = { stage: 'ready', pane };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** The machine setting, written the way the owner's switch writes it. */
function seed(home: string, mode: 'local-fast' | 'pr-per-change' | 'off'): void {
  const written = writeDevelopmentMode({ home, mode, now: NOW, caller: 'test' });
  if (!written.ok) throw new Error(written.why);
}

function teamFile(root: string): string {
  return readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
}

/** The log lines a run wrote beside the team file. */
function logOf(root: string): string {
  const path = join(root, '.agents', 'team.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Every file under the project's `.agents` folder and the synthetic home, by path, as base64:
 *  the strongest no-write check a scene can make — a created audit log or a rewritten state
 *  shows up here. */
function snapshot(root: string, home: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[path] = readFileSync(path).toString('base64');
    }
  };
  walk(join(root, '.agents'));
  walk(home);
  return files;
}

async function config(root: string, home: string, caller: { kind: string; name?: string; pane?: string; session?: string }, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller as never);
  io.env = env;
  const code = await runConfig(['set', 'seats.worker.inbound', 'accept'], io, { home, env, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

async function settings(root: string, home: string, caller: { kind: string; name?: string; pane?: string; session?: string }, env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller as never);
  io.env = env;
  const code = await runSettings(['set', 'worker', 'nickname=Hera'], io, { home, now: NOW });
  return { code, out: io.out, err: io.err };
}

// --- team config set / unset ------------------------------------------------------------------

test('config set: dev mode off refuses byte for byte and writes nothing', async () => {
  const { root, home } = repo();
  const before = teamFile(root);
  const ran = await config(root, home, LEAD, {});
  expect(ran.code).toBe(1);
  expect(ran.err).toBe(`team config: ${CONFIG_LINE}\n`);
  expect(ran.out).toBe('');
  expect(teamFile(root)).toBe(before);
  expect(logOf(root)).toBe('');
});

test('config set: the legacy variable admits the placed lead, with the warning and the audit line', async () => {
  const { root, home } = repo();
  const ran = await config(root, home, LEAD, { TEAMCLI_DEV_MODE: '1' });
  expect(ran.code).toBe(0);
  expect(ran.err).toBe(`warning: ${CONFIG_LINE}; dev mode continues\n`);
  expect(teamFile(root)).toContain('inbound: accept');
  expect(logOf(root)).toContain(`config [lead] warning: ${CONFIG_LINE}; dev mode continues; admitted as orchestrator\n`);
});

test('config set: the machine setting local-fast admits with no variable set', async () => {
  const { root, home } = repo();
  seed(home, 'local-fast');
  const ran = await config(root, home, LEAD, {});
  expect(ran.code).toBe(0);
  expect(ran.err).toBe(`warning: ${CONFIG_LINE}; dev mode continues (dev-mode on at machine level)\n`);
  expect(teamFile(root)).toContain('inbound: accept');
});

test('config set: the machine setting off refuses even with the variable on, and the resolver says so', async () => {
  const { root, home } = repo();
  seed(home, 'off');
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((error) => error.message).join('; '));
  // The one reading the lift makes: a present record governs, `off` lifts nothing, and the
  // variable is ignored rather than falling back to the legacy chain.
  const read = devModeState({ env: { TEAMCLI_DEV_MODE: '1' } }, { home, team: loaded.team, root, now: NOW });
  expect(read).toMatchObject({ on: false, by: null, governed: true, ignored: true, machine: { mode: 'off' } });
  const ran = await config(root, home, LEAD, { TEAMCLI_DEV_MODE: '1' });
  expect(ran.code).toBe(1);
  expect(ran.err).toBe(`team config: ${CONFIG_LINE}\n`);
  expect(teamFile(root)).not.toContain('inbound: accept');
  expect(logOf(root)).toBe('');
});

test("config set: the chain's own dev-mode word decides when no machine record is set", async () => {
  for (const [value, admitted] of [['on', true], ['off', false]] as const) {
    const { root, home } = repo();
    const written = writePolicySet(home, { level: 'team', target: root, teamRoot: root, name: 'dev-mode', value }, { now: NOW });
    if (!written.ok) throw new Error(written.why);
    const ran = await config(root, home, LEAD, {});
    if (!admitted) {
      expect(ran.code).toBe(1);
      expect(ran.err).toBe(`team config: ${CONFIG_LINE}\n`);
      expect(teamFile(root)).not.toContain('inbound: accept');
      continue;
    }
    expect(ran.code).toBe(0);
    expect(ran.err).toBe(`warning: ${CONFIG_LINE}; dev mode continues (dev-mode on at team level)\n`);
    expect(teamFile(root)).toContain('inbound: accept');
  }
});

test('config set: another seat of the team is refused in every mode', async () => {
  const { root, home } = repo();
  for (const setup of [() => {}, () => seed(home, 'local-fast'), () => seed(home, 'off')]) {
    setup();
    const ran = await config(root, home, WORKER, { TEAMCLI_DEV_MODE: '1' });
    expect(ran.code).toBe(1);
    expect(ran.err).toBe("team config: only the owner edits the team's record, from a terminal outside herdr; this call is worker\n");
    expect(teamFile(root)).not.toContain('inbound: accept');
  }
  expect(logOf(root)).toBe('');
});

test('config unset: the lead removes a seat row under the variable; off, the same write is refused', async () => {
  const { root, home } = repo();
  const ownerIo = testIo(root, OWNER);
  expect(await runConfig(['set', 'seats.worker.inbound', 'accept'], ownerIo, { home, env: {}, now: () => NOW })).toBe(0);
  expect(teamFile(root)).toContain('inbound: accept');

  const off = testIo(root, LEAD);
  off.env = {};
  expect(await runConfig(['unset', 'seats.worker.inbound'], off, { home, env: {}, now: () => NOW })).toBe(1);
  expect(off.err).toBe(`team config: ${CONFIG_LINE}\n`);
  expect(teamFile(root)).toContain('inbound: accept');

  const on = testIo(root, LEAD);
  on.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runConfig(['unset', 'seats.worker.inbound'], on, { home, env: { TEAMCLI_DEV_MODE: '1' }, now: () => NOW })).toBe(0);
  expect(on.err).toBe(`warning: ${CONFIG_LINE}; dev mode continues\n`);
  expect(teamFile(root)).not.toContain('inbound: accept');
});

test('config set: the team rules section is the same record write, refused off and admitted on', async () => {
  const { root, home } = repo();
  const off = testIo(root, LEAD);
  off.env = {};
  expect(await runConfig(['set', 'rules.0', 'never force'], off, { home, env: {}, now: () => NOW })).toBe(1);
  expect(off.err).toBe(`team config: ${CONFIG_LINE}\n`);
  expect(teamFile(root)).toContain('- never squash');

  const on = testIo(root, LEAD);
  on.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runConfig(['set', 'rules.0', 'never force'], on, { home, env: { TEAMCLI_DEV_MODE: '1' }, now: () => NOW })).toBe(0);
  expect(on.err).toBe(`warning: ${CONFIG_LINE}; dev mode continues\n`);
  expect(teamFile(root)).toContain('- never force');
});

test('config set: a lifted change that refuses writes no audit and changes no file', async () => {
  const { root, home } = repo();
  const before = snapshot(root, home);
  for (const args of [
    ['set', 'seats.missing.inbound', 'accept'],
    ['set', 'seats.worker.cli', 'no-such-cli'],
  ] as const) {
    const io = testIo(root, LEAD);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runConfig([...args], io, { home, env: { TEAMCLI_DEV_MODE: '1' }, now: () => NOW })).toBe(1);
    // The admission is still printed: only its audit line waits for a record that was written.
    expect(io.err).toContain(`warning: ${CONFIG_LINE}; dev mode continues\n`);
  }
  expect(snapshot(root, home)).toEqual(before);
  expect(logOf(root)).toBe('');
});

// --- team settings set ------------------------------------------------------------------------
test('settings set: dev mode off refuses byte for byte and records nothing', async () => {
  const { root, home } = repo();
  const ran = await settings(root, home, LEAD, {});
  expect(ran.code).toBe(1);
  expect(ran.err).toBe(`team settings: ${SETTINGS_LINE}\n`);
  expect(ran.out).toBe('');
  expect(existsSync(agentsDir(home))).toBe(false);
  expect(logOf(root)).toBe('');
});

test('settings set: the legacy variable admits the placed lead, with the warning and the audit line', async () => {
  const { root, home } = repo();
  const ran = await settings(root, home, LEAD, { TEAMCLI_DEV_MODE: '1' });
  expect(ran.code).toBe(0);
  expect(ran.err).toBe(`warning: ${SETTINGS_LINE}; dev mode continues\n`);
  expect(ran.out).toBe('settings: set nickname=Hera at seat (worker)\n');
  expect(logOf(root)).toContain(`settings [lead] warning: ${SETTINGS_LINE}; dev mode continues; admitted as orchestrator\n`);
});

test('settings set: the machine setting local-fast admits with no variable set', async () => {
  const { root, home } = repo();
  seed(home, 'local-fast');
  const ran = await settings(root, home, LEAD, {});
  expect(ran.code).toBe(0);
  expect(ran.err).toBe(`warning: ${SETTINGS_LINE}; dev mode continues (dev-mode on at machine level)\n`);
  expect(ran.out).toBe('settings: set nickname=Hera at seat (worker)\n');
});

test('settings set: the machine setting off refuses even with the variable on', async () => {
  const { root, home } = repo();
  seed(home, 'off');
  const ran = await settings(root, home, LEAD, { TEAMCLI_DEV_MODE: '1' });
  expect(ran.code).toBe(1);
  expect(ran.err).toBe(`team settings: ${SETTINGS_LINE}\n`);
  expect(existsSync(agentsDir(home))).toBe(false);
  expect(logOf(root)).toBe('');
});

test('settings set: another seat of the team is refused in every mode', async () => {
  const { root, home } = repo();
  for (const setup of [() => {}, () => seed(home, 'local-fast'), () => seed(home, 'off')]) {
    setup();
    const ran = await settings(root, home, WORKER, { TEAMCLI_DEV_MODE: '1' });
    expect(ran.code).toBe(1);
    expect(ran.err).toBe("team settings: only the owner sets a seat's settings, from a terminal outside herdr; this call is worker\n");
  }
  expect(logOf(root)).toBe('');
});

test('settings set/unset: a lifted refusal writes neither the audit nor the remembered team file', async () => {
  const { root, home } = repo();
  const before = snapshot(root, home);
  // A setting the file's own parser rejects is an invocation problem (exit 2); a seat or a key
  // the record does not hold is an ordinary refusal (exit 1).
  for (const [args, code] of [
    [['set', 'worker', 'nope=1'], 2],
    [['set', 'worker', 'model=nope'], 2],
    [['set', 'missing', 'nickname=Hera'], 1],
    [['unset', 'worker', 'nickname'], 1],
  ] as const) {
    const io = testIo(root, LEAD);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await runSettings([...args], io, { home, now: NOW })).toBe(code);
    expect(io.err).toContain(`warning: ${SETTINGS_LINE}; dev mode continues\n`);
  }
  // The gate admits before the request is validated; neither the admission's audit line nor
  // `currentTeam`'s `last_valid` copy may land for a write the command then refused.
  expect(snapshot(root, home)).toEqual(before);
  expect(logOf(root)).toBe('');
});

test('settings set: a lifted dry run writes neither the audit nor the remembered team file', async () => {
  const { root, home } = repo();
  const before = snapshot(root, home);
  const io = testIo(root, LEAD);
  io.env = { TEAMCLI_DEV_MODE: '1' };
  expect(await runSettings(['set', 'worker', 'nickname=Hera', '--dry-run'], io, { home, now: NOW })).toBe(0);
  expect(io.out).toContain('would set nickname=Hera');
  expect(io.err).toContain(`warning: ${SETTINGS_LINE}; dev mode continues\n`);
  expect(snapshot(root, home)).toEqual(before);
  expect(logOf(root)).toBe('');
});

// --- grant, delegate and revoke: already lifted by the same call -------------------------------

test('grant, delegate and revoke: the placed lead is admitted under the variable, refused off', async () => {
  const { root, home } = repo();
  const cases: { command: 'grant' | 'delegate' | 'revoke'; run: (io: ReturnType<typeof testIo>) => Promise<number> }[] = [
    { command: 'revoke', run: (io) => runRevoke(['grant'], io, { home }) },
    { command: 'grant', run: (io) => runGrant(['lead', '--scope', 'up'], io, { home }) },
    { command: 'delegate', run: (io) => runDelegate(['main/pane9', '--commands', 'up'], io, { home }) },
  ];
  for (const one of cases) {
    const off = testIo(root, LEAD);
    off.env = {};
    expect(await one.run(off)).toBe(1);
    expect(off.err).toBe(`team ${one.command}: ${AUTHORITY_LINE}\n`);
    expect(off.out).toBe('');

    const on = testIo(root, LEAD);
    on.env = { TEAMCLI_DEV_MODE: '1' };
    expect(await one.run(on)).toBe(0);
    expect(on.err).toBe(`warning: ${AUTHORITY_LINE}; dev mode continues\n`);
    expect(logOf(root)).toContain(`${one.command} [lead] warning: ${AUTHORITY_LINE}; dev mode continues; admitted as orchestrator\n`);
  }
  expect(teamFile(root)).toContain('grant:');
  expect(teamFile(root)).toContain('delegates:');
});
