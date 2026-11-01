// Independent regression scenes derived from the reported split and the production readers.
// Only the source was consulted: the author's and the other tester's scenes were not read.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { importTeamFile } from '../src/file/team-import.ts';
import type { Io } from '../src/io.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signedRecordOf } from '../src/send/record.ts';
import { modelDiffers, runningModel, signedSeatModel, type Running } from '../src/status/statusline.ts';
import { emptySession, updateState } from '../src/state.ts';

const pair = (model: string, version: string): Running => ({ model, version });

const equivalent: Array<[string, Running, Running]> = [
  ['Gemini variant after the number', pair('Gemini', '4 Argon'), pair('Gemini Argon', '4')],
  ['Gemini variant before the number', pair('Gemini', 'Argon 4'), pair('Gemini Argon', '4')],
  ['Claude variant crosses the field boundary', pair('Claude', '5.5 Opus'), pair('Claude Opus', '5.5')],
  ['GPT variant crosses the field boundary', pair('GPT', '6.1 Sol'), pair('GPT Sol', '6.1')],
  ['DeepSeek variant and version prefix', pair('DeepSeek', 'V4.1 Flash'), pair('DeepSeek Flash', '4.1')],
  ['GLM variant crosses the field boundary', pair('GLM', '5.3 Air'), pair('GLM Air', '5.3')],
  ['A4 remains a name word across fields', pair('Example', '4 A4'), pair('Example A4', '4')],
  ['B2 remains a name word across fields', pair('Example', '2 B2'), pair('Example B2', '2')],
  ['2B capacity remains a name word across fields', pair('Example', '2.5 2B'), pair('Example 2B', '2.5')],
  ['separators and capitalization do not hide a split', pair('deepseek-flash', '4.1'), pair('DeepSeek', 'Flash V4.1')],
];

describe('new equivalences: each scene fails on the pre-fix reader', () => {
  for (const [name, recorded, shown] of equivalent) {
    test(name, () => {
      expect(modelDiffers(shown, recorded)).toBe(false);
      expect(modelDiffers(recorded, shown)).toBe(false);
    });
  }
});

const differences: Array<[string, Running, Running]> = [
  ['another family', pair('Gemini Argon', '4'), pair('Example Argon', '4')],
  ['another variant', pair('Gemini Argon', '4'), pair('Gemini Flash', '4')],
  ['another version', pair('Gemini Argon', '4'), pair('Gemini Argon', '5')],
  ['version digits retain their order', pair('GLM', '3.5'), pair('GLM', '5.3')],
  ['2B capacity cannot disappear', pair('Example 2B', '2.5'), pair('Example', '2.5')],
  ['2B capacity cannot become 3B', pair('Example 2B', '2.5'), pair('Example 3B', '2.5')],
  ['A4 cannot disappear into numeric version 4', pair('Example A4', '4'), pair('Example', '4')],
  ['B2 cannot disappear into numeric version 2', pair('Example B2', '2'), pair('Example', '2')],
  ['a letter-bearing identity cannot change its letter', pair('Example A4', '4'), pair('Example B4', '4')],
  ['no-digit version cannot borrow the model field number', pair('Gemini 4', 'Argon'), pair('Gemini Argon', '4')],
  ['missing numeric version cannot borrow the other side', pair('Gemini Argon', ''), pair('Gemini Argon', '4')],
];

describe('existing differences remain drift', () => {
  for (const [name, left, right] of differences) {
    test(name, () => {
      expect(modelDiffers(left, right)).toBe(true);
      expect(modelDiffers(right, left)).toBe(true);
    });
  }
});

test('unread remains unread, with no claimed match or drift', () => {
  const declared = pair('Gemini', '4 Argon');
  expect(modelDiffers(null, declared)).toBe(false);
  expect(runningModel('cursor', 'The model footer is unavailable.')).toBeNull();
  expect(signedSeatModel({ cli: 'cursor', launch: 'agent', ...declared }, undefined)).toBeNull();
});

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-10-31T12:00:00.000Z');
const PANE = 'fixture-pane-cursor';
const MESSAGE = 'Independent model comparison fixture message.';
const ID = 'model-reading-fixture';

// The profile pins the footer beneath the input, with the workspace last. This is synthetic
// text from that grammar, with no capture of a real pane or any invocation of a terminal host.
function cursorScreen(variant = 'Argon'): string {
  return ['Cursor Agent', '  →', '', '', `  Gemini 4 ${variant} High  Run Everything`, '  <workspace>'].join('\n');
}

function sendFixture(screen: string | null) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-model-reading-')));
  made.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: 'ignore',
  });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: fixture
session: fixture
coordinator: receiver
operator: receiver
workspace:
  mode: shared
trust:
  - ${lobbyDir(home)}
  - ${root}
seats:
  - name: receiver
    role: implementer
    cli: cursor
    vendor: synthetic
    model: Gemini
    version: "4 Argon"
    launch: agent --model synthetic
delivery_order: [drop]
`);
  const imported = importTeamFile({ cwd: root, home, mode: 'import', now: NOW });
  if (!imported.ok) throw new Error(JSON.stringify(imported.errors));
  const agent = registerAgent(home, {
    name: 'fixture receiver', signing: { model: 'Gemini', version: '4 Argon', role: 'implementer' },
    lab: 'synthetic', cli: 'cursor', launcher: null, launch: 'agent --model synthetic',
    reach: { team: teamIdOf(root), seat: 'receiver', session: 'fixture', pane: PANE, address: null },
    mcp: [], skills: [], lifecycle: 'running', by: 'synthetic fixture',
  });
  upsertTeam(home, teamIdOf(root), {
    project: 'fixture', session: 'fixture', root, lifecycle: 'running',
    roster: [{ agent: agent.id, seat: 'receiver', role: 'implementer', leads: true }], by: 'synthetic fixture',
  });
  updateState(dir, (state) => {
    const session = (state.sessions.fixture ??= emptySession());
    session.seats.receiver = { stage: 'ready', pane: PANE, cli: 'cursor' };
  });
  const neverType = (): never => { throw new Error('the synthetic send must not type or dial'); };
  const seen: string[] = [];
  const host: SendHost = {
    home, now: () => NOW, sendId: () => ID, delivery: { team: ['drop'] },
    agents: () => [{ name: 'receiver', pane: PANE, cli: 'cursor-agent' }],
    processInfo: () => ({ shell: 101, foreground: [202] }),
    socketsDir: join(base, 'unused-sockets'), deliver: neverType,
    native: {
      typeText: neverType, pressEnter: neverType, sendKey: neverType,
      status: () => 'idle', wait: async () => {},
      paneText: (session, pane) => { seen.push(`${session}/${pane}`); return screen; },
    },
  };
  const io: Io & { out: string; err: string } = {
    cwd: root, env: {}, caller: { kind: 'owner' }, stdinIsTTY: false, stdoutIsTTY: false,
    out: '', err: '', stdout: (text) => { io.out += text; }, stderr: (text) => { io.err += text; },
  };
  const drops = join(dir, 'send-drops', 'fixture', 'receiver');
  return { io, host, seen, drops };
}

test('a real send to a synthetic Cursor pane accepts the split and writes a signed message', async () => {
  const screen = cursorScreen();
  expect(runningModel('cursor', screen)).toEqual(pair('Gemini Argon', '4'));
  const fixture = sendFixture(screen);
  const code = await runSend(['receiver', MESSAGE], fixture.io, fixture.host);
  expect(code, fixture.io.err).toBe(0);
  expect(fixture.seen).toContain(`fixture/${PANE}`);
  expect(fixture.io.err).not.toContain('model drift');
  const record = signedRecordOf(JSON.parse(readFileSync(join(fixture.drops, ID), 'utf8')));
  expect(record).not.toBeNull();
  expect(record?.payload.body).toContain(MESSAGE);
});

test('the same synthetic send still holds a real variant difference before writing a message', async () => {
  const fixture = sendFixture(cursorScreen('Flash'));
  expect(await runSend(['receiver', MESSAGE], fixture.io, fixture.host)).toBe(1);
  expect(fixture.io.err).toContain('model drift');
  expect(existsSync(fixture.drops) ? readdirSync(fixture.drops) : []).toEqual([]);
});

test('an unread synthetic Cursor pane stays unread and does not fabricate drift', async () => {
  const fixture = sendFixture(null);
  expect(await runSend(['receiver', MESSAGE], fixture.io, fixture.host), fixture.io.err).toBe(0);
  expect(fixture.io.err).not.toContain('model drift');
  const record = signedRecordOf(JSON.parse(readFileSync(join(fixture.drops, ID), 'utf8')));
  expect(record?.payload.body).toContain(MESSAGE);
});
