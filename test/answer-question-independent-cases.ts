// Independent command checks: real shipped profiles/readers, real signed send drops, synthetic
// team and home, and a host that records every call. No terminal-host adapter is constructed.
import { afterEach, expect, test } from 'bun:test';
import { assertIndependentHome } from './independent-home-fixture.ts';
import { execFileSync } from 'node:child_process';
import { discardFixtures } from './fixture-cleanup.ts';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runAnswer, type AnswerHost } from '../src/commands/answer.ts';
import type { SendHost } from '../src/commands/send.ts';
import { listFolder } from '../src/file/landing.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { writeGrant } from '../src/permissions/grants.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { readState, updateState } from '../src/state.ts';
import { approvalStanding } from '../src/store/store.ts';
import { readDialog } from '../src/watch/dialog.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00Z');
const LINE = 'decide within your rules or ask your orchestrator with team send';
const OWNER_BODY = `from the owner — admitted by: the owner\n\n${LINE}`;
const capture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const scenes = [
  ['claude-code', '2.1.302', '2.1.302 (Claude Code)'],
  ['claude-code', '2.1.299', '2.1.299 (Claude Code)'],
  ['cursor', '2026.10.16', '2026.10.16-e3cb207'],
  ['gemini', '0.64.0', '0.64.0'],
  ['antigravity', '1.3.5', '1.3.5'],
  ['antigravity', '1.4.0', '1.4.0'],
  ['antigravity', '1.4.1', '1.4.1'],
  ['antigravity', '1.4.2', '1.4.2'],
  ['codex', '0.161.0', 'codex-cli 0.161.0'],
] as const;
const cursor = scenes[2];
type Scene = readonly [string, string, string];
const owned: string[] = [];
afterEach(() => { for (const path of owned.splice(0)) discardFixtures([path]); });

function team(cli: string, root: string, session = 'scene'): string {
  const launch = cli === 'claude-code' ? 'claude' : cli === 'antigravity' ? 'agy' : cli;
  return `format: 1\nproject: scene\ncoordinator: lead\noperator: lead\nsession: ${session}\nworkspace:\n  mode: shared\ntrust:\n  - ${lobbyDir(join(dirname(root), 'h'))}\n  - ${root}\nseats:\n  - name: lead\n    role: coordinator\n    cli: ${cli}\n    vendor: synthetic\n    model: fixture\n    version: "1"\n    launch: ${launch}\n`;
}

async function world(scene: Scene = cursor, screen = capture(`${scene[0]}/${scene[1]}/question.txt`)) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aq-'))); owned.push(base);
  const root = join(base, 'r'), home = join(base, 'h'), dir = join(root, '.agents'), sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true }); mkdirSync(home); mkdirSync(sockets);
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), team(scene[0], root));
  const grant = writeGrant(home, { name: 'scene', kind: 'team', grantee: teamIdOf(root), capabilities: ['dialogs.trust'], roots: [root], scope: [root] }, { now: NOW });
  expect(grant.ok).toBe(true);
  const approvalIo = testIo(root, { kind: 'owner' });
  expect(await runApprove(['--file', '.agents/team.yaml'], approvalIo, { home, now: () => NOW, ask: async () => '2', waiting: () => 'empty' }), approvalIo.err).toBe(0);
  updateState(dir, state => { state.sessions.scene = { seats: { lead: { stage: 'launched', pane: 'synthetic-pane', launched: { shell: 700, cli: [701] }, waiting: { state: 'waiting-owner', classification: 'question' } } }, worktrees: {} }; });
  const calls: string[] = [], keys: string[] = [], inputs: string[] = [];
  let at = NOW.getTime();
  const control = { screen, idle: capture(`${scene[0]}/${scene[1]}/idle.txt`), busyAfter: false, replaced: false, versions: 0, panes: 0,
    onVersion: (_n: number) => {}, onPane: (_n: number) => {} };
  const forbidden = (value: string) => { inputs.push(value); throw new Error(`unexpected pane input: ${value}`); };
  const sendHost: SendHost = {
    agents: () => { calls.push('send-agents'); return [{ name: 'lead', pane: 'synthetic-pane', cli: scene[0] }]; },
    processInfo: () => null, home, socketsDir: sockets, now: () => NOW,
    deliver: async () => { calls.push('send-socket'); return { ok: false, reason: 'synthetic offline socket' }; },
    native: { typeText: () => forbidden('send-type'), pressEnter: () => forbidden('send-enter'), status: () => null, wait: async () => {} },
  };
  const host: AnswerHost = {
    home, now: () => new Date(at), sleep: async ms => { at += ms; }, standing: r => approvalStanding(r, home), sendHost,
    version: () => { calls.push('version'); control.onVersion(++control.versions); return scene[2]; },
    agents: () => { calls.push('agents'); return [{ name: 'lead', pane: 'synthetic-pane' }]; },
    processInfo: () => { calls.push('process'); return { shell: 700, foreground: [700, control.replaced ? 702 : 701] }; },
    pane: () => { calls.push('pane'); control.onPane(++control.panes); return control.screen; },
    sendKey: (session, pane, key) => {
      calls.push('key'); expect(session).toBe('scene'); expect(pane).toBe('synthetic-pane'); keys.push(key);
      control.screen = control.busyAfter ? screen : control.idle; return true;
    },
    rename: () => { calls.push('rename'); return false; }, foreground: () => { calls.push('foreground'); return [scene[0]]; },
    foregroundCwd: () => { calls.push('cwd'); return root; }, list: listFolder, status: () => 'idle',
    type: () => forbidden('answer-type'), enter: () => forbidden('answer-enter'),
  };
  return { root, home, dir, base, host, control, calls, keys, inputs };
}
type World = Awaited<ReturnType<typeof world>>;
function messages(w: World): string[] {
  try { return readdirSync(join(w.dir, 'send-drops', 'scene', 'lead')).filter(n => /^[0-9a-f-]{36}$/.test(n)); } catch { return []; }
}
function waiting(w: World) { return readState(w.dir).sessions.scene?.seats.lead?.waiting; }
async function answer(w: World, json = true, args: string[] = []) {
  const io = testIo(w.root, { kind: 'owner' });
  const code = await runAnswer(['lead', 'question', ...args, ...(json ? ['--json'] : [])], io, w.host);
  return { code, io, result: json && io.out ? JSON.parse(io.out) : null };
}
function untouched(w: World) {
  expect(w.keys).toEqual([]); expect(w.inputs).toEqual([]); expect(messages(w)).toEqual([]);
  expect(waiting(w)?.state).toBe('waiting-owner');
}
async function refused(w: World, id: string, code = 1, args: string[] = []) {
  const run = await answer(w, true, args);
  expect(run.code, run.io.out + run.io.err).toBe(code); expect(run.io.err).toBe(''); expect(run.result?.error?.id).toBe(id); untouched(w);
}
function keyOrder(w: World) {
  const key = w.calls.indexOf('key'); expect(key).toBeGreaterThan(0);
  // Each lookup completes before its identity/capture pair. No host call intervenes after
  // the final capture, and the first two complete captures also precede the dismiss key.
  expect(w.calls.slice(key - 3, key + 1)).toEqual(['version', 'process', 'pane', 'key']);
  expect(w.calls.slice(0, key).filter(c => c === 'pane')).toHaveLength(3);
  expect(w.calls.slice(0, key).filter(c => c === 'version')).toHaveLength(3);
}
async function delivered(w: World) {
  const ids = messages(w); expect(ids).toHaveLength(1);
  const path = join(w.dir, 'send-drops', 'scene', 'lead', ids[0]!);
  expect(recordAt(path).payload.body).toBe(OWNER_BODY);
  expect(readMessage({ root: w.root, seat: 'lead', session: 'scene', dropDir: join(w.dir, 'send-drops', 'scene', 'lead') }, ids[0]!, w.home)).toEqual({ ok: true, body: `from owner (owner):\n\n${OWNER_BODY}` });
  expect(w.keys).toEqual(['escape']); expect(w.inputs).toEqual([]); keyOrder(w);
  expect(w.calls.indexOf('send-agents')).toBeGreaterThan(w.calls.indexOf('key'));
}

test('all module defaults start in the suite synthetic home', () => { assertIndependentHome(); });

for (const scene of scenes) for (const json of [false, true]) test(`captured ${scene[0]} ${scene[1]} answers only its dismiss key; json=${json}`, async () => {
  const w = await world(scene), reading = readDialog(scene[0], w.control.screen);
  expect(reading).toMatchObject({ dialog: 'question', complete: true });
  const run = await answer(w, json); expect(run.code, run.io.out + run.io.err).toBe(0); expect(run.io.err).toBe('');
  if (json) expect(run.result).toMatchObject({ status: 'answered', dialog: 'question', dialog_kind: 'question', state: 'ready', seat: 'lead' });
  else expect(run.io.out).toBe('team scene, session "scene"\nlead: answered question (question)\n');
  await delivered(w); expect(waiting(w)).toBeUndefined(); expect(readState(w.dir).sessions.scene?.seats.lead?.stage).toBe('ready');
});

test('captured Codex plan uses its own plan record and no choice', async () => {
  const w = await world(scenes[8], capture('codex/0.161.0/plan-approval.txt'));
  expect(readDialog('codex', w.control.screen)).toMatchObject({ dialog: 'plan approval', complete: true });
  const run = await answer(w); expect(run.code, run.io.out).toBe(0); expect(run.result?.dialog_kind).toBe('plan approval'); await delivered(w);
});

for (const scene of [
  ['claude-code', '2.1.289', '2.1.289 (Claude Code)', 'question-plain.txt'],
  ['cursor', '2026.10.01', '2026.10.01-14929f9', 'question.txt'],
  ['antigravity', '1.2.16', '1.2.16', 'question-54.txt'],
  ['grok', '1.0.52', '1.0.52', 'question.txt'],
] as const) test(`unrecorded ${scene[0]} ${scene[1]} refuses a readable question`, async () => {
  const w = await world(cursor); w.control.screen = capture(`${scene[0]}/${scene[1]}/${scene[3]}`);
  writeFileSync(join(w.dir, 'team.yaml'), team(scene[0], w.root)); w.host.version = () => scene[2];
  expect(readDialog(scene[0], w.control.screen)).toMatchObject({ dialog: 'question', complete: true }); await refused(w, 'answer.version');
});

// Build question paragraphs within the captured Cursor box; chrome and all choice rows stay
// captured. Changes affect the words after the first row, including after an interior blank.
function cursorBlock(rows: string[]): string {
  const lines = capture('cursor/2026.10.16/question.txt').split('\n');
  const at = lines.findIndex(l => l.includes('1. Which option do you want?')); expect(at).toBeGreaterThan(0);
  const sample = lines[at]!, left = sample.indexOf('│'), right = sample.lastIndexOf('│'), width = right - left - 2;
  lines.splice(at, 1, ...rows.map(row => `${sample.slice(0, left + 1)} ${row.padEnd(width)}${sample.slice(right)}`)); return lines.join('\n');
}
const blocks = [
  { name: 'wrapped continuation', rows: ['1. Which option do you want for', 'the synthetic document?'], changed: ['1. Which option do you want for', 'the synthetic workspace?'] },
  { name: 'interior blank paragraph', rows: ['1. Which option do you want?', '', 'Use the document folder.'], changed: ['1. Which option do you want?', '', 'Use the workspace folder.'] },
] as const;
for (const block of blocks) {
  test(`${block.name} remains answerable when the whole block agrees`, async () => {
    const w = await world(cursor, cursorBlock([...block.rows]));
    expect(readDialog('cursor', w.control.screen)).toMatchObject({ dialog: 'question', complete: true });
    const run = await answer(w); expect(run.code, run.io.out).toBe(0); await delivered(w);
  });
  for (const changeAt of [2, 3]) test(`${block.name} changing at capture ${changeAt} refuses`, async () => {
    const first = cursorBlock([...block.rows]), next = cursorBlock([...block.changed]);
    const one = readDialog('cursor', first), two = readDialog('cursor', next);
    expect(one).toMatchObject({ dialog: 'question', complete: true }); expect(two).toMatchObject({ dialog: 'question', complete: true }); expect(one).not.toEqual(two);
    const w = await world(cursor, first); w.control.onPane = n => { if (n >= changeAt) w.control.screen = next; };
    await refused(w, 'answer.disagree');
  });
}

for (const changeAt of [2, 3]) test(`first question line changing at capture ${changeAt} refuses`, async () => {
  const w = await world(); w.control.onPane = n => { if (n >= changeAt) w.control.screen = w.control.screen.replace('Which option do you want?', 'Which project do you want?'); };
  await refused(w, 'answer.disagree');
});

test('question exceeding the reader cap is incomplete and never dismissed', async () => {
  const frame = cursorBlock(['1. Which option do you want?', ...Array.from({ length: 6 }, (_, n) => `Continuation ${n} of the same question.`)]);
  const screen = frame.slice(frame.indexOf(' ┌')).trimEnd();
  const w = await world(cursor, screen); expect(readDialog('cursor', screen)).toMatchObject({ dialog: 'question', complete: false }); await refused(w, 'answer.incomplete');
});
test('cut question under the visible cap cannot be answered from retained transcript', async () => {
  const header = 'Question 1/1 (1 unanswered)';
  const screen = [header, 'Previous question already answered?', '1. previous choice', '', header, 'Current partial question under review?', 'esc to interrupt', ''].join('\n');
  const w = await world(scenes[8], screen);
  expect(readDialog('codex', screen)).toEqual({ dialog: 'question', text: 'Current partial question under review? esc to interrupt', complete: false }); await refused(w, 'answer.incomplete');
});

for (const keepOptions of [true, false]) test(`stale question above changed live question, live options=${keepOptions}`, async () => {
  const stale = capture('cursor/2026.10.16/question.txt').replace('Which option do you want?', 'Which old name did you choose?');
  const live = capture('cursor/2026.10.16/question.txt');
  const first = `${stale}\n${live}`;
  const next = `${stale}\n${keepOptions ? live.replace('Which option do you want?', 'Which current name do you choose?') : live.replace(/^.*\[ \].*\n/gm, '')}`;
  const w = await world(cursor, first); expect(readDialog('cursor', first)).toMatchObject({ dialog: 'question', complete: true });
  w.control.onPane = n => { if (n >= 2) w.control.screen = next; };
  await refused(w, keepOptions ? 'answer.disagree' : 'answer.not-a-question');
});

test('missing launched identity refuses before version or pane inspection', async () => {
  const w = await world(); updateState(w.dir, state => { delete state.sessions.scene!.seats.lead!.launched; });
  await refused(w, 'answer.identity'); expect(w.calls).not.toContain('version'); expect(w.calls).not.toContain('pane');
});
for (const kind of ['permission', 'login', 'command-approval'] as const) test(`${kind} prompt is never answered`, async () => {
  const w = await world(scenes[0]);
  if (kind === 'permission') w.control.screen = capture('claude-code/2.1.302/permission.txt');
  else if (kind === 'command-approval') { writeFileSync(join(w.dir, 'team.yaml'), team('codex', w.root)); w.control.screen = capture('codex/0.161.0/permission.txt'); }
  else {
    w.control.screen = 'Sign in to continue\n';
    // No login capture is shipped. Only this classification is injected; the actual command
    // must refuse it even if a dialog reading also claims answerable question text.
    w.host.reading = () => ({ kind: 'login', dialog: { dialog: 'question', text: 'Sign in to continue', complete: true } });
  }
  await refused(w, kind === 'login' ? 'answer.login' : 'answer.permission');
});
for (const change of ['permission', 'process'] as const) for (const versionAt of [2, 3]) test(`${change} switches during version lookup ${versionAt}`, async () => {
  const w = await world();
  w.control.onVersion = n => { if (n >= versionAt) { if (change === 'process') w.control.replaced = true; else w.control.screen = capture('cursor/2026.10.16/permission.txt'); } };
  await refused(w, change === 'process' ? 'answer.process' : 'answer.permission');
});

test('another team file refuses before the dialog is dismissed', async () => {
  const w = await world(), other = join(w.base, 'other'); mkdirSync(join(other, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: other, stdio: 'ignore' }); writeFileSync(join(other, '.agents/team.yaml'), team('cursor', other));
  expect(writeGrant(w.home, { name: 'other', kind: 'team', grantee: teamIdOf(other), capabilities: ['dialogs.trust'], roots: [other], scope: [other] }, { now: NOW }).ok).toBe(true);
  await refused(w, 'answer.configuration', 2, ['--file', join(other, '.agents/team.yaml')]); expect(w.calls).not.toContain('pane');
});
test('another session file refuses before the dialog is dismissed', async () => {
  const w = await world(), file = join(w.dir, 'alternate.yaml'); writeFileSync(file, team('cursor', w.root, 'alternate'));
  updateState(w.dir, state => { state.sessions.alternate = structuredClone(state.sessions.scene!); });
  await refused(w, 'answer.configuration', 2, ['--file', file]); expect(w.calls).not.toContain('pane');
});
test('readiness-only retry keeps the delivered line and never repeats the dismiss key', async () => {
  const w = await world(); w.control.busyAfter = true;
  const first = await answer(w); expect(first.code).toBe(1); expect(first.result?.error?.id).toBe('answer.recovery');
  expect(waiting(w)).toMatchObject({ state: 'question-sent-recovery', delivered: true });
  const ids = messages(w); expect(ids).toHaveLength(1); const bytes = readFileSync(join(w.dir, 'send-drops', 'scene', 'lead', ids[0]!));
  w.control.screen = w.control.idle; w.calls.length = 0;
  const retry = await answer(w); expect(retry.code, retry.io.out).toBe(0); expect(messages(w)).toEqual(ids);
  expect(readFileSync(join(w.dir, 'send-drops', 'scene', 'lead', ids[0]!))).toEqual(bytes);
  expect(w.keys).toEqual(['escape']); expect(w.inputs).toEqual([]); expect(w.calls).not.toContain('key'); expect(w.calls).not.toContain('version'); expect(w.calls).not.toContain('send-agents'); expect(waiting(w)).toBeUndefined();
});
