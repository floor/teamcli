// The re-tie gaps the second machine restart showed on 2026-11-16, from synthetic readings only:
// no terminal host, no process table and no registry of the machine's own.
//
// 1. A lead whose record stopped at `launched`, waiting at a dialog, came back with its own
//    conversation in its pane; `team up` planned a fresh workspace resuming that same
//    conversation beside it. The strong restore proof now adopts such a pane
//    (`unreadyRestoreProof`), and no plan resumes a conversation already live on another pane
//    (`liveConversationElsewhere`).
// 2. `team up --retie` launches nothing: a seat it would start is carried with a skip line.
import { describe, expect, test } from 'bun:test';
import { liveConversationElsewhere, unreadyRestoreProof } from '../src/launch/restore-proof.ts';
import { upPlan, type UpInput, type UpSeat } from '../src/launch/plan.ts';
import type { HerdrAgent, PaneProcesses } from '../src/herdr.ts';

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
