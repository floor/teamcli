// The question word of `team answer`: the key a question, plan approval or confirmation dialog
// takes is the CLI's recorded let-me-type-or-cancel key — never an option — and the dialog is
// followed by one decision line through the ordinary send path. Permission, login and
// trust-to-run-a-command prompts are never answered, and the two fresh reads must agree before
// any key is pressed. The scenes stand in the readings a set of shipped profiles does not carry
// yet: the answer seam (`host.reading`) is the one place a profile's reading arrives, and the
// send seam (`host.sendHost`) is the ordinary path's own host.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runAnswer, type AnswerHost, type PaneReading } from '../src/commands/answer.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import type { SendHost } from '../src/commands/send.ts';
import { listFolder } from '../src/file/landing.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import type { Profile } from '../src/profiles/profile.ts';
import type { QuestionAnswerRecord } from '../src/profiles/question-answer.ts';
import { profileFor } from '../src/profiles/index.ts';
import { approvalStanding } from '../src/store/store.ts';
import { readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { readGrants, writeGrant, writeRevocation } from '../src/permissions/grants.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import type { DialogKind } from '../src/watch/dialog.ts';
import { testIo } from './helpers.ts';

const cursorIdle = readFileSync(new URL('./fixtures/cursor/2026.10.01/idle.txt', import.meta.url), 'utf8');
const cursorQuestion = readFileSync(new URL('./fixtures/cursor/2026.10.01/question.txt', import.meta.url), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-10-05T04:00:00.000Z');
const VERSION = '2026.10.01-14929f9';
const LINE = 'decide within your rules or ask your orchestrator with team send';
const QUESTION = 'Which name do you want to use?';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function grantTrust(root: string, home: string): void {
  const written = writeGrant(home, {
    name: `team-${teamIdOf(root)}`,
    kind: 'team',
    grantee: teamIdOf(root),
    capabilities: ['dialogs.trust'],
    roots: [root],
    scope: [root],
  }, { now: NOW });
  if (!written.ok) throw new Error(`the scene's grant was refused: ${written.why}`);
}

function revokeTrust(home: string): void {
  const found = readGrants(home).grants.find((grant) => grant.capabilities.includes('dialogs.trust'));
  if (found === undefined) throw new Error('the scene holds no trust grant to revoke');
  const written = writeRevocation(home, { name: `revoke-${found.name}`, grant: found.name, generation: found.generation }, { now: NOW });
  if (!written.ok) throw new Error(`the scene's revocation was refused: ${written.why}`);
}

function world(rootName = 'acme') {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-answer-question-')));
  const root = join(base, rootName);
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  const lobby = lobbyDir(home);
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobby, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  grantTrust(root, home);
  return { root, home, lobby, sockets, dir: join(root, '.agents') };
}

function file(lobby: string, root: string, stoppedSeat?: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
  - role: worker
    name: helper
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
  - role: worker
    name: worker
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
${stoppedSeat === 'worker' ? '    stopped: true\n' : ''}`;
}

/** The same team with its lead seat on another CLI: the answer reads that CLI's shipped profile,
 *  and the send path still addresses the same declared seat. */
function fileFor(lobby: string, root: string, cli: string): string {
  const launch = cli === 'claude-code' ? 'claude' : cli === 'antigravity' ? 'agy' : cli;
  return file(lobby, root).replace(
    `    name: lead
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor`,
    `    name: lead
    cli: ${cli}
    vendor: test
    model: Grok
    version: "4.7"
    launch: ${launch}`,
  );
}

/** A capture file as the pane handed it over: the whole text, unchanged. */
function capture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), 'utf8');
}

/** The cursor question capture with its one-row question wrapped onto the rows given, laid into
 *  the box at the capture's own interior width. Builder-3's probe pair is two captures of one
 *  pane that differ only in the continuation row, and rows built here differ the same way. */
function wrappedQuestion(rows: readonly string[]): string {
  const lines = cursorQuestion.split('\n');
  const at = lines.findIndex((line) => line.includes('Which name should be used for the file?'));
  if (at < 0) throw new Error('the cursor capture no longer holds the question row');
  const reference = lines[at] as string;
  const open = reference.indexOf('│');
  const close = reference.lastIndexOf('│');
  const room = close - open - 1;
  const boxed = rows.map((row) => `${reference.slice(0, open + 1)} ${row.padEnd(room - 1)}${reference.slice(close)}`);
  lines.splice(at, 1, ...boxed);
  return lines.join('\n');
}

/** The cursor question capture with the rows given laid into the box under the question row, one
 *  blank box row between the paragraphs when a `''` is among them: an interior blank row is the
 *  block's own, and the paragraph after it belongs to the question. */
function questionWithParagraphs(rows: readonly string[]): string {
  const lines = cursorQuestion.split('\n');
  const at = lines.findIndex((line) => line.includes('Which name should be used for the file?'));
  if (at < 0) throw new Error('the cursor capture no longer holds the question row');
  const reference = lines[at] as string;
  const open = reference.indexOf('│');
  const close = reference.lastIndexOf('│');
  const room = close - open - 1;
  const boxed = rows.map((row) => `${reference.slice(0, open + 1)} ${row.padEnd(room - 1)}${reference.slice(close)}`);
  lines.splice(at + 1, 0, ...boxed);
  return lines.join('\n');
}

/** The capture with an older question box laid into the transcript above the live one: the stale
 *  copy carries the same header and an option row of its own, so only the live block nearest the
 *  bottom is the dialog the pane stands at. */
function staleQuestionAbove(): string {
  const stale = [
    ' ┌─────────────────────────────────────────────────┐',
    ' │ Question 1 of 1                                 │',
    ' │ Old question from the transcript?               │',
    ' │                                                 │',
    ' │   › [ ] stale.txt                               │',
    ' └─────────────────────────────────────────────────┘',
  ];
  const retained = cursorQuestion.replace('\n\n\n ┌', ['', ...stale, ' ┌'].join('\n'));
  if (retained === cursorQuestion) throw new Error('the cursor capture no longer holds its transcript rows');
  return retained;
}

/** The capture's dialog box alone: the prompt the seat wrote above it is pane scrollback, and a
 *  tall block keeps the box top inside the reader's last-20-row window only when it goes. */
function boxOnly(screen: string): string {
  const lines = screen.split('\n');
  const top = lines.findIndex((line) => line.includes('┌'));
  if (top < 0) throw new Error('the cursor capture no longer holds its dialog box');
  const box = lines.slice(top);
  if (box[box.length - 1] === '') box.pop();
  return box.join('\n');
}

/** The team file of another project: a readable team, so the run reaches the cross-team check. */
function otherRoot(): { root: string; dir: string } {
  const root = join(base, 'other');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: other
coordinator: lead
operator: helper
session: other
workspace:
  mode: shared
trust:
  - ${lobbyDir(join(base, 'home'))}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
  - role: worker
    name: helper
    cli: cursor
    vendor: test
    model: Grok
    version: "4.7"
    launch: cursor
`);
  return { root, dir };
}

async function approve(root: string, home: string): Promise<void> {
  const code = await runApprove(FILE, testIo(root, { kind: 'owner' }), { ask: async () => '2', waiting: () => 'empty', now: () => NOW, home });
  expect(code).toBe(0);
}

function wait(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  waitIn(dir, 'acme', name, extra);
}

function waitIn(dir: string, session: string, name: string, extra: Record<string, unknown> = {}): void {
  updateState(dir, (state) => {
    state.sessions[session] = {
      seats: {
        [name]: {
          stage: 'launched',
          pane: name === 'lead' ? 'pane1' : 'pane2',
          workspace: 'w1',
          launched: { shell: 4100, cli: [4200] },
          waiting: { state: 'waiting-owner', classification: 'question', ...extra },
        },
      },
      worktrees: {},
    };
  });
}

type Seam = {
  /** One fresh reading per call, in call order: this is how a scene makes the two reads differ. */
  reading?: (read: number) => PaneReading;
  /** The profile's question-answer records; the default answers a question with escape. */
  answers?: readonly QuestionAnswerRecord[];
  /** The version the CLI prints; the default is this lane's synthetic one. */
  printed?: string;
  /** The screen the pane shows once the key is pressed; the default is the cursor idle capture. */
  afterKey?: string;
  /** No reading and no profile seam: the shipped reader and the shipped profiles answer. */
  shipped?: boolean;
};

type Fake = AnswerHost & {
  keys: string[];
  typed: string[];
  entered: number;
  versions: number;
  reads: number;
  screen: string;
  named: boolean;
};

function readOf(dialog: DialogKind | null, text = QUESTION): PaneReading {
  return dialog === null
    ? { kind: 'idle', dialog: { dialog: null } }
    : { kind: dialog, dialog: { dialog, text, complete: true } };
}

function record(kind: DialogKind, key: QuestionAnswerRecord['key'] = 'escape'): QuestionAnswerRecord {
  return { kind, key, from: VERSION, to: VERSION };
}

function fake(home: string, seat: string, screen: string, seam: Seam = {}): Fake {
  let at = NOW.getTime();
  let text = screen;
  let status = 'idle';
  const records = seam.answers ?? [record('question')];
  const host = {
    keys: [] as string[],
    typed: [] as string[],
    entered: 0,
    versions: 0,
    reads: 0,
    named: true,
    get screen() { return text; },
    set screen(value: string) { text = value; },
    version() {
      host.versions += 1;
      return seam.printed ?? VERSION;
    },
    agents() {
      return [{ name: host.named ? seat : '', pane: seat === 'lead' ? 'pane1' : 'pane2', workspace: 'w1' }];
    },
    pane() { return text; },
    sendKey(_session: string, _pane: string, key: string) {
      host.keys.push(key);
      text = seam.afterKey ?? cursorIdle;
      status = 'idle';
      return true;
    },
    rename() { host.named = true; return true; },
    foreground() { return ['cursor-agent']; },
    foregroundCwd() { return lobbyDir(home); },
    processInfo() { return { shell: 4100, foreground: [4100, 4200] }; },
    list(dir: string) { return listFolder(dir); },
    status() { return status; },
    type(_session: string, _pane: string, value: string) {
      host.typed.push(value);
      return true;
    },
    enter() {
      host.entered += 1;
      status = 'working';
      return true;
    },
    reading() {
      host.reads += 1;
      return seam.reading ? seam.reading(host.reads) : readOf('question');
    },
    profile(cli: string): Profile | null {
      if (cli !== 'cursor') return null;
      const shipped = profileFor('cursor');
      if (!shipped) throw new Error('the cursor profile is missing');
      return { ...shipped, questionAnswers: records };
    },
    now: () => new Date(at),
    sleep: async (ms: number) => { at += ms; },
    home,
    standing: (root: string) => approvalStanding(root, home),
  };
  if (seam.shipped) {
    // The shipped reader and the shipped profiles are the subject of the scene: no seam stands
    // in for either of them.
    delete (host as AnswerHost).profile;
    delete (host as AnswerHost).reading;
  }
  return host;
}

/** The ordinary send path's host: no socket is live, so the walk reaches the seat queue, which
 *  accepts the line while the answer itself holds the seat's lock. Nothing is typed. */
function sendHost(home: string, sockets: string): SendHost {
  return {
    agents: () => [{ name: 'lead', pane: 'pane1', cli: 'cursor-agent' }],
    processInfo: () => null,
    socketsDir: sockets,
    deliver: async () => ({ ok: false, reason: 'the scene has no socket' }),
    native: {
      typeText: () => false,
      pressEnter: () => false,
      status: () => null,
      wait: async () => { /* the scene reads its own status */ },
    },
    now: () => NOW,
    home,
  };
}

/** The bodies the seat's drop folder holds: the decision line's own record proves the line took
 *  the send path and not a keystroke. */
function dropBodies(dir: string, seat: string): string[] {
  const folder = join(dir, 'send-drops', 'acme', seat);
  let names: string[] = [];
  try {
    names = readdirSync(folder, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return names.map((name) => readFileSync(join(folder, name), 'utf8'));
}

/** The message records alone: the `<id>.pending` marker a leg writes beside a drop quotes the
 *  same body, and is not a second message. */
function messageRecords(dir: string, seat: string): string[] {
  const folder = join(dir, 'send-drops', 'acme', seat);
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names.filter((name) => !name.includes('.')).map((name) => readFileSync(join(folder, name), 'utf8'));
}

function io(root: string, caller = { kind: 'owner' } as const) {
  return testIo(root, caller);
}

describe('team answer <seat> question', () => {
  test('the recorded key dismisses a question and the decision line takes the send path', async () => {
    const { root, home, lobby, sockets, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    const host = fake(home, 'lead', 'Which name do you want to use?\nsynthetic-note.txt\n');
    host.sendHost = sendHost(home, sockets);
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(0);
    expect(run.err).toBe('');
    expect(run.out).toBe(`team acme, session "acme"\nlead: answered question (question)\n`);
    // One key, the recorded one, and no option: the answer types nothing at the dialog.
    expect(host.keys).toEqual(['escape']);
    expect(host.typed).toEqual([]);
    expect(host.entered).toBe(0);
    // The line is in the seat's drop folder — the ordinary send path's own record — and not on
    // the pane.
    expect(dropBodies(dir, 'lead').some((body) => body.includes(LINE))).toBe(true);
    // The recovery is finished: no waiting record is left behind.
    expect(readState(dir).sessions.acme?.seats.lead?.waiting).toBeUndefined();
    expect(readState(dir).sessions.acme?.seats.lead?.stage).toBe('ready');
  });

  test('both words are behind the one live dialogs.trust grant', async () => {
    const { root, home, lobby, sockets, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    const host = fake(home, 'lead', 'Which name do you want to use?\nsynthetic-note.txt\n');
    host.sendHost = sendHost(home, sockets);
    revokeTrust(home);
    const refused = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question', '--json'], refused, host)).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({
      error: { id: 'answer.policy', message: 'lead: use team up and [o] (dialogs.trust is off; only the owner can turn it on: team grant @team --capabilities dialogs.trust)' },
    });
    // Nothing was read and nothing was sent: the grant is judged before the pane.
    expect(host.keys).toEqual([]);
    expect(host.versions).toBe(0);
    expect(host.reads).toBe(0);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
    // The owner re-grants: the same dialog is answered.
    grantTrust(root, home);
    const answered = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], answered, host)).toBe(0);
    expect(host.keys).toEqual(['escape']);
  });

  test('--json names the word and the dialog kind it answered', async () => {
    const { root, home, lobby, sockets, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'plan approval' });
    const host = fake(home, 'lead', 'Ready to execute?\n', { answers: [record('plan approval')], reading: () => readOf('plan approval', 'Ready to execute?') });
    host.sendHost = sendHost(home, sockets);
    const run = io(root);
    expect(await runAnswer([...FILE, '--json', 'lead', 'question'], run, host)).toBe(0);
    expect(run.err).toBe('');
    expect(JSON.parse(run.out)).toEqual({
      schema: { name: 'team.answer', version: 1 },
      format: 1,
      dry_run: false,
      status: 'answered',
      action_summary: 'lead: answered question (plan approval)',
      project: 'acme',
      session: 'acme',
      seat: 'lead',
      pane: 'pane1',
      dialog: 'question',
      dialog_kind: 'plan approval',
      state: 'ready',
    });
  });

  test('a confirmation takes its own recorded key, and only that key', async () => {
    const { root, home, lobby, sockets, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'confirmation' });
    const host = fake(home, 'lead', 'Unsent comments\n', { answers: [record('confirmation', 'ctrl+c')], reading: () => readOf('confirmation', 'Unsent comments') });
    host.sendHost = sendHost(home, sockets);
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(0);
    expect(host.keys).toEqual(['ctrl+c']);
    expect(host.typed).toEqual([]);
    expect(run.out).toContain('lead: answered question (confirmation)');
  });

  test('a permission prompt is never answered, even when it shows a question', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'permission' });
    // A trust-to-run-a-command prompt is a permission prompt: a question reading beside it does
    // not make it answerable.
    const host = fake(home, 'lead', 'Run this command?\n❯ 1. Yes\n', {
      reading: () => ({ kind: 'permission', dialog: { dialog: 'question', text: 'Run this command?', complete: true } }),
    });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the pane is at a permission prompt, which is never answered\n');
    expect(host.keys).toEqual([]);
    const json = io(root);
    expect(await runAnswer([...FILE, '--json', 'lead', 'question'], json, host)).toBe(1);
    expect(json.err).toBe('');
    expect(JSON.parse(json.out).error.id).toBe('answer.permission');
  });

  test('a login prompt is never answered', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'login' });
    const host = fake(home, 'lead', 'Sign in to continue\n', { reading: () => ({ kind: 'login', dialog: { dialog: null } }) });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the pane is at a login prompt, which is never answered\n');
    expect(host.keys).toEqual([]);
  });

  test('a trust dialog is the trust word\'s, and a plain screen is no dialog at all', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'trust' });
    const trust = fake(home, 'lead', 'Do you trust this folder?\n', { reading: () => ({ kind: 'trust', dialog: { dialog: null } }) });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, trust)).toBe(1);
    expect(run.err).toBe('lead: the pane is at a trust dialog; team answer lead trust answers it\n');
    expect(trust.keys).toEqual([]);

    wait(dir, 'lead', { classification: 'unknown' });
    const plain = fake(home, 'lead', 'just the composer\n', { reading: () => readOf(null) });
    const other = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], other, plain)).toBe(1);
    expect(other.err).toBe('lead: the pane is not at a question, plan approval or confirmation dialog\n');
    expect(plain.keys).toEqual([]);
  });

  test('two fresh reads that do not agree refuse before any key', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    const host = fake(home, 'lead', 'Which name do you want to use?\n', {
      reading: (read) => readOf('question', read === 1 ? 'synthetic-note.txt' : 'synthetic-other.txt'),
    });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the two fresh reads of the pane do not agree on the dialog\n');
    expect(host.keys).toEqual([]);
    expect(host.reads).toBe(2);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a seat with no recorded launch is refused by identity before anything is read', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    // The state keeps the pane and the waiting record but records no launch: with no identity
    // there is no process to compare the pane's with, so the word refuses rather than keying a
    // pane it cannot identify.
    updateState(dir, (state) => {
      delete state.sessions.acme!.seats.lead!.launched;
    });
    const host = fake(home, 'lead', 'Which name do you want to use?\nsynthetic-note.txt\n');
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question', '--json'], run, host)).toBe(1);
    expect(JSON.parse(run.out)).toMatchObject({ error: { id: 'answer.identity' } });
    expect(host.keys).toEqual([]);
    expect(host.versions).toBe(0);
    expect(host.reads).toBe(0);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a same-process switch to a permission prompt on the last read refuses before the key', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    // The process stays the recorded one; only the screen changes, on the read the key path makes
    // immediately before pressing it. The first two reads agree, so only that last full read can
    // see the permission prompt.
    let reads = 0;
    const host = fake(home, 'lead', '', {
      reading: () => (++reads < 3 ? readOf('question') : { kind: 'permission' as const, dialog: { dialog: null } as const }),
    });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the pane is at a permission prompt, which is never answered\n');
    expect(host.keys).toEqual([]);
    expect(host.reads).toBe(3);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a wrapped question is read to its end, so the two captures differing in the continuation row disagree', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    // Builder-3's probe: one pane, captured twice, the captures differing only in the row under
    // the wrapped question. A reading that stops at the first row sees the same text twice and
    // presses the key across the difference; the block is read to its end, so the two reads
    // disagree and no key is pressed.
    const writes = wrappedQuestion(['1. Which name should be used for the', 'file we write?']);
    const names = wrappedQuestion(['1. Which name should be used for the', 'file we name?']);
    // The pane's content is the 2026.10.01 capture's shape; the print is one the shipped
    // profile carries a record for, so the refusal below is the readings' and not the version's.
    const host = fake(home, 'lead', writes, { shipped: true, printed: '2026.10.16-e3cb207' });
    let reads = 0;
    host.pane = () => (reads++ === 0 ? writes : names);
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the two fresh reads of the pane do not agree on the dialog\n');
    expect(host.keys).toEqual([]);
    expect(reads).toBe(2);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('an interior blank row is the block\'s own, so two captures differing in the paragraph after it disagree', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    // Builder-3's command probe: one pane, captured twice, the captures differing only in the
    // paragraph below a blank row inside the box. A reading that ends the block at the blank row
    // sees the same question twice and presses the key; the block is read to its marker, so the
    // paragraph after the blank is read and the two reads disagree — no key is pressed.
    const first = boxOnly(questionWithParagraphs(['Use the first package.', '', 'Use the second package.']));
    const other = boxOnly(questionWithParagraphs(['Use the first package.', '', 'Use the other package.']));
    const host = fake(home, 'lead', first, { shipped: true, printed: '2026.10.16-e3cb207' });
    let reads = 0;
    host.pane = () => (reads++ === 0 ? first : other);
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the two fresh reads of the pane do not agree on the dialog\n');
    expect(host.keys).toEqual([]);
    expect(reads).toBe(2);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a stale question quoted above the live one never wins, so changing only the live question refuses', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    // Operator-3's command probe: the transcript above the live dialog quotes an older question
    // with the same header. A reading that takes the first anchor sees the same stale text twice
    // and presses the key across a live change; the reader takes the whole block nearest the
    // bottom, so changing only the live question makes the two reads disagree — no key is pressed.
    const retained = boxOnly(staleQuestionAbove());
    const changed = retained.replace('Which name should be used for the file?', 'Which file name did the live dialog ask for?');
    expect(changed).not.toBe(retained);
    const host = fake(home, 'lead', retained, { shipped: true, printed: '2026.10.16-e3cb207' });
    let reads = 0;
    host.pane = () => (reads++ === 0 ? retained : changed);
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the two fresh reads of the pane do not agree on the dialog\n');
    expect(host.keys).toEqual([]);
    expect(reads).toBe(2);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a question block that runs past the rows a version reads is refused, never answered in part', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    // The cursor profile reads six rows of a question block. This block keeps going past the
    // sixth, so what was read is only part of the question: the command must leave the pane as it
    // is rather than press the key on a question it half saw.
    const long = boxOnly(wrappedQuestion([
      '1. Which name should be used for the',
      'file we write, and which folder',
      'should hold it, and who owns it',
      'once it is written, and where it',
      'goes if the write fails, and how',
      'long it stays, and why it matters',
      'to anyone reading it later?',
    ]));
    const host = fake(home, 'lead', long, { shipped: true });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the question runs past the rows this version reads; left as it is\n');
    expect(host.keys).toEqual([]);
    expect(readState(dir).sessions.acme?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('a recorded key outside the closed set is refused, never sent', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    const host = fake(home, 'lead', 'Which name do you want to use?\n', {
      answers: [{ ...record('question'), key: '1' as never }],
    });
    const run = io(root);
    expect(await runAnswer([...FILE, 'lead', 'question'], run, host)).toBe(1);
    expect(run.err).toBe('lead: the recorded key is not one this version sends\n');
    expect(host.keys).toEqual([]);
  });

  test('a line the send path cannot deliver leaves the recovery; the retry delivers it and presses no second key', async () => {
    const { root, home, lobby, sockets, dir } = world();
    // The receiving seat is stopped, so the ordinary send path refuses the line.
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root, 'worker'));
    await approve(root, home);
    wait(dir, 'worker', { classification: 'question' });
    const first = fake(home, 'worker', 'Which name do you want to use?\n');
    first.sendHost = sendHost(home, sockets);
    const run = io(root);
    expect(await runAnswer([...FILE, 'worker', 'question'], run, first)).toBe(1);
    expect(run.err).toBe('worker: the dialog was dismissed, but the decision line could not be delivered; recovery required\n');
    expect(first.keys).toEqual(['escape']);
    const held = readState(dir).sessions.acme?.seats.worker?.waiting;
    expect(held?.state).toBe('question-sent-recovery');
    expect(held?.dialog).toBe('question');

    // The seat is addressable again, and the retry completes the recovery: the line goes out
    // through the send path, and the dialog is not read or pressed a second time.
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    const retry = fake(home, 'worker', cursorIdle);
    retry.sendHost = sendHost(home, sockets);
    const again = io(root);
    expect(await runAnswer([...FILE, 'worker', 'question'], again, retry)).toBe(0);
    expect(retry.keys).toEqual([]);
    expect(retry.reads).toBe(0);
    expect(again.out).toBe(`team acme, session "acme"\nworker: answered question (question)\n`);
    expect(readState(dir).sessions.acme?.seats.worker?.waiting).toBeUndefined();
    expect(dropBodies(dir, 'worker').some((body) => body.includes(LINE))).toBe(true);
  });

  test('a line delivered by a run whose readiness never came is not sent again by the retry', async () => {
    const { root, home, lobby, sockets, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'worker', { classification: 'question' });
    const questioned = capture('cursor/2026.10.01/question.txt');
    // The send path takes the line, and the pane never reaches its idle prompt: finish() fails
    // and leaves the recovery, with the delivery already made.
    const first = fake(home, 'worker', questioned, { afterKey: questioned });
    first.sendHost = sendHost(home, sockets);
    const run = io(root);
    expect(await runAnswer([...FILE, 'worker', 'question'], run, first)).toBe(1);
    expect(run.err).toBe('worker: question sent; recovery required\n');
    expect(first.keys).toEqual(['escape']);
    expect(messageRecords(dir, 'worker').filter((body) => body.includes(LINE))).toHaveLength(1);
    expect(readState(dir).sessions.acme?.seats.worker?.waiting?.state).toBe('question-sent-recovery');

    // The retry finishes the readiness, and the one line is still the one already delivered:
    // no key, no fresh read, no second message record.
    const retry = fake(home, 'worker', cursorIdle);
    retry.sendHost = sendHost(home, sockets);
    const again = io(root);
    expect(await runAnswer([...FILE, 'worker', 'question'], again, retry)).toBe(0);
    expect(retry.keys).toEqual([]);
    expect(retry.reads).toBe(0);
    // One message record: the retry sent no second line. Its `.pending` marker, written beside
    // the first send's drop, quotes the same body and is not a message.
    expect(messageRecords(dir, 'worker').filter((body) => body.includes(LINE))).toHaveLength(1);
    expect(again.out).toBe(`team acme, session "acme"\nworker: answered question (question)\n`);
    expect(readState(dir).sessions.acme?.seats.worker?.waiting).toBeUndefined();
  });

  test('the line is never put into another team\'s seat of the same name', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { classification: 'question' });
    const other = otherRoot();
    const host = fake(home, 'lead', 'Which name do you want to use?\n');
    // The run reads this project's file through the owner's flag, but started in another
    // project: the send path would load the other team, so no key is pressed.
    const run = testIo(other.root, { kind: 'owner' });
    expect(await runAnswer(['--file', join(dir, 'team.yaml'), 'lead', 'question'], run, host)).toBe(2);
    expect(run.err).toContain('the decision line is sent with the team file of');
    expect(host.keys).toEqual([]);
  });

  test('the send path must be the team and session this answer read, not another file in the same root', async () => {
    const { root, home, lobby, sockets, dir } = world();
    // Two team files in one root: the folder's default is `acme`, and the owner answers through
    // a file whose own session is `beta`. The send path loads the default, so answering `beta`
    // would put the line into `acme`'s seat of the same name.
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    writeFileSync(join(dir, 'other.yaml'), file(lobby, root).replace('session: acme', 'session: beta'));
    await approve(root, home);
    waitIn(dir, 'beta', 'lead', { classification: 'question' });
    const host = fake(home, 'lead', 'Which name do you want to use?\n');
    host.sendHost = sendHost(home, sockets);
    const run = io(root);
    expect(await runAnswer(['--file', '.agents/other.yaml', 'lead', 'question'], run, host)).toBe(2);
    expect(run.err).toBe('team answer: the decision line is sent in session acme, and this answer read session beta\n');
    // Nothing was read, pressed or delivered: the mismatch is refused before any key.
    expect(host.keys).toEqual([]);
    expect(host.reads).toBe(0);
    expect(dropBodies(dir, 'lead')).toEqual([]);
    expect(readState(dir).sessions.beta?.seats.lead?.waiting?.state).toBe('waiting-owner');
  });

  test('the orchestrator may answer from its own seat; another seat may not', async () => {
    const { root, home, lobby, sockets, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    // The state records both seats: lead on pane1, helper on pane2.
    updateState(dir, (state) => {
      state.sessions.acme = {
        seats: {
          lead: { stage: 'launched', pane: 'pane1', workspace: 'w1', launched: { shell: 4100, cli: [4200] } },
          helper: { stage: 'launched', pane: 'pane2', workspace: 'w1', launched: { shell: 4100, cli: [4200] }, waiting: { state: 'waiting-owner', classification: 'question' } },
        },
        worktrees: {},
      };
    });
    const host = fake(home, 'helper', 'Which name do you want to use?\n');
    host.sendHost = sendHost(home, sockets);
    const lead = testIo(root, { kind: 'seat', name: 'lead', pane: 'pane1', session: 'acme' });
    expect(await runAnswer(['helper', 'question'], lead, host)).toBe(0);
    expect(host.keys).toEqual(['escape']);
    expect(lead.out).toContain('helper: answered question (question)');

    // A worker seat is not the orchestrator, so it answers nothing.
    updateState(dir, (state) => {
      const seat = state.sessions.acme?.seats.helper;
      if (seat) seat.waiting = { state: 'waiting-owner', classification: 'question' };
    });
    const other = fake(home, 'helper', 'Which name do you want to use?\n');
    const helper = testIo(root, { kind: 'seat', name: 'helper', pane: 'pane2', session: 'acme' });
    expect(await runAnswer(['helper', 'question'], helper, other)).toBe(1);
    expect(helper.err).toBe('helper: only the owner, or the orchestrator from its own seat, can answer\n');
    expect(other.keys).toEqual([]);
  });

  test('status and doctor name the recovery and the word that completes it', async () => {
    const { root, home, lobby, dir } = world();
    writeFileSync(join(dir, 'team.yaml'), file(lobby, root));
    await approve(root, home);
    wait(dir, 'lead', { state: 'question-sent-recovery', classification: 'plan approval', dialog: 'plan approval' });
    const live: Live = {
      running: true,
      agents: [{ name: 'lead', agent: 'cursor', pane: 'pane1', workspace: 'w1', status: 'idle', cwd: null }],
      workspaces: [],
      screens: {},
    };
    const sources: StatusSources = {
      live: () => live,
      branch: () => null,
      standing: (project) => approvalStanding(project, home),
      now: () => NOW,
      home,
    };
    const status = testIo(root, { kind: 'owner' });
    expect(await runStatus(FILE, status, sources)).toBe(1);
    expect(status.out).toContain('question sent; recovery required');
    expect(status.out).toContain('team answer lead question');

    const doctorSources: DoctorSources = {
      version: () => VERSION,
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => true,
      now: () => NOW,
      home,
      paneText: () => cursorIdle,
      standing: (project) => approvalStanding(project, home),
    };
    const doctor = testIo(root, { kind: 'owner' });
    await runDoctor(FILE, doctor, doctorSources);
    expect(doctor.out).toContain('lead: question sent; recovery required; a lead runs team answer lead question');
  });
});

// The captured dialogs, end to end: the pane hands over a real capture file, the shipped screen
// reader classifies it and places its question text, the shipped profile supplies the record for
// the version printed, and the whole answer — key, line, readiness — runs with no reading or
// profile seam. Each scene is the reachability proof for its CLI: data the release ships is all
// the scene has.
const CAPTURED = [
  // The printed version is each capture README's own `--version` string, byte for byte: the
  // answer layer matches what the CLI prints, not the folder's number.
  { cli: 'claude-code', printed: '2.1.302 (Claude Code)', question: 'claude-code/2.1.302/question.txt', idle: 'claude-code/2.1.302/idle.txt' },
  // `2026.10.01-14929f9` saves no `cursor-agent --version` print, so the shipped profile ships no
  // key record for that build: the reachability proof uses the print a capture saved.
  { cli: 'cursor', printed: '2026.10.16-e3cb207', question: 'cursor/2026.10.16/question.txt', idle: 'cursor/2026.10.16/idle.txt' },
  { cli: 'gemini', printed: '0.64.0', question: 'gemini/0.64.0/question.txt', idle: 'gemini/0.64.0/idle.txt' },
  { cli: 'antigravity', printed: '1.4.2', question: 'antigravity/1.4.2/question.txt', idle: 'antigravity/1.4.2/idle.txt' },
] as const;

describe('a captured question, read and answered by the shipped data alone', () => {
  for (const captured of CAPTURED) {
    test(`${captured.cli} at ${captured.printed}`, async () => {
      const { root, home, lobby, sockets, dir } = world();
      writeFileSync(join(dir, 'team.yaml'), fileFor(lobby, root, captured.cli));
      await approve(root, home);
      wait(dir, 'lead', { classification: 'question' });
      const host = fake(home, 'lead', capture(captured.question), {
        shipped: true,
        printed: captured.printed,
        afterKey: capture(captured.idle),
      });
      host.sendHost = sendHost(home, sockets);
      const run = io(root);
      const code = await runAnswer([...FILE, 'lead', 'question'], run, host);
      // The refusal is read first: a red scene says why the shipped data alone did not answer.
      expect(run.err).toBe('');
      expect(code).toBe(0);
      expect(host.keys).toEqual(['escape']);
      expect(host.typed).toEqual([]);
      expect(host.entered).toBe(0);
      expect(run.out).toContain('lead: answered question (question)');
      expect(dropBodies(dir, 'lead').some((body) => body.includes(LINE))).toBe(true);
      expect(readState(dir).sessions.acme?.seats.lead?.waiting).toBeUndefined();
    });
  }
});
