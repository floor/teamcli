// A seat's persona: the name its written label carries before its middle dot
// (src/file/sections/seats.ts). It is the name a person reads for the seat — the launch's session
// name and the first line of what the seat sends — and the team record's `nickname:` is the same
// name kept for addressing. The label wins, and a config write cannot leave the two apart: a set
// on a label writes the nickname in the same edit and refreshes the roster line, so the next
// message already carries the new name with no relaunch. A file edited by hand can still drift,
// and `team check` names it (test/check-nickname-drift.test.ts). A retired agent record's persona
// is never handed to a new seat. Every scene is a synthetic home; no live registry is read.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { approveOwnerAction } from '../src/client/owner-action.ts';
import { runConfig, type ConfigSources } from '../src/commands/config.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { labelPersona } from '../src/file/sections/seats.ts';
import type { Io } from '../src/io.ts';
import { launchCommand } from '../src/profiles/profile.ts';
import { profileFor } from '../src/profiles/index.ts';
import { readAgents, registerAgent, updateAgent } from '../src/registry/agents.ts';
import { getTeam, teamIdOf } from '../src/registry/teams.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { namingFor, seatSessionName, sessionDisplayName, senderDisplayName } from '../src/send/names.ts';
import { intoRegistry, storedTeam } from './helpers/registry-team.ts';
import { seatOwner, type FakeStore } from './helpers/owner-seat.ts';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const detached: Caller = { kind: 'owner-no-tty' };

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SEAT = (role: string, name: string, lines: string[] = []): string =>
  `  - role: ${role}
    name: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${lines.join('')}`;

/** A team whose worker carries the name its label names. */
const TEAM = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead', ['    label: lead\n', '    leads: true\n'])}${SEAT('implementer', 'worker', ['    nickname: Cicero\n', '    label: Cicero · implementer\n'])}`;

/** The same team where the worker's written label carries no middle dot: the word whole. */
const DOTLESS = TEAM.replace('label: Cicero · implementer', 'label: Cicero');

/** Two seats that already address by name: the worker Cicero, the reviewer Joan. */
const TWO = TEAM.replace('    label: Cicero · implementer\n', `    label: Cicero · implementer\n${SEAT('reviewer', 'other', ['    nickname: Joan\n', '    label: Joan · reviewer\n'])}`);

/** A team with a retired reviewer beside a new one whose label names another persona. */
const RETIRED = `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
${SEAT('coordinator', 'lead', ['    label: lead\n', '    leads: true\n'])}${SEAT('reviewer', 'reviewer', [
  '    nickname: Cicero\n',
  '    label: Cicero · reviewer\n',
  '    stopped: true\n',
])}${SEAT('reviewer', 'reviewer-2', ['    label: Ines · reviewer\n'])}${SEAT('reviewer', 'reviewer-3', ['    label: Damon · reviewer\n'])}`;

const parsed = validateTeamFile(RETIRED);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
const team2 = parsed.team;

/** A team checkout, its `.agents` folder, a temp home, and the team moved into that home's
 *  registry, as `migrate` does. */
function place(text = TEAM): { home: string; root: string; store: FakeStore } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'seat-persona-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'code', 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  const store = seatOwner(home);
  intoRegistry(root, home);
  return { home, root, store };
}

function ioOf(root: string): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(text: string) { io.out += text; },
    stderr(text: string) { io.err += text; },
    cwd: root,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    caller: detached,
  };
  return io;
}

function sourcesOf(p: { home: string; store: FakeStore }): ConfigSources {
  return { home: p.home, env: { ...process.env, TEAM_CONFIG_SOURCE: 'registry' }, now: () => NOW, ownerSeatStore: p.store };
}

describe('the persona a written label names', () => {
  test('the text before the middle dot, trimmed; a label with no dot is the name whole', () => {
    expect(labelPersona({ label: 'Cicero · reviewer', labelWritten: true })).toBe('Cicero');
    expect(labelPersona({ label: '  Pythia  · reviewer', labelWritten: true })).toBe('Pythia');
    expect(labelPersona({ label: 'Damon', labelWritten: true })).toBe('Damon');
    // A stored label the file did not write is the model and version, not a name.
    expect(labelPersona({ label: 'claude opus 5.5' })).toBeNull();
    expect(labelPersona({ label: ' · reviewer', labelWritten: true })).toBeNull();
  });

  test('the launch names its session with the label, not the record’s nickname', () => {
    const seat = team2.seats.find((item) => item.name === 'reviewer-2')!;
    expect(seat.nickname).toBeUndefined();
    expect(seatSessionName(seat, { team: 'ee', teamName: 'acme', mode: 'auto', seats: team2.seats })).toBe('Ines');
    const line = launchCommand(profileFor('claude-code')!, seat.launch, 'Rules.', undefined, undefined, 'Ines');
    expect(line).toContain('--name Ines');
  });

  test('a nickname the record still writes does not outrank the label', () => {
    const seat = team2.seats.find((item) => item.name === 'reviewer')!;
    expect(seat.nickname).toBe('Cicero');
    expect(seatSessionName(seat, { team: 'ee', teamName: 'acme', mode: 'auto', seats: team2.seats })).toBe('Cicero');
    // The same rule read directly: the label's word stands over the field's.
    expect(sessionDisplayName({ seat: seat.name, persona: 'Joan', nickname: 'Cicero', team: 'ee', teamName: 'acme', mode: 'nickname' })).toBe('Joan');
  });

  test('a new seat beside a retired one launches with its own label, and no retired record’s name', () => {
    const p = place(RETIRED);
    const teamId = teamIdOf(p.root);
    const stopped = team2.seats.find((item) => item.name === 'reviewer')!;
    // The retired seat launched once, and its agent record carries a signed nickname.
    const old = registerLaunch({ home: p.home, team: team2, root: p.root, by: 'scene' }, stopped, 'wScene:p1');
    if (!('id' in old)) throw new Error(old.note);
    updateAgent(p.home, old.id, { lifecycle: 'retired', settingsDelta: { nickname: 'Cicero' } });
    expect(readAgents(p.home).find((agent) => agent.id === old.id)?.lifecycle).toBe('retired');

    const fresh = team2.seats.find((item) => item.name === 'reviewer-3')!;
    const registered = registerLaunch({ home: p.home, team: team2, root: p.root, by: 'scene' }, fresh, 'wScene:p2');
    if (!('id' in registered)) throw new Error(registered.note);
    expect(registered.id).not.toBe(old.id);
    // A fresh record: the retired record's signed nickname does not follow the seat.
    expect(readAgents(p.home).find((agent) => agent.id === registered.id)?.settings).toBeUndefined();
    const naming = namingFor({ home: p.home, root: p.root });
    expect(senderDisplayName({ seat: 'reviewer-3', team: teamId }, naming)).toBe('Damon');
    expect(seatSessionName(fresh, { team: teamId, teamName: team2.project, mode: 'auto', seats: team2.seats })).toBe('Damon');
  });
});

describe('a config write keeps the label and the nickname together', () => {
  test('a set on a label writes the nickname in the same edit, and the next header reads it', async () => {
    const p = place();
    const teamId = teamIdOf(p.root);
    const loaded = validateTeamFile(TEAM);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker')!;
    registerLaunch({ home: p.home, team: loaded.team, root: p.root, by: 'scene' }, worker, 'wScene:p1');
    // Before the change the header reads the name both fields agree on.
    expect(senderDisplayName({ seat: 'worker', team: teamId }, namingFor({ home: p.home, root: p.root }))).toBe('Cicero');

    const sources = sourcesOf(p);
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'Joan · implementer', '--request'], ask, sources), ask.err).toBe(0);
    const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
    expect(id).not.toBe('');
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'Joan · implementer', '--approval', id], ran, sources), ran.err).toBe(0);

    // The record's two names moved together.
    const text = storedTeam(p.root, p.home)?.text ?? '';
    expect(text).toContain('label: "Joan · implementer"');
    expect(text).toContain('nickname: Joan');
    expect(text).not.toContain('nickname: Cicero');
    // The roster line was refreshed in the same run, so no relaunch is needed.
    expect(getTeam(p.home, teamId)?.roster.find((line) => line.seat === 'worker')?.nickname).toBe('Joan');
    expect(senderDisplayName({ seat: 'worker', team: teamId }, namingFor({ home: p.home, root: p.root }))).toBe('Joan');
    const renamed = { ...worker, label: 'Joan · implementer', labelWritten: true as const };
    expect(seatSessionName(renamed, { team: teamId, teamName: 'acme', mode: 'auto', seats: [renamed] })).toBe('Joan');
  });

  test('a label the nickname field cannot hold is written, and the field keeps its name', async () => {
    // A space and an accent are ordinary display words, and the nickname alphabet has neither:
    // the label is written, the field is left as it is, and nothing is slugged.
    for (const persona of ['Jane Doe', 'Inès']) {
      const p = place();
      const label = `${persona} · implementer`;
      const sources = sourcesOf(p);
      const ask = ioOf(p.root);
      expect(await runConfig(['set', 'seats.worker.label', label, '--request'], ask, sources), ask.err).toBe(0);
      const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
      expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
      const ran = ioOf(p.root);
      expect(await runConfig(['set', 'seats.worker.label', label, '--approval', id], ran, sources), `${persona}: ${ran.err}`).toBe(0);
      const text = storedTeam(p.root, p.home)?.text ?? '';
      expect(text).toContain(`label: "${label}"`);
      expect(text).toContain('nickname: Cicero');
      // The launch reads the field: the label's word is display alone, never an address.
      const loaded = validateTeamFile(text);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
      const worker = loaded.team.seats.find((seat) => seat.name === 'worker')!;
      expect(seatSessionName(worker, { team: teamIdOf(p.root), teamName: 'acme', mode: 'auto', seats: loaded.team.seats })).toBe('Cicero');
    }
  });

  test('a set on a nickname rewrites a label with no middle dot whole', async () => {
    // The whole label is the persona (labelPersona), so leaving the old word in place would keep
    // the launch, the roster and the header on the name the set replaced.
    const p = place(DOTLESS);
    const teamId = teamIdOf(p.root);
    const loaded = validateTeamFile(DOTLESS);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker')!;
    registerLaunch({ home: p.home, team: loaded.team, root: p.root, by: 'scene' }, worker, 'pane1:p1');

    const sources = sourcesOf(p);
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.nickname', 'Joan', '--request'], ask, sources), ask.err).toBe(0);
    const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.nickname', 'Joan', '--approval', id], ran, sources), ran.err).toBe(0);

    const text = storedTeam(p.root, p.home)?.text ?? '';
    expect(text).toContain('label: Joan');
    expect(text).not.toContain('label: Cicero');
    expect(text).toContain('nickname: Joan');
    expect(getTeam(p.home, teamId)?.roster.find((line) => line.seat === 'worker')?.nickname).toBe('Joan');
    const after = validateTeamFile(text);
    if (!after.ok) throw new Error(JSON.stringify(after.errors));
    const renamed = after.team.seats.find((seat) => seat.name === 'worker')!;
    expect(seatSessionName(renamed, { team: teamId, teamName: 'acme', mode: 'auto', seats: after.team.seats })).toBe('Joan');
    expect(senderDisplayName({ seat: 'worker', team: teamId }, namingFor({ home: p.home, root: p.root }))).toBe('Joan');
  });

  test('a label naming a word another seat already addresses by leaves both addresses working', async () => {
    // The set pairs the label with the nickname only when the field could hold it: Joan is the
    // reviewer's, so the worker keeps Cicero — and the roster re-mark must not write Joan on both.
    const p = place(TWO);
    const teamId = teamIdOf(p.root);
    const loaded = validateTeamFile(TWO);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    for (const [index, seat] of loaded.team.seats.entries()) {
      registerLaunch({ home: p.home, team: loaded.team, root: p.root, by: 'scene' }, seat, `pane${String(index + 1)}:p1`);
    }
    const sources = sourcesOf(p);
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'Joan · implementer', '--request'], ask, sources), ask.err).toBe(0);
    const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'Joan · implementer', '--approval', id], ran, sources), ran.err).toBe(0);

    const text = storedTeam(p.root, p.home)?.text ?? '';
    expect(text).toContain('label: "Joan · implementer"');
    expect(text).toContain('nickname: Cicero');
    const roster = getTeam(p.home, teamId)?.roster ?? [];
    expect(roster.find((line) => line.seat === 'worker')?.nickname).toBe('Cicero');
    expect(roster.find((line) => line.seat === 'other')?.nickname).toBe('Joan');
    expect(senderDisplayName({ seat: 'worker', team: teamId }, namingFor({ home: p.home, root: p.root }))).toBe('Cicero');
    expect(senderDisplayName({ seat: 'other', team: teamId }, namingFor({ home: p.home, root: p.root }))).toBe('Joan');
    // The launch reads the same: the label's word is a workspace title, not the seat's name.
    const after = validateTeamFile(text);
    if (!after.ok) throw new Error(JSON.stringify(after.errors));
    const worker = after.team.seats.find((seat) => seat.name === 'worker')!;
    expect(seatSessionName(worker, { team: teamId, teamName: 'acme', mode: 'auto', seats: after.team.seats })).toBe('Cicero');
  });

  test('a label with no usable nickname leaves the field alone and still writes', async () => {
    // A label whose name the nickname field cannot hold (the reserved `lead`) must not refuse the
    // edit: the label is still the workspace title and still wins in display.
    const p = place();
    const sources = sourcesOf(p);
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'lead · implementer', '--request'], ask, sources), ask.err).toBe(0);
    const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'lead · implementer', '--approval', id], ran, sources), ran.err).toBe(0);
    const text = storedTeam(p.root, p.home)?.text ?? '';
    expect(text).toContain('label: "lead · implementer"');
    expect(text).toContain('nickname: Cicero');
  });

  test('a roster line carries no nickname that is the seat’s own name', async () => {
    // A label that names the seat itself adds no second name
    // (src/file/sections/seats.ts:seatNicknames), so the roster line holds the seat, its role
    // and its capabilities alone — the seat name is already the address. The same answer holds
    // when a set renames a seat after itself: the old persona leaves the roster with the label.
    const p = place();
    const teamId = teamIdOf(p.root);
    const loaded = validateTeamFile(TEAM);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    const lead = loaded.team.seats.find((seat) => seat.name === 'lead')!;
    const worker = loaded.team.seats.find((seat) => seat.name === 'worker')!;
    const leadId = (registerLaunch({ home: p.home, team: loaded.team, root: p.root, by: 'scene' }, lead, 'wScene:p1') as { id: string }).id;
    const workerId = (registerLaunch({ home: p.home, team: loaded.team, root: p.root, by: 'scene' }, worker, 'wScene:p2') as { id: string }).id;
    // The lead's label is its own name; the worker's names Cicero.
    let roster = getTeam(p.home, teamId)?.roster ?? [];
    expect(roster.find((line) => line.seat === 'lead')).toEqual({ agent: leadId, seat: 'lead', role: 'coordinator', leads: true });
    expect(roster.find((line) => line.seat === 'worker')?.nickname).toBe('Cicero');

    const sources = sourcesOf(p);
    const ask = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'worker', '--request'], ask, sources), ask.err).toBe(0);
    const id = /owner-seat request (oa_[0-9a-f]{24})/.exec(ask.out)?.[1] ?? '';
    expect(id).not.toBe('');
    expect(approveOwnerAction(p.home, id, 'oui', p.store, NOW)).toMatchObject({ ok: true });
    const ran = ioOf(p.root);
    expect(await runConfig(['set', 'seats.worker.label', 'worker', '--approval', id], ran, sources), ran.err).toBe(0);
    roster = getTeam(p.home, teamId)?.roster ?? [];
    expect(roster.find((line) => line.seat === 'worker')).toEqual({ agent: workerId, seat: 'worker', role: 'implementer' });
  });
});
