// The restore gaps a machine restart showed on 2026-11-16, each from synthetic readings only: no
// terminal host, no process table and no registry of the machine's own.
//
// 1. `team up --rebind` on a pane the host restored: the recorded pids cannot survive a restart,
//    so the proof is the record's launch predating this boot plus the pane holding exactly the
//    recorded conversation and the declared CLI (`rebootRebindProof`).
// 2. A workspace carrying a declared seat's label with no record naming it is offered to the
//    sweep, which closes it only from fresh readings (`labelledLeftovers`).
// 3. A seat that stays is repainted with the model its pane shows (`liveLineOf`, the plan's
//    repaint), not the file's.
// 4. A Grok launch carries a minted `--session-id`, so a later relaunch can resume it.
import { describe, expect, test } from 'bun:test';
import { BOOT_SKEW_MS, rebootRebindProof, type RebootRebindInput } from '../src/launch/reboot-rebind.ts';
import { labelledLeftovers, liveLineOf } from '../src/commands/up.ts';
import { upPlan, type UpInput, type UpSeat } from '../src/launch/plan.ts';
import { launchSessionId, withLaunchSession, withResume } from '../src/profiles/profile.ts';
import type { Seat } from '../src/file/types.ts';

const BOOT = Date.parse('2026-11-16T06:32:00Z');
const BEFORE = Date.parse('2026-11-15T09:00:00Z');
const AFTER = Date.parse('2026-11-16T06:36:00Z');
const SES = 'ses_reboot_1';

function input(over: Partial<RebootRebindInput> = {}): RebootRebindInput {
  return {
    cli: 'claude-code',
    launched: { shell: 100, cli: [200] },
    paneShellStart: BEFORE,
    recordedSession: SES,
    processes: { shell: 700, foreground: [800] },
    foreground: ['claude'],
    liveSession: SES,
    startOf: (pid) => (pid === 1 ? BOOT : pid === 700 ? AFTER : null),
    ...over,
  };
}

describe('rebind across a machine restart', () => {
  test('a restored pane with the recorded conversation, a pre-boot launch and the CLI in front is the seat', () => {
    const proof = rebootRebindProof(input());
    expect(proof).toEqual({ ok: true, launched: { shell: 700, cli: [800] }, shell: 700, shellStart: AFTER, boot: BOOT });
  });

  test('the recorded process still in front is not this proof (the plain rebind takes it)', () => {
    expect(rebootRebindProof(input({ processes: { shell: 100, foreground: [200] } })).ok).toBe(false);
  });

  test('another conversation, a blank one, or a record without one is refused', () => {
    expect(rebootRebindProof(input({ liveSession: 'ses_other' })).ok).toBe(false);
    expect(rebootRebindProof(input({ liveSession: undefined })).ok).toBe(false);
    expect(rebootRebindProof(input({ recordedSession: undefined })).ok).toBe(false);
    expect(rebootRebindProof(input({ recordedSession: '', liveSession: '' })).ok).toBe(false);
  });

  test('another CLI in front is refused', () => {
    const proof = rebootRebindProof(input({ foreground: ['codex'] }));
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.why).toContain('claude-code is not in front');
    expect(rebootRebindProof(input({ foreground: null })).ok).toBe(false);
  });

  test('a launch from this boot is refused: only a restart explains the lost pids', () => {
    const proof = rebootRebindProof(input({ paneShellStart: BOOT + 60_000 }));
    expect(proof.ok).toBe(false);
    if (!proof.ok) expect(proof.why).toContain('launched in this boot');
    // Within the clock's granularity of the boot is not before it either.
    expect(rebootRebindProof(input({ paneShellStart: BOOT - BOOT_SKEW_MS + 1 })).ok).toBe(false);
  });

  test('no recorded shell start, an unreadable boot, or a live shell older than the boot is refused', () => {
    expect(rebootRebindProof(input({ paneShellStart: undefined })).ok).toBe(false);
    expect(rebootRebindProof(input({ startOf: (pid) => (pid === 700 ? AFTER : null) })).ok).toBe(false);
    expect(rebootRebindProof(input({ startOf: (pid) => (pid === 1 ? BOOT : pid === 700 ? BEFORE : null) })).ok).toBe(false);
    expect(rebootRebindProof(input({ startOf: (pid) => (pid === 1 ? BOOT : null) })).ok).toBe(false);
  });

  test('a pane back at its bare shell is not a restored seat', () => {
    expect(rebootRebindProof(input({ processes: { shell: 700, foreground: [700] } })).ok).toBe(false);
  });
});

const seat = (name: string, role: string, extra: Partial<{ stopped: boolean; human: boolean }> = {}) => ({
  name, role, label: name, ...extra,
});

describe('labelled leftovers after a restart', () => {
  const seats = [seat('tester-cursor', 'tester'), seat('reviewer-gemini', 'reviewer', { stopped: true }), seat('orchestrator', 'orchestrator')];

  test("a workspace with a stopped or missing seat's label and no record naming it is offered", () => {
    const out = labelledLeftovers(seats, { orchestrator: { workspace: 'w3H' } }, [
      { id: 'w3H', label: 'orchestrator · orchestrator' },
      { id: 'w3M', label: 'tester-cursor · tester' },
      { id: 'w4E', label: 'reviewer-gemini · reviewer' },
    ]);
    expect(out).toEqual([
      { seat: 'tester-cursor', workspace: 'w3M' },
      { seat: 'reviewer-gemini', workspace: 'w4E' },
    ]);
  });

  test('a workspace whose label names no declared seat is never offered', () => {
    expect(labelledLeftovers(seats, {}, [{ id: 'w1', label: 'md3.io' }, { id: 'w21', label: 'Bus · teamcli' }])).toEqual([]);
  });

  test("a workspace a record names, the seat's own current one, or one already swept is left alone", () => {
    expect(labelledLeftovers(seats, { 'tester-cursor': { workspace: 'w3M' } }, [{ id: 'w3M', label: 'tester-cursor · tester' }])).toEqual([]);
    expect(labelledLeftovers(seats, { other: { workspace: 'w3M' } }, [{ id: 'w3M', label: 'tester-cursor · tester' }])).toEqual([]);
    expect(labelledLeftovers(seats, {}, [{ id: 'w3M', label: 'tester-cursor · tester' }], [{ workspace: 'w3M' }])).toEqual([]);
  });

  test('a human seat and a label two seats share are never offered; an unread host offers nothing', () => {
    const twins = [seat('a', 'tester'), { ...seat('b', 'tester'), name: 'b', label: 'a' }, seat('h', 'owner', { human: true })];
    expect(labelledLeftovers(twins, {}, [{ id: 'w1', label: 'a · tester' }, { id: 'w2', label: 'h · owner' }])).toEqual([]);
    expect(labelledLeftovers(seats, {}, null)).toEqual([]);
  });
});

describe('a seat that stays is repainted from its pane', () => {
  const fable = {
    name: 'orchestrator', role: 'orchestrator', label: 'Agamemnon', cli: 'claude-code',
    model: 'Claude Fable', version: '5.2', display: 'Claude Fable 5.2',
  } as unknown as Seat;

  test('the live model wins over the file, and the difference is named', () => {
    const live = liveLineOf(fable, undefined, 'Opus 5.5\n');
    expect(live.liveDisplayAgent).toBe('Claude Opus 5.5 default');
    expect(live.liveDisplayNote).toBe('its pane shows Claude Opus 5.5 default; the file declares Claude Fable 5.2 default');
  });

  test('a pane that agrees with the file, or one that cannot be read, keeps the file line', () => {
    expect(liveLineOf(fable, undefined, 'Fable 5.2\n')).toEqual({});
    expect(liveLineOf(fable, undefined, null)).toEqual({});
    expect(liveLineOf(fable, undefined, '')).toEqual({});
  });

  test("the plan's repaint paints the live line on the recorded pane and notes why", () => {
    const kept: UpSeat = {
      name: 'orchestrator', cli: 'claude-code', launch: 'claude', cwd: '.', label: 'Agamemnon · orchestrator',
      displayAgent: 'Claude Fable 5.2 default', liveDisplayAgent: 'Claude Opus 5.5 default',
      liveDisplayNote: 'its pane shows Claude Opus 5.5 default; the file declares Claude Fable 5.2 default',
      model: 'Claude Fable', version: '5.2', repairLine: 'team up', stage: 'ready', pane: 'w47:p1', workspace: 'w47',
      restoreKeep: { reason: 'restore left the recorded pane untouched; it is still present', uncertain: false },
    } as unknown as UpSeat;
    const steps = upPlan({ session: 'teamcli', root: '/tmp/fixture-root', seats: [kept] } as unknown as UpInput);
    const relabel = steps.find((step) => step.do?.do === 'relabel');
    expect(relabel?.kind).toBe('run');
    if (relabel?.kind === 'run' && relabel.do?.do === 'relabel') {
      expect(relabel.do.displayAgent).toBe('Claude Opus 5.5 default');
      expect(relabel.do.differs).toContain('the file declares Claude Fable 5.2 default');
      expect(relabel.note).toContain('its pane shows Claude Opus 5.5 default');
    }
  });

  test('without a live line the repaint keeps the file line', () => {
    const kept = {
      name: 'operator', cli: 'codex', launch: 'codex', cwd: '.', label: 'Triton · operator', displayAgent: 'GPT Sol 6.1 default',
      model: 'GPT Sol', version: '6.1', repairLine: 'team up', stage: 'ready', pane: 'w1Y:p1', workspace: 'w1Y',
      restoreKeep: { reason: 'restore left the recorded pane untouched; it is still present', uncertain: false },
    } as unknown as UpSeat;
    const steps = upPlan({ session: 'material', root: '/tmp/fixture-root', seats: [kept] } as unknown as UpInput);
    const relabel = steps.find((step) => step.do?.do === 'relabel');
    if (relabel?.kind === 'run' && relabel.do?.do === 'relabel') {
      expect(relabel.do.displayAgent).toBe('GPT Sol 6.1 default');
      expect(relabel.do.differs).toBeUndefined();
    } else {
      throw new Error('no relabel step was planned');
    }
  });
});

describe('a Grok launch carries a session id it can resume', () => {
  test('a plain Grok line gets a minted --session-id, read back as the launch id', () => {
    const launch = withLaunchSession('grok', 'grok -m grok-4.7 --trust');
    expect(launch.command).toMatch(/^grok -m grok-4\.7 --trust --session-id [0-9a-f-]{36}$/);
    expect(launch.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(launchSessionId(launch.command)).toBe(launch.sessionId);
  });

  test('a wrapper that forwards its arguments takes the id after them', () => {
    const launch = withLaunchSession('grok', 'AGENT_UNATTENDED=1 zsh ~/tools/as-floor.sh grok -m grok-4.7');
    expect(launch.sessionId).toBeDefined();
    expect(launch.command.endsWith(` --session-id ${launch.sessionId!}`)).toBe(true);
  });

  test('a Grok line that resumes or names a session is left alone; its -c is not a selection', () => {
    for (const command of ['grok -r 1f2e3d4c', 'grok --resume 1f2e3d4c']) {
      expect(withLaunchSession('grok', command)).toEqual({ command });
    }
    const named = withLaunchSession('grok', 'grok --session-id 0b8f2a3e-1111-4222-8333-944455556666');
    expect(named.sessionId).toBe('0b8f2a3e-1111-4222-8333-944455556666');
    expect(named.command).toBe('grok --session-id 0b8f2a3e-1111-4222-8333-944455556666');
  });

  test('the minted id is what a relaunch resumes with -r', () => {
    const launch = withLaunchSession('grok', 'grok -m grok-4.7');
    expect(withResume('grok', 'grok -m grok-4.7', launch.sessionId!)).toBe(`grok -m grok-4.7 -r ${launch.sessionId!}`);
  });

  test('Codex and Antigravity still mint nothing', () => {
    expect(withLaunchSession('codex', 'codex -m gpt-6.1-sol')).toEqual({ command: 'codex -m gpt-6.1-sol' });
    expect(withLaunchSession('antigravity', 'agy')).toEqual({ command: 'agy' });
  });
});
