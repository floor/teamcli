// The general seat brief: TeamCLI's built-in default, embedded in the package, delivered first
// by the launch through the drop leg and never typed. A human seat is delivered to and never
// typed into; a seat that reads it through the turn-start hook leaves the signed receipt the
// drop leg writes; a seat the session has launched without a delivery record is named by the
// check, with the repair; and every `team <command>` the brief names still exists in the CLI.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { briefOf, textModuleOf } from '../scripts/brief.ts';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/approve/command.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runDrops } from '../src/commands/drops.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { commands } from '../src/cli.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyOf } from '../src/lobby/recorded.ts';
import {
  GENERAL_BRIEF,
  GENERAL_BRIEF_SHA256,
  deliverGeneralBrief,
  generalBriefBody,
  generalBriefId,
  generalBriefRecord,
} from '../src/launch/general-brief.ts';
import { MESSAGE_ID, receiptHeld } from '../src/mcp/inbox.ts';
import { readRecord, recordHolds } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { approvalStanding } from '../src/store/store.ts';
import { CLAUDE_IDLE, testIo } from './helpers.ts';

const NOW = new Date('2026-10-18T09:00:00Z');
const NOW_ISO = NOW.toISOString();

const TEXT = `format: 1
project: acme
coordinator: lead
operator: desk
session: acme
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
    leads: true
  - role: operator
    name: desk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
const team = loaded.team;
const LEAD = team.seats[0]!;

let base: string;
let root: string;
let dir: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-general-brief-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEXT);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function dropDir(seat: string): string {
  return join(dir, 'send-drops', 'acme', seat);
}

describe('the embedded general brief', () => {
  test('the text is the accepted one, byte for byte', () => {
    expect(createHash('sha256').update(GENERAL_BRIEF).digest('hex')).toBe(GENERAL_BRIEF_SHA256);
    // The brief opens with the seat's name for itself and closes with what comes next; a cut or a
    // reordering moves both.
    expect(GENERAL_BRIEF.startsWith('# You are a seat in a TeamCLI team\n')).toBe(true);
    expect(GENERAL_BRIEF.endsWith('**Next you\'ll receive** your role brief (your job in this kind of project), then your start brief\n(your first task).\n')).toBe(true);
  });

  test('every team command it names exists in the CLI table, and the four it relies on are named', () => {
    const named = new Set<string>();
    for (const match of GENERAL_BRIEF.matchAll(/`team ([a-z][a-z-]*)/g)) named.add(match[1]!);
    for (const match of GENERAL_BRIEF.matchAll(/^\s*team ([a-z][a-z-]*)/gm)) named.add(match[1]!);
    expect([...named].sort()).toEqual(['drops', 'reply', 'send', 'status']);
    for (const name of named) expect(Object.hasOwn(commands, name)).toBe(true);
  });

  test('the record id is the drop leg\'s lowercase UUID, derived from the text', () => {
    expect(MESSAGE_ID.test(generalBriefId())).toBe(true);
    expect(generalBriefId()).toBe(generalBriefId());
  });

  test('the generator reads the brief out of its source, frontmatter and all, and pins its bytes', () => {
    const source = '---\nstatus: accepted\n---\n\n# A brief\n\nBody with `code` and ${not}.\n';
    const text = briefOf(source);
    expect(text).toBe('# A brief\n\nBody with `code` and ${not}.\n');
    const module = textModuleOf(text);
    // The literal escapes what a template literal reads: backticks and `${`.
    expect(module).toContain('\\`code\\`');
    expect(module).toContain('\\${not}');
    expect(module).toContain(`GENERAL_BRIEF_SHA256 = "${createHash('sha256').update(text).digest('hex')}";`);
  });
});

describe('the delivery', () => {
  test('writes a signed drop for a CLI seat, records it in the session, and the read leaves a receipt', async () => {
    const report = deliverGeneralBrief({ dir, root, session: 'acme', seats: ['lead'], home, at: NOW_ISO });
    expect(report).toEqual({
      deliveries: [{ seat: 'lead', ok: true, id: generalBriefId(), at: NOW_ISO }],
    });
    const path = join(dropDir('lead'), generalBriefId());
    expect(existsSync(path)).toBe(true);
    const looked = readRecord(path, generalBriefId());
    expect(looked.ok && looked.record !== null).toBe(true);
    if (!looked.ok || looked.record === null) throw new Error('the record did not read');
    expect(looked.record.payload).toMatchObject({
      kind: 'message',
      to: 'lead',
      to_id: null,
      root,
      session: 'acme',
      at: NOW_ISO,
      body: generalBriefBody(),
      from: 'the launch',
      from_id: null,
      rule: 'the launch delivers it to every seat of its team',
      thread: generalBriefId(),
    });
    expect(readState(dir).sessions.acme?.briefs?.lead).toEqual({ id: generalBriefId(), at: NOW_ISO });

    // The turn-start hook's own path: `team drops --read --seat` shows the brief and leaves the
    // signed read receipt beside it.
    const io = testIo(root, { kind: 'owner' });
    const code = await runDrops(['--read', '--seat', 'lead'], io, { home });
    expect(code).toBe(0);
    expect(io.out).toBe(`${generalBriefBody()}\n`);
    expect(receiptHeld(dropDir('lead'), generalBriefId(), { to: 'lead', root, session: 'acme' }, home)).toBe(true);
  });

  test('a second run leaves the record and its first time as they are', () => {
    const first = deliverGeneralBrief({ dir, root, session: 'acme', seats: ['lead'], home, at: NOW_ISO });
    expect(first.deliveries[0]).toMatchObject({ ok: true });
    const later = new Date('2026-10-19T10:00:00Z').toISOString();
    const second = deliverGeneralBrief({ dir, root, session: 'acme', seats: ['lead'], home, at: later });
    expect(second.deliveries[0]).toMatchObject({ ok: true, existing: true, at: NOW_ISO });
    expect(readState(dir).sessions.acme?.briefs?.lead).toEqual({ id: generalBriefId(), at: NOW_ISO });
  });

  test('a planted unsigned file at the brief id is replaced by the signed record', async () => {
    mkdirSync(dropDir('lead'), { recursive: true });
    const planted = { payload: generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO }), signature: 'not-a-signature' };
    const path = join(dropDir('lead'), generalBriefId());
    writeFileSync(path, `${JSON.stringify(planted, null, 2)}\n`);

    const report = deliverGeneralBrief({ dir, root, session: 'acme', seats: ['lead'], home, at: NOW_ISO });
    expect(report).toEqual({ deliveries: [{ seat: 'lead', ok: true, id: generalBriefId(), at: NOW_ISO }] });
    // The name now holds this brief, signed by this checkout's key, and the session records it.
    expect(recordHolds(path, generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO }), home)).toBe(true);
    expect(readState(dir).sessions.acme?.briefs?.lead).toEqual({ id: generalBriefId(), at: NOW_ISO });
    const io = testIo(root, { kind: 'owner' });
    expect(await runDrops(['--read', '--seat', 'lead'], io, { home })).toBe(0);
    expect(io.out).toBe(`${generalBriefBody()}\n`);
  });

  test('a symbolic link at the brief id is refused and never followed', () => {
    mkdirSync(dropDir('lead'), { recursive: true });
    const target = join(base, 'planted.json');
    const planted = { payload: generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO }), signature: 'not-a-signature' };
    writeFileSync(target, `${JSON.stringify(planted, null, 2)}\n`);
    const before = readFileSync(target, 'utf8');
    const path = join(dropDir('lead'), generalBriefId());
    symlinkSync(target, path);

    const report = deliverGeneralBrief({ dir, root, session: 'acme', seats: ['lead'], home, at: NOW_ISO });
    expect(report).toEqual({
      deliveries: [{ seat: 'lead', ok: false, reason: 'a symbolic link was found and not followed' }],
    });
    // Neither the link nor its target was touched, and nothing was recorded as delivered.
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(readState(dir).sessions.acme).toBeUndefined();
  });
});

describe('team up, a human seat', () => {
  test('delivers the brief by drop to every declared seat and types nothing into the human pane', async () => {
    // The human seat leads and the CLI seat is stopped in the file: the plan is skips alone, so
    // no launch call can be mistaken for the delivery's work.
    const trusted = `format: 1
project: acme
coordinator: desk
operator: desk
session: acme
trust:
  - ${lobbyOf(home, root, { project: 'acme', session: 'acme' })}
  - ${root}
workspace:
  mode: shared
seats:
  - role: implementer
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
  - role: coordinator
    name: desk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`;
    writeFileSync(join(dir, 'team.yaml'), trusted);
    const approveIo = testIo(root, { kind: 'owner' });
    const approved = await runApprove(['--file', '.agents/team.yaml'], approveIo, {
      ask: async () => '2',
      waiting: () => 'empty',
      now: () => NOW,
      home,
    });
    if (approved !== 0) throw new Error(`${approved}: ${approveIo.out}${approveIo.err}`);
    updateState(dir, (state) => {
      state.sessions.acme = { ...emptySession(), watch: { pid: 999, heartbeat: NOW_ISO } };
    });

    const calls: string[] = [];
    const launch: Launch = {
      sessionState: () => 'running',
      startServer: () => {
        calls.push('startServer');
        return true;
      },
      sessionUp: () => true,
      createWorkspace: () => {
        calls.push('createWorkspace');
        return { pane: 'w1:p1', workspace: 'w1' };
      },
      paneRun: () => {
        calls.push('paneRun');
        return true;
      },
      renameAgent: () => true,
      closeWorkspace: () => true,
      agentPanes: () => [],
      agents: () => [],
      paneText: () => null,
      typeText: () => {
        calls.push('typeText');
        return true;
      },
      pressEnter: () => {
        calls.push('pressEnter');
        return true;
      },
      foreground: () => null,
      sleep: async () => {},
      now: () => NOW,
    };
    const sources: UpSources = {
      home,
      now: () => NOW,
      standing: (at) => approvalStanding(at, home),
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [],
      workspaces: () => [],
      alive: () => true,
      sleep: async () => {},
      launch,
      terminal: () => ({
        drain() {},
        async key() {
          return 'timeout';
        },
      }),
    };
    const io = testIo(root, { kind: 'owner' });
    const code = await runUp([], io, sources);
    expect(code).toBe(0);
    expect(`${io.out}${io.err}`).toContain('desk: the pane is a human\'s; nothing is launched into it or typed into it; left as it is\n');
    // Nothing was launched, created or typed, and the human seat's pane was never written to.
    expect(calls).toEqual([]);

    // Both seats received the brief, the human's by the drop leg, and the session records both.
    for (const seat of ['lead', 'desk']) {
      expect(existsSync(join(dropDir(seat), generalBriefId()))).toBe(true);
      const looked = readRecord(join(dropDir(seat), generalBriefId()), generalBriefId());
      expect(looked.ok && looked.record?.payload.to === seat).toBe(true);
    }
    expect(readState(dir).sessions.acme?.briefs).toEqual({
      lead: { id: generalBriefId(), at: NOW_ISO },
      desk: { id: generalBriefId(), at: NOW_ISO },
    });
  });
});

describe('team check', () => {
  function live(): Live {
    return {
      running: true,
      agents: [{ name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null }],
      workspaces: [{ id: 'w1', label: workspaceLabel(LEAD) }],
      screens: { 'w1:p1': CLAUDE_IDLE },
    };
  }

  test('a launched seat with no delivery record is named with the repair', () => {
    updateState(dir, (state) => {
      state.sessions.acme = {
        seats: { lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } },
        worktrees: {},
        watch: { pid: 1, heartbeat: NOW_ISO },
      };
    });
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    expect(`${io.out}${io.err}`).toContain(
      'difference: lead: the general seat brief has not been delivered\n  repair: team reload lead or team up\n',
    );
    expect(code).toBe(1);
  });

  test('a delivered seat is not named, and the human seat reads as delivered too', () => {
    // The deliveries are real here: the check opens each record and verifies it, so a state
    // entry alone is not a delivery.
    deliverGeneralBrief({ dir, root, session: 'acme', seats: ['lead', 'desk'], home, at: NOW_ISO });
    updateState(dir, (state) => {
      state.sessions.acme = {
        ...state.sessions.acme,
        seats: { lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } },
        worktrees: {},
      };
    });
    const io = testIo(root, { kind: 'owner' });
    runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    expect(`${io.out}${io.err}`).not.toContain('general seat brief');
  });

  test('a recorded delivery whose record does not verify is named with the repair', () => {
    updateState(dir, (state) => {
      state.sessions.acme = {
        seats: { lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } },
        worktrees: {},
        briefs: { lead: { id: generalBriefId(), at: NOW_ISO } },
        watch: { pid: 1, heartbeat: NOW_ISO },
      };
    });
    // The state says delivered; the file at the id is a planted envelope the message key never
    // signed, so the seat would be handed nothing it could read.
    mkdirSync(dropDir('lead'), { recursive: true });
    const planted = { payload: generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO }), signature: 'not-a-signature' };
    writeFileSync(join(dropDir('lead'), generalBriefId()), `${JSON.stringify(planted, null, 2)}\n`);
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    expect(`${io.out}${io.err}`).toContain(
      "difference: lead: the general seat brief's delivery record does not verify\n  repair: team reload lead or team up\n",
    );
    expect(code).toBe(1);
  });
});
