// The re-tie gaps the second machine restart showed on 2026-11-16, from synthetic readings only:
// no terminal host, no process table and no registry of the machine's own.
//
// 1. A lead whose record stopped at `launched`, waiting at a dialog, came back with its own
//    conversation in its pane; `team up` planned a fresh workspace resuming that same
//    conversation beside it. The strong restore proof now adopts such a pane
//    (`unreadyRestoreProof`), and no plan resumes a conversation already live on another pane
//    (`liveConversationElsewhere`).
// 2. `team up --retie` launches nothing: a seat it would start is carried with a skip line.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveConversationElsewhere, unreadyRestoreProof } from '../src/launch/restore-proof.ts';
import { upPlan, type UpInput, type UpSeat } from '../src/launch/plan.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';
import { findAgent, recordRebootRebind, registerAgent } from '../src/registry/agents.ts';
import { emptySession, readState, updateState, type SeatState } from '../src/state.ts';

const PANE = 'fixture-pane-lead';
const SPACE = 'fixture-space-lead';
const SES = 'ses_lead_conversation';
const CLI = 'claude-code';
const LAUNCHED = { shell: 100, cli: [200] };
const RESTORED: PaneProcesses = { shell: 700, foreground: [800] };

const entry = (over: Partial<HerdrAgent> = {}): HerdrAgent => ({
  name: null, agent: 'claude', pane: PANE, workspace: SPACE, status: 'idle', cwd: null, session: SES, ...over,
});

function proofInput(over: Partial<Parameters<typeof unreadyRestoreProof>[0]> = {}): Parameters<typeof unreadyRestoreProof>[0] {
  return {
    seat: { name: 'orchestrator', cli: 'claude-code' },
    recorded: { stage: 'launched', pane: PANE, workspace: SPACE, launched: LAUNCHED, waiting: { state: 'waiting-owner', classification: 'question' } },
    agents: [entry()],
    process: RESTORED,
    foreground: ['claude'],
    recordedSession: SES,
    screen: null,
    ...over,
  };
}

describe('a record that never reached ready, restored with its own conversation', () => {
  test('the pane holding the recorded conversation is the seat, waiting or launched', () => {
    expect(unreadyRestoreProof(proofInput())?.kind).toBe('session');
    expect(unreadyRestoreProof(proofInput({ recorded: { stage: 'launched', pane: PANE, workspace: SPACE, launched: LAUNCHED } }))?.kind).toBe('session');
    // Named back already for this seat: still the seat.
    expect(unreadyRestoreProof(proofInput({ agents: [entry({ name: 'orchestrator' })] }))?.kind).toBe('session');
  });

  test('another conversation, none on either side, or no recorded one never adopts', () => {
    expect(unreadyRestoreProof(proofInput({ agents: [entry({ session: 'ses_other' })] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ agents: [entry({ session: undefined })] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ recordedSession: undefined }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ recordedSession: '' }))).toBeNull();
    // The weak CLI-only proof is never enough for a record that did not reach ready.
    expect(unreadyRestoreProof(proofInput({ recordedSession: undefined, agents: [entry({ session: undefined })] }))).toBeNull();
  });

  test("another seat's pane, another workspace, another CLI or the launched pids still in front never adopt", () => {
    expect(unreadyRestoreProof(proofInput({ agents: [entry({ name: 'builder-1' })] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ agents: [entry({ workspace: 'fixture-space-other' })] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ foreground: ['codex'] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ agents: [entry({ agent: 'codex' })] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ process: { shell: 100, foreground: [200] } }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ agents: [] }))).toBeNull();
    expect(unreadyRestoreProof(proofInput({ agents: null }))).toBeNull();
  });

  test('a Codex record adopts on the same strong proof', () => {
    const codex = proofInput({ seat: { name: 'operator', cli: 'codex' }, foreground: ['codex'], agents: [entry({ agent: 'codex' })] });
    expect(unreadyRestoreProof(codex)?.kind).toBe('session');
  });
});

describe('a conversation already live is never launched a second time', () => {
  const agents = [entry({ pane: 'fixture-pane-live', session: SES }), entry({ pane: 'fixture-pane-else', session: 'ses_else' })];

  test('a resume whose conversation runs on another pane names that pane', () => {
    expect(liveConversationElsewhere({ resume: SES, inPlace: undefined, cli: CLI, agents })).toBe('fixture-pane-live');
    expect(liveConversationElsewhere({ resume: SES, inPlace: 'fixture-pane-other', cli: CLI, agents })).toBe('fixture-pane-live');
  });

  test('an in-place repair of the pane holding it, no resume, or no reading is not a second copy', () => {
    expect(liveConversationElsewhere({ resume: SES, inPlace: 'fixture-pane-live', cli: CLI, agents })).toBeNull();
    expect(liveConversationElsewhere({ resume: undefined, inPlace: undefined, cli: CLI, agents })).toBeNull();
    expect(liveConversationElsewhere({ resume: '', inPlace: undefined, cli: CLI, agents })).toBeNull();
    expect(liveConversationElsewhere({ resume: 'ses_not_live', inPlace: undefined, cli: CLI, agents })).toBeNull();
    expect(liveConversationElsewhere({ resume: SES, inPlace: undefined, cli: CLI, agents: null })).toBeNull();
  });

  test("another CLI's conversation with the same id is another namespace", () => {
    expect(liveConversationElsewhere({ resume: SES, inPlace: undefined, cli: 'codex', agents })).toBeNull();
  });
});

describe('team up --retie launches nothing', () => {
  test('a seat --retie left out has its skip line and no launch step', () => {
    const parked = {
      name: 'tester-cursor', cli: 'cursor', launch: 'cursor-agent', cwd: '.', label: 'tester-cursor · tester',
      repairLine: 'team up', stopped: true, rules: '',
      retieSkip: 'not launched: --retie only re-ties seats whose panes are running',
    } as unknown as UpSeat;
    const steps = upPlan({ session: 'vlist', root: '/tmp/fixture-root', seats: [parked] } as unknown as UpInput);
    expect(steps.some((step) => step.kind === 'skip' && step.text === 'tester-cursor: not launched: --retie only re-ties seats whose panes are running')).toBe(true);
    expect(steps.some((step) => step.kind === 'skip' && step.text.includes('stopped in the file'))).toBe(false);
    expect(steps.some((step) => step.kind === 'run' && (step.do as { seat?: string } | undefined)?.seat === 'tester-cursor')).toBe(false);
  });
});

// Round 1b review, finding 2: the restart rebind's fenced writer took Claude Code alone, so a
// proven Codex, Cursor or Grok rebind refused at the write. Each is written now, with no
// socket address; a socket handed in for a non-Claude CLI is refused.
describe('the restart rebind writes every CLI the proof covers', () => {
  let base: string;
  let home: string;
  let dir: string;
  const SESSION = 'fixture-session';
  const TEAM = 'fixture-team-id';
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'restore-adopt-')));
    home = join(base, 'home');
    dir = join(base, 'root', '.agents');
    mkdirSync(home, { recursive: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function standing(cli: string, seat: string) {
    const held: SeatState = {
      stage: 'ready', id: `seat_${'0123456789ab'}`, pane: PANE, workspace: SPACE,
      launched: LAUNCHED, agent_session: SES, pane_shell: 100, pane_shell_start: 1,
    };
    updateState(dir, (file) => {
      const one = (file.sessions[SESSION] ??= emptySession());
      one.seats[seat] = held;
    });
    registerAgent(home, {
      name: seat,
      signing: { model: 'Fixture', version: '1', role: 'implementer' },
      lab: 'fixture-lab',
      cli,
      launcher: null,
      launch: cli,
      reach: { team: TEAM, seat, session: SESSION, pane: PANE, address: null, agent_session: SES },
      seat_handle: held.id!,
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    return { agent: findAgent(home, { team: TEAM, seat })!, held: readState(dir).sessions[SESSION]!.seats[seat]! };
  }

  for (const cli of ['codex', 'cursor', 'grok', 'claude-code']) {
    test(`a proven ${cli} rebind is written`, () => {
      const { agent, held } = standing(cli, `seat-${cli}`);
      const live = { launched: { shell: 700, cli: [800] }, paneShell: 700, paneShellStart: 5, address: null };
      expect(recordRebootRebind(home, agent, dir, held, live)).toBe(true);
      const after = readState(dir).sessions[SESSION]!.seats[`seat-${cli}`]!;
      expect(after.launched).toEqual({ shell: 700, cli: [800] });
      expect(after.pane_shell_start).toBe(5);
    });
  }

  test('the proved CLI start times ride into the state with the pids (E7b: the typed wake\'s full proof)', () => {
    const { agent, held } = standing('codex', 'seat-codex');
    const live = { launched: { shell: 700, cli: [800], cli_start: [9_000] }, paneShell: 700, paneShellStart: 5, address: null };
    expect(recordRebootRebind(home, agent, dir, held, live)).toBe(true);
    expect(readState(dir).sessions[SESSION]!.seats['seat-codex']!.launched).toEqual({ shell: 700, cli: [800], cli_start: [9_000] });
  });

  test('the live proof is read inside the writer, after the snapshots match: a pane that changed meanwhile writes nothing', () => {
    const { agent, held } = standing('codex', 'seat-codex');
    const live = { launched: { shell: 700, cli: [800], cli_start: [9_000] }, paneShell: 700, paneShellStart: 5, address: null };
    const seq = agent.provenance.seq;
    let asked = 0;
    expect(recordRebootRebind(home, agent, dir, held, live, () => { asked += 1; return false; })).toBe(false);
    expect(asked).toBe(1);
    expect(readState(dir).sessions[SESSION]!.seats['seat-codex']!.launched).toEqual(LAUNCHED);
    expect(findAgent(home, { team: TEAM, seat: 'seat-codex' })!.provenance.seq).toBe(seq);
    // A snapshot that no longer matches is refused before the live proof is asked at all.
    const moved = { ...held, agent_session: held.agent_session };
    updateState(dir, (file) => { file.sessions[SESSION]!.seats['seat-codex']!.stage = 'launched'; });
    expect(recordRebootRebind(home, agent, dir, moved, live, () => { asked += 1; return true; })).toBe(false);
    expect(asked).toBe(1);
  });

  test('a socket address for a non-Claude CLI is refused and nothing is written', () => {
    const { agent, held } = standing('codex', 'seat-codex');
    const live = { launched: { shell: 700, cli: [800] }, paneShell: 700, paneShellStart: 5, address: '/fixture/800.sock' };
    expect(recordRebootRebind(home, agent, dir, held, live)).toBe(false);
    expect(readState(dir).sessions[SESSION]!.seats['seat-codex']!.launched).toEqual(LAUNCHED);
  });
});
