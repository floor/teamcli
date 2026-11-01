// Independent reader and command scenes. Diagnostics use neutral ordinal case names.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Io } from '../src/io.ts';

const subject = process.env.TEAM_GPT_SUBJECT_ROOT ?? resolve(import.meta.dir, '..');
const load = (path: string) => import(pathToFileURL(join(subject, 'src', path)).href);
const { parseYaml, toValue } = await load('yaml.ts');
const { validateTeamFile } = await load('file/validate.ts');
const { readState, updateState, emptySession, storedWatchRecord, STATE_FILE } = await load('state.ts');
const { readArgs } = await load('args.ts');
const { readStoredTeamConfig, teamConfigRecordPath, sha256 } = await load('registry/team-config-store.ts');
const { seatsCrossTeams } = await load('settings/resolve.ts');
const { stagePresenceRecord, presencePaths } = await load('daemon/presence/spool.ts');
const { createPresenceIngester } = await load('daemon/presence/ingest.ts');

const names = ['__' + 'proto' + '__', 'con' + 'structor', 'proto' + 'type'];
const NOW = new Date('2026-11-01T00:00:00Z');
const BINDING = 'prs_123456789abc';
const shared = [Object.prototype, Function.prototype, Array.prototype, Object, Function, Array];
const snap = () => shared.map((object) => Object.getOwnPropertyDescriptors(object));
type Snapshot = ReturnType<typeof snap>;
function same(before: Snapshot, after: Snapshot): boolean {
  return before.every((left, i) => {
    const right = after[i]!;
    const keys = Reflect.ownKeys(left);
    return keys.length === Reflect.ownKeys(right).length && keys.every((key) => {
      const a = Reflect.get(left, key), b = Reflect.get(right, key);
      return b !== undefined && ['value', 'get', 'set', 'writable', 'enumerable', 'configurable'].every((field) => Object.is(a[field], b[field]));
    });
  });
}
function restore(before: Snapshot): void {
  shared.forEach((object, i) => {
    const held = before[i]!;
    for (const key of Reflect.ownKeys(object)) if (!Object.hasOwn(held, key)) Reflect.deleteProperty(object, key);
    Object.defineProperties(object, held);
  });
}
function directory() { return mkdtempSync(join(tmpdir(), 'gpt-reader-')); }
function disk(root: string): string {
  const hash = createHash('sha256');
  function visit(at: string) {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name); hash.update(path.slice(root.length));
      if (statSync(path).isDirectory()) visit(path); else hash.update(readFileSync(path));
    }
  }
  visit(root); return hash.digest('hex');
}

const teamText = (session = 'fixture', project = 'fixture') => `format: 1
project: ${project}
${session === '' ? '' : 'session: ' + session + '\n'}coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - name: lead
    role: coordinator
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
  - name: worker
    role: implementer
    cli: codex
    vendor: fixture
    model: Fixture
    version: "1"
    launch: codex
`;

const yamlScenes = [
  `${names[0]}: { fixture: 1 }`,
  `${JSON.stringify(names[0])}: { fixture: 1 }`,
  `'${names[0]}': { fixture: 1 }`,
  `outer:\n  ${names[0]}:\n    fixture: 1`,
  `outer: { ${names[0]}: { fixture: 1 } }`,
  `outer: { ${JSON.stringify(names[0])}: { fixture: 1 } }`,
  `outer:\n  - ${names[0]}: { fixture: 1 }`,
];
for (const [i, text] of yamlScenes.entries()) test(`R1${i + 1}: the YAML map boundary refuses the hazardous field`, () => {
  const before = snap(); let refused = false, unchanged = false;
  try { try { toValue(parseYaml(text)); } catch { refused = true; } unchanged = same(before, snap()); }
  finally { restore(before); }
  expect({ refused, unchanged }).toEqual({ refused: true, unchanged: true });
});

test('R20: ordinary owned fields and scalar values retain their YAML meaning', () => {
  const before = snap();
  for (const name of names.slice(1)) {
    const result = toValue(parseYaml(`${name}: { own: 7 }`));
    expect(Object.hasOwn(result, name)).toBe(true); expect(result[name].own).toBe(7);
  }
  for (const name of names) expect(toValue(parseYaml(`value: ${JSON.stringify(name)}`)).value).toBe(name);
  expect(same(before, snap())).toBe(true);
});

for (const [i, name] of names.entries()) test(`R3${i + 1}: explicit and derived team sessions use the same refusal`, () => {
  const before = snap();
  for (const text of [teamText(name), teamText('', name)]) {
    const result = validateTeamFile(text);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result).includes("session can't be")).toBe(true);
  }
  expect(same(before, snap())).toBe(true);
});

for (const [i, kind] of ['missing', 'empty', 'own-records'].entries()) test(`R4${i + 1}: the session map has no inherited entries`, () => {
  const dir = directory(), before = snap();
  const sessions = Object.fromEntries(names.map((name) => [name, { seats: { worker: { stage: 'ready' } }, worktrees: {} }]));
  if (kind !== 'missing') writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: kind === 'empty' ? {} : sessions }));
  const state = readState(dir);
  expect(Object.getPrototypeOf(state.sessions) === null).toBe(true);
  for (const name of names) {
    expect(Object.hasOwn(state.sessions, name)).toBe(kind === 'own-records');
    expect(state.sessions[name] === undefined).toBe(kind !== 'own-records');
  }
  expect(same(before, snap())).toBe(true);
});

for (const [i, name] of names.entries()) test(`R5${i + 1}: direct session writes cannot touch a shared object`, () => {
  const dir = directory(), before = snap(); let safe = false, own = false;
  try {
    updateState(dir, (state: any) => { const entry = state.sessions[name] ??= emptySession(); entry.fixture_note = 1; });
    safe = same(before, snap());
    const raw = JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8'));
    own = Object.hasOwn(raw.sessions, name) && raw.sessions[name].fixture_note === 1;
  } finally { restore(before); }
  expect({ safe, own }).toEqual({ safe: true, own: true });
  expect(same(before, snap())).toBe(true);
});

const commands = [
  ['status', []], ['doctor', []], ['drops', ['--read', '--seat', 'worker']], ['watch', []],
  ['worktree', ['list']], ['archive', []], ['mcp', ['serve', '--seat', 'worker']],
  ['restart', ['worker']], ['up', []], ['seats', []], ['brief', ['rollout']], ['down', []],
  ['remove', ['worker']], ['rename', ['worker', 'renamed']], ['register', ['worker', '--pane', 'fixture-pane-worker']],
  ['seat', ['worker']], ['answer', ['worker', 'trust']], ['add', ['peer', '--like', 'worker']], ['check', []],
] as const;
const handlers = new Map<string, Function>();
for (const [name] of commands) {
  const module = await load('commands/' + name + '.ts');
  handlers.set(name, name === 'check' ? module.check : module['run' + name[0]!.toUpperCase() + name.slice(1)]);
}
async function commandCase(name: string, rest: readonly string[], session: string, inline: boolean) {
  const base = directory(), root = join(base, 'project'), home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText());
  const env = { ...process.env };
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE', 'EMAIL']) delete env[key];
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env, stdio: 'pipe' });
  let out = '', err = '', calls = 0, threw = false;
  const io: Io = { cwd: root, env: { HOME: home, TEAM_CONFIG_SOURCE: 'file' }, caller: { kind: 'owner' }, stdinIsTTY: false, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } };
  const blocked = () => { calls++; throw Error('fixture source boundary'); };
  const sources = new Proxy({ home }, { get(target, key) { if (key === 'home') return target.home; return blocked; } });
  const before = snap(), prior = disk(base); let code: number | null = null, unchanged = false;
  try {
    const argv = [...(inline ? ['--session=' + session] : ['--session', session]), ...rest];
    try { code = name === 'check' ? await handlers.get(name)!(argv, io, blocked, sources) : await handlers.get(name)!(argv, io, sources); }
    catch { threw = true; }
    unchanged = same(before, snap());
  } finally { restore(before); }
  return { code, calls, threw, sessionRefusal: (out + err).includes("session can't be"), unchanged, diskSame: disk(base) === prior };
}

for (const [i, [name, rest]] of commands.entries()) test(`R6${String(i + 1).padStart(2, '0')}: the command stops reserved session forms before effects`, async () => {
  const rows = [];
  for (const session of names) for (const inline of [false, true]) rows.push(await commandCase(name, rest, session, inline));
  expect(rows).toEqual(Array.from({ length: 6 }, () => ({ code: 2, calls: 0, threw: false, sessionRefusal: true, unchanged: true, diskSame: true })));
});

test('R80: ordinary session parsing and command decisions remain available', async () => {
  const rows = [];
  for (const [name, rest] of commands) {
    const result = await commandCase(name, rest, 'fixture', false);
    expect(result.sessionRefusal).toBe(false); expect(result.unchanged).toBe(true);
    rows.push({ name, code: result.code, calls: result.calls, threw: result.threw });
  }
  for (const value of ['fixture', 'constructor-next', 'prototype-next']) {
    const read = readArgs(['--session=' + value], ['session'], []);
    expect(read.error).toBeUndefined(); expect(read.values.session).toBe(value);
    expect(validateTeamFile(teamText(value)).ok).toBe(true);
  }
  if (process.env.TEAM_GPT_MATRIX_PATH) writeFileSync(process.env.TEAM_GPT_MATRIX_PATH, JSON.stringify(rows));
});

test('R81: the registry JSON reader keeps hazardous-looking fields as ordinary owned data', () => {
  const home = directory(), id = '123456789abc', path = teamConfigRecordPath(home, id), text = teamText();
  mkdirSync(join(home, '.config', 'team', 'team-config'), { recursive: true });
  const record = { format: 1, id, root: '/fixture/project', text, text_sha256: sha256(text), record_version: 'fixture', record_sha256: 'fixture', ...Object.fromEntries(names.map((name) => [name, { fixture_mark: 7 }])) };
  writeFileSync(path, JSON.stringify(record));
  const before = snap(), read = readStoredTeamConfig(home, id);
  expect(read.text).toBe(text);
  expect(Object.getPrototypeOf(read) === Object.prototype).toBe(true);
  for (const name of names) { expect(Object.hasOwn(read, name)).toBe(true); expect(read[name].fixture_mark).toBe(7); }
  expect((read as any).fixture_mark).toBeUndefined(); expect(same(before, snap())).toBe(true);
});

test('R82: settings resolve owned levels without interpreting extra JSON map fields', () => {
  const before = snap(), ordinary = { project: true, team: true };
  const expected = seatsCrossTeams(ordinary);
  expect(expected).toBe(true);
  for (const name of names) {
    const record = JSON.parse(JSON.stringify({ ...ordinary, [name]: { machine: true, seat: false, fixture_mark: 1 } }));
    expect(seatsCrossTeams(record)).toBe(expected);
    expect(Object.hasOwn(record, name)).toBe(true);
  }
  expect(seatsCrossTeams({ project: true })).toBe(true);
  expect(seatsCrossTeams({ project: true, team: false })).toBe(false);
  expect(seatsCrossTeams({ machine: true })).toBe(false);
  expect(same(before, snap())).toBe(true);
});

test('R83: the raw watch reader accepts an own record and ignores an inherited session', () => {
  const dir = directory(), session = 'fixture_shadow_session', watch = { pid: 424242, heartbeat: NOW.toISOString() };
  const original = snap(); let absent: unknown, own: unknown, unchanged = false;
  try {
    Object.defineProperty(Object.prototype, session, { value: { watch }, configurable: true });
    const fixtureBefore = snap();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: {} }));
    absent = storedWatchRecord(dir, session);
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: { [session]: { watch } } }));
    own = storedWatchRecord(dir, session); unchanged = same(fixtureBefore, snap());
  } finally { restore(original); }
  expect({ absent, own, unchanged }).toEqual({ absent: undefined, own: watch, unchanged: true });
  expect(same(original, snap())).toBe(true);
});

for (const [i, own] of [false, true].entries()) test(`R9${i + 1}: presence accepts only a binding in an owned session`, async () => {
  const dir = directory(), session = 'fixture_shadow_presence', original = snap();
  let ingester: any, observed: any, unchanged = false;
  try {
    Object.defineProperty(Object.prototype, session, { value: { seats: { worker: { presence_binding: BINDING } } }, configurable: true });
    const before = snap();
    writeFileSync(join(dir, STATE_FILE), JSON.stringify({ format: 1, sessions: own ? { [session]: { seats: { worker: { stage: 'ready', presence_binding: BINDING } }, worktrees: {} } } : {} }));
    const staged = stagePresenceRecord(dir, { session, seat: 'worker', binding: BINDING, source: 'runtime-hook', event: 'turn-start', ts: NOW.toISOString(), id: NOW.toISOString() + '-1234abcd' });
    expect(staged.kind).toBe('staged');
    ingester = createPresenceIngester({ stateDir: dir, session, now: () => NOW });
    const result = await ingester.step();
    observed = { ingested: result.ingested.length, stale: result.stale.length, errors: result.errors.length };
    if (own) {
      const paths = presencePaths(dir, session, 'worker');
      expect(JSON.parse(readFileSync(paths.current, 'utf8')).state).toBe('working');
    }
    unchanged = same(before, snap());
  } finally { if (ingester) await ingester.close(); restore(original); }
  expect(observed).toEqual({ ingested: own ? 1 : 0, stale: own ? 0 : 1, errors: 0 });
  expect(unchanged).toBe(true); expect(same(original, snap())).toBe(true);
});
