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
import { runUp, USAGE, type Launch, type UpSources } from '../src/commands/up.ts';
import { commands } from '../src/cli.ts';
import { workspaceLabel } from '../src/file/sections/seats.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { lobbyOf } from '../src/lobby/recorded.ts';
import {
  GENERAL_BRIEF,
  GENERAL_BRIEF_SHA256,
  currentBriefClaim,
  deliverBriefForAttribution,
  generalBriefBody,
  generalBriefId,
  generalBriefRecord,
  type CurrentBriefClaim,
} from '../src/launch/general-brief.ts';
import { MESSAGE_ID, receiptHeld } from '../src/mcp/inbox.ts';
import { receiptFile, readRecord, recordHolds, signedReceiptOf } from '../src/send/record.ts';
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

/** The seat's current claim, as the read path and the check resolve it. */
function claimOf(seat: string): CurrentBriefClaim | null {
  return currentBriefClaim(readState(dir).sessions.acme?.briefs?.[seat]);
}

/** One delivery through the one boundary every attribution path calls. */
function deliver(input: { seats: readonly string[]; now?: Date; broadcast?: boolean; handover?: string }) {
  return deliverBriefForAttribution({
    dir,
    root,
    session: 'acme',
    home,
    now: input.now ?? NOW,
    team,
    state: readState(dir).sessions.acme ?? emptySession(),
    attributed: input.seats,
    ...(input.broadcast === true ? { broadcast: true } : {}),
    ...(input.handover === undefined ? {} : { handover: input.handover }),
  });
}

/** A claim written the way a launch writes it, before any file: a scene that plants a name can
 *  then know the id the delivery will expect. The incarnation and epoch are fixed strings so the
 *  id is the same in the test and in the writer. */
function seedClaim(seat: string, incarnation = 'inc_0123456789ab', epoch = 'run_0123456789ab'): CurrentBriefClaim {
  const id = generalBriefId(incarnation, generalBriefBody());
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats = { ...(session.seats ?? {}), [seat]: { stage: 'ready' as const } };
    session.briefs = {
      ...(session.briefs ?? {}),
      [seat]: { id, at: NOW_ISO, incarnation, epoch, sha256: GENERAL_BRIEF_SHA256, attempt: 0, stage: 'claimed' as const },
    };
  });
  return {
    id,
    at: NOW_ISO,
    incarnation,
    epoch,
    sha256: GENERAL_BRIEF_SHA256,
    attempt: 0,
    stage: 'claimed',
    superseded: [],
  };
}

describe('the embedded general brief', () => {
  test('the text is the accepted one, byte for byte', () => {
    expect(createHash('sha256').update(GENERAL_BRIEF).digest('hex')).toBe(GENERAL_BRIEF_SHA256);
    // The brief opens with the seat's name for itself and closes with what comes next; a cut or a
    // reordering moves both.
    expect(GENERAL_BRIEF.startsWith('# You are a seat in a TeamCLI team\n')).toBe(true);
    expect(GENERAL_BRIEF.endsWith('**Next you\'ll receive** your role brief (your job in this kind of project), then your start brief\n(your first task).\n')).toBe(true);
  });

  test('every team command it names exists in the CLI table, and the five it relies on are named', () => {
    const named = new Set<string>();
    for (const match of GENERAL_BRIEF.matchAll(/`team ([a-z][a-z-]*)/g)) named.add(match[1]!);
    for (const match of GENERAL_BRIEF.matchAll(/^\s*team ([a-z][a-z-]*)/gm)) named.add(match[1]!);
    expect([...named].sort()).toEqual(['ack', 'drops', 'reply', 'send', 'status']);
    for (const name of named) expect(Object.hasOwn(commands, name)).toBe(true);
  });

  test('the record id is the drop leg\'s lowercase UUID, derived from the lifetime and the text', () => {
    const id = generalBriefId('inc_0123456789ab', generalBriefBody());
    expect(MESSAGE_ID.test(id)).toBe(true);
    expect(id).toBe(generalBriefId('inc_0123456789ab', generalBriefBody()));
    // A different lifetime, a different body, or a recovery's attempt is a different name.
    expect(id).not.toBe(generalBriefId('inc_ba9876543210', generalBriefBody()));
    expect(id).not.toBe(generalBriefId('inc_0123456789ab', generalBriefBody('handover')));
    expect(id).not.toBe(generalBriefId('inc_0123456789ab', generalBriefBody(), 1));
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
  test('writes a signed drop for a CLI seat, records the claim, and the read leaves a bound receipt', async () => {
    const report = deliver({ seats: ['lead'] });
    const claim = claimOf('lead');
    if (claim === null) throw new Error('the delivery recorded no claim');
    // The launch's delivery: the attributed seat, and the human seat this run also delivers to
    // because its claim is behind this build's brief.
    expect(report.deliveries.map((delivery) => delivery.seat)).toEqual(['lead', 'desk']);
    expect(report.deliveries[0]).toEqual({
      seat: 'lead',
      ok: true,
      id: claim.id,
      at: NOW_ISO,
      incarnation: claim.incarnation,
      epoch: claim.epoch,
    });
    expect(report.deliveries[1]).toMatchObject({ seat: 'desk', ok: true });
    // The claim is the delivery's identity: a minted lifetime and runtime, the accepted text's
    // digest, and the id the record was written at. Only a verified read-back finalizes it.
    expect(claim.id).toMatch(MESSAGE_ID);
    expect(claim.incarnation).toMatch(/^inc_[0-9a-f]{12}$/);
    expect(claim.epoch).toMatch(/^run_[0-9a-f]{12}$/);
    expect(claim.sha256).toBe(GENERAL_BRIEF_SHA256);
    expect(claim.attempt).toBe(0);
    expect(claim.stage).toBe('ready');
    expect(readState(dir).sessions.acme?.briefs?.lead).toMatchObject({
      id: claim.id,
      at: NOW_ISO,
      incarnation: claim.incarnation,
      epoch: claim.epoch,
      sha256: GENERAL_BRIEF_SHA256,
      attempt: 0,
      stage: 'ready',
    });
    const path = join(dropDir('lead'), claim.id);
    expect(existsSync(path)).toBe(true);
    const looked = readRecord(path, claim.id);
    expect(looked.ok && looked.record !== null).toBe(true);
    if (!looked.ok || looked.record === null) throw new Error('the record did not read');
    expect(looked.record.payload).toMatchObject({
      kind: 'message',
      id: claim.id,
      to: 'lead',
      to_id: null,
      root,
      session: 'acme',
      at: NOW_ISO,
      body: generalBriefBody(),
      from: 'the launch',
      from_id: null,
      rule: 'the launch delivers it to every seat of its team',
      thread: claim.id,
      brief_sha256: GENERAL_BRIEF_SHA256,
      incarnation: claim.incarnation,
    });
    // The record is the one the claim expected: the id hashes the incarnation and this body.
    expect(claim.id).toBe(generalBriefId(claim.incarnation, generalBriefBody(), 0));

    // The turn-start hook's own path: `team drops --read --seat` shows the brief and leaves the
    // signed read receipt beside it, bound to the claim it served.
    const io = testIo(root, { kind: 'owner' });
    const code = await runDrops(['--read', '--seat', 'lead'], io, { home });
    expect(code).toBe(0);
    expect(io.out).toBe(`${generalBriefBody()}\n`);
    const context = { to: 'lead', root, session: 'acme' };
    expect(receiptHeld(dropDir('lead'), claim.id, context, home)).toBe(true);
    const receipt = signedReceiptOf(JSON.parse(readFileSync(receiptFile(dropDir('lead'), claim.id, 'read'), 'utf8')));
    expect(receipt?.payload).toMatchObject({
      id: claim.id,
      status: 'read',
      brief_sha256: GENERAL_BRIEF_SHA256,
      incarnation: claim.incarnation,
      brief_epoch: claim.epoch,
    });
    // A manual read has no runtime of its own: it binds the claim it served.
    expect(receipt?.payload.brief_epoch).toBe(claim.epoch);
  });

  test('a second delivery of the same claim leaves the record and its first time as they are', () => {
    const first = deliver({ seats: ['lead'] });
    const claim = claimOf('lead');
    if (claim === null) throw new Error('the delivery recorded no claim');
    expect(first.deliveries[0]).toMatchObject({ ok: true });
    // A broadcast to a live seat keeps the claim it already has: one incarnation, one id, and a
    // later clock does not move the delivery's first time.
    updateState(dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats = { ...(session.seats ?? {}), lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } };
    });
    const later = new Date('2026-10-19T10:00:00Z');
    const second = deliver({ seats: [], broadcast: true, now: later });
    // Both seats already hold this build's claim: the broadcast leaves each as it is, encoding
    // its first delivery time rather than the later clock.
    expect(second.deliveries.map((delivery) => delivery.seat)).toEqual(['lead', 'desk']);
    expect(second.deliveries[0]).toEqual({
      seat: 'lead',
      ok: true,
      id: claim.id,
      at: NOW_ISO,
      incarnation: claim.incarnation,
      epoch: claim.epoch,
      existing: true,
    });
    expect(second.deliveries[1]).toMatchObject({ seat: 'desk', ok: true, existing: true });
    expect(claimOf('lead')).toMatchObject({ id: claim.id, at: NOW_ISO, incarnation: claim.incarnation, epoch: claim.epoch });
  });

  test('a planted unsigned file at the brief id is reported and never replaced', async () => {
    const seeded = seedClaim('lead');
    mkdirSync(dropDir('lead'), { recursive: true });
    const planted = { payload: generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO, incarnation: seeded.incarnation }), signature: 'not-a-signature' };
    const path = join(dropDir('lead'), seeded.id);
    writeFileSync(path, `${JSON.stringify(planted, null, 2)}\n`);
    const before = readFileSync(path, 'utf8');

    const report = deliver({ seats: [], broadcast: true });
    expect(report.deliveries.map((delivery) => delivery.seat)).toEqual(['lead', 'desk']);
    expect(report.deliveries[0]).toEqual({
      seat: 'lead',
      ok: false,
      reason: `the name at ${seeded.id} is not this brief's`,
      blocked: 'file',
    });
    expect(report.deliveries[1]).toMatchObject({ seat: 'desk', ok: true });
    // The file is exactly as it was found, and the claim was not finalized: nothing was delivered.
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(claimOf('lead')).toMatchObject({ id: seeded.id, at: NOW_ISO, stage: 'claimed' });
    // A read of that name shows no body and leaves no receipt: the file there is not signed by
    // this checkout's message key, so the read refuses it.
    const io = testIo(root, { kind: 'owner' });
    expect(await runDrops(['--read', '--seat', 'lead'], io, { home })).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team drops: message "${seeded.id}" does not verify against this message key\n`);
    expect(existsSync(receiptFile(dropDir('lead'), seeded.id, 'read'))).toBe(false);
  });

  test('a symbolic link at the brief id is refused and never followed', () => {
    const seeded = seedClaim('lead');
    mkdirSync(dropDir('lead'), { recursive: true });
    const target = join(base, 'planted.json');
    const planted = { payload: generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO, incarnation: seeded.incarnation }), signature: 'not-a-signature' };
    writeFileSync(target, `${JSON.stringify(planted, null, 2)}\n`);
    const before = readFileSync(target, 'utf8');
    const path = join(dropDir('lead'), seeded.id);
    symlinkSync(target, path);

    const report = deliver({ seats: [], broadcast: true });
    expect(report.deliveries.map((delivery) => delivery.seat)).toEqual(['lead', 'desk']);
    expect(report.deliveries[0]).toEqual({
      seat: 'lead',
      ok: false,
      reason: 'a symbolic link was found and not followed',
      blocked: 'nonfile',
    });
    expect(report.deliveries[1]).toMatchObject({ seat: 'desk', ok: true });
    // Neither the link nor its target was touched, and the claim stays unfinalized.
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe(before);
    expect(claimOf('lead')).toMatchObject({ id: seeded.id, stage: 'claimed' });
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

    // Both seats received the brief, the human's by the drop leg, and the session records both
    // with a current claim finalized by its verified record.
    const briefs = readState(dir).sessions.acme?.briefs;
    for (const seat of ['lead', 'desk']) {
      const claim = currentBriefClaim(briefs?.[seat]);
      if (claim === null) throw new Error(`${seat} has no current claim`);
      expect(claim.at).toBe(NOW_ISO);
      expect(claim.stage).toBe('ready');
      expect(claim.sha256).toBe(GENERAL_BRIEF_SHA256);
      expect(existsSync(join(dropDir(seat), claim.id))).toBe(true);
      const looked = readRecord(join(dropDir(seat), claim.id), claim.id);
      expect(looked.ok && looked.record?.payload.to === seat).toBe(true);
      expect(looked.ok && looked.record?.payload.incarnation === claim.incarnation).toBe(true);
    }
  });

  test('--no-launch delivers no general brief: no claim, no drop, and the JSON says no_launch', async () => {
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
    const code = await runUp(['--no-launch', '--json'], io, sources);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const doc = JSON.parse(io.out) as { no_launch?: boolean };
    expect(doc.no_launch).toBe(true);
    const briefs = readState(dir).sessions.acme?.briefs;
    for (const seat of ['lead', 'desk']) {
      expect(currentBriefClaim(briefs?.[seat])).toBeNull();
      expect(existsSync(dropDir(seat))).toBe(false);
    }
  });

  test('the usage names --no-launch for the owner and the --client form', () => {
    const lines = USAGE.split('\n');
    expect(lines[0]).toContain('[--no-launch]');
    expect(lines.find((line) => line.includes('--client'))).toContain('[--no-launch]');
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

  test('a delivered seat is not named, and the human seat reads as delivered too', async () => {
    // The deliveries are real here: the check opens each record and verifies it for the claim, so
    // a state entry alone is not a delivery.
    const report = deliver({ seats: ['lead', 'desk'] });
    expect(report.deliveries.every((delivery) => delivery.ok)).toBe(true);
    updateState(dir, (state) => {
      state.sessions.acme = {
        ...state.sessions.acme,
        seats: { lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } },
        worktrees: {},
      };
    });
    // The CLI seat's read is the receipt the turn-start hook writes, bound to the claim.
    const read = testIo(root, { kind: 'owner' });
    expect(await runDrops(['--read', '--seat', 'lead'], read, { home })).toBe(0);
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
    const seeded = seedClaim('lead');
    updateState(dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats = { ...(session.seats ?? {}), lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } };
      session.worktrees = {};
      session.watch = { pid: 1, heartbeat: NOW_ISO };
    });
    // The state records a delivery; the file at the id is a planted envelope the message key never
    // signed, so the seat would be handed nothing it could read.
    mkdirSync(dropDir('lead'), { recursive: true });
    const planted = { payload: generalBriefRecord({ to: 'lead', root, session: 'acme', at: NOW_ISO, incarnation: seeded.incarnation }), signature: 'not-a-signature' };
    writeFileSync(join(dropDir('lead'), seeded.id), `${JSON.stringify(planted, null, 2)}\n`);
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

  test('a handover variant verifies as the claim\'s record, and reads as delivered', () => {
    // A replaced seat's brief carries the handover sentence its swap path wrote: the claim's id is
    // the delivered body's, not the canonical one, and the canonical digest on the record is what
    // ties the text to this build. The check must not call that record unverifiable.
    const report = deliver({ seats: ['lead'], handover: 'Handover: the previous agent left this note.\n' });
    expect(report.deliveries.find((delivery) => delivery.seat === 'lead')?.ok).toBe(true);
    const claim = claimOf('lead');
    expect(claim).not.toBeNull();
    expect(claim!.id).not.toBe(generalBriefId(claim!.incarnation, generalBriefBody()));
    updateState(dir, (state) => {
      const session = (state.sessions.acme ??= emptySession());
      session.seats = { ...(session.seats ?? {}), lead: { stage: 'ready' as const, pane: 'w1:p1', workspace: 'w1' } };
      session.worktrees = {};
      session.watch = { pid: 1, heartbeat: NOW_ISO };
    });
    const io = testIo(root, { kind: 'owner' });
    const code = runTeamCheck({ file: '.agents/team.yaml' }, io, {
      live: () => live(),
      branch: () => 'main',
      standing: (at) => approvalStanding(at, home),
      now: () => NOW,
      home,
    });
    const said = `${io.out}${io.err}`;
    expect(said).not.toContain('does not verify');
    expect(said).toContain('difference: lead: the general seat brief has been delivered and not read\n');
    expect(code).toBe(1);
  });
});
