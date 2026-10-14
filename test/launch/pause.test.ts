// The pause, against a fake host: what it says, what it writes, and in which order it touches
// the world. Nothing here is a real terminal, session or pane.
import { describe, expect, test } from 'bun:test';
import type { HerdrAgent, HerdrWorkspace, PaneProcesses } from '../../src/herdr.ts';
import { launchedIdentity } from '../../src/launch/identity.ts';
import { IDLE_POLL_MS } from '../../src/launch/plan.ts';
import { runPause } from '../../src/launch/pause.ts';
import type { PauseHost, PauseInput, ScreenReading, WaitingRecord } from '../../src/launch/pause.ts';
import type { Key } from '../../src/launch/terminal.ts';
import type { SeatState } from '../../src/state.ts';

const agent = (pane: string, name: string | null = null, workspace?: string): HerdrAgent => ({
  name,
  agent: 'claude',
  pane,
  workspace: workspace ?? pane.split(':')[0] ?? '',
  status: 'idle',
  cwd: null,
});

type Fake = {
  calls: string[];
  host: PauseHost;
  state: { current: SeatState | undefined };
  keys: Key[];
  readings: ScreenReading[];
  agents: HerdrAgent[] | null;
  process: PaneProcesses | null;
  workspaces: HerdrWorkspace[] | null;
  seats: Record<string, SeatState> | null;
  panes: string[] | null;
  focused: boolean;
  closeResult: boolean;
  lockHeld: number | null;
};

function fake(over: Partial<Fake> = {}): Fake {
  const own: Fake = {
    calls: [],
    state: { current: undefined },
    keys: [],
    readings: ['idle'],
    agents: [agent('w2:p1')],
    process: { shell: 10, foreground: [11] },
    workspaces: [{ id: 'w2', label: 'claude opus 5.5' }],
    seats: null,
    panes: ['w2:p1'],
    focused: true,
    closeResult: true,
    lockHeld: null,
    ...over,
    host: undefined as unknown as PauseHost,
  };
  const waiting: WaitingRecord[] = [];
  own.host = {
    lock() {
      own.calls.push('lock');
      if (own.lockHeld !== null) return { held: own.lockHeld };
      return { release: () => own.calls.push('release') };
    },
    state() {
      own.calls.push('state');
      return own.state.current;
    },
    write(change) {
      const prior = own.state.current?.waiting;
      const written = change(prior);
      waiting.push(written);
      // As `up`'s host writes it: the identity read at this moment goes in the same write,
      // and a prior identity stands when this read cannot tell (`up.ts`, `pauseHostFor`).
      const identity = launchedIdentity(own.process);
      own.state.current = {
        ...(own.state.current ?? { stage: 'launched' }),
        waiting: written,
        pane: 'w2:p1',
        workspace: 'w2',
        ...(identity ? { launched: identity } : own.state.current?.launched ? { launched: own.state.current.launched } : {}),
      };
      own.calls.push(`write:${written.state}:${written.classification}${written.manual ? ':manual' : ''}`);
    },
    clear() {
      own.calls.push('clear');
      if (own.state.current) {
        const { waiting: _gone, ...rest } = own.state.current;
        own.state.current = rest as SeatState;
      }
    },
    drop() {
      own.calls.push('drop');
      own.state.current = undefined;
    },
    screen() {
      const kind = own.readings.length > 1 ? own.readings.shift()! : own.readings[0]!;
      own.calls.push(`screen:${kind}`);
      return kind;
    },
    process() {
      own.calls.push('process');
      return own.process;
    },
    agents() {
      own.calls.push('agents');
      return own.agents;
    },
    workspaces() {
      own.calls.push('workspaces');
      return own.workspaces;
    },
    seats() {
      own.calls.push('seats');
      if (own.seats !== null) return own.seats;
      return own.state.current ? { beta: own.state.current } : {};
    },
    workspacePanes(workspace) {
      own.calls.push(`panes:${workspace}`);
      return own.panes;
    },
    focus() {
      own.calls.push('focus');
      return own.focused;
    },
    close(workspace) {
      own.calls.push(`close:${workspace}`);
      return own.closeResult;
    },
    record(classification) {
      own.calls.push(`record:${classification}`);
    },
    prompt(line) {
      own.calls.push(`prompt:${line}`);
    },
    drain() {
      own.calls.push('drain');
    },
    say(line) {
      own.calls.push(`say:${line.trim()}`);
    },
    entering(classification) {
      own.calls.push(`entering:${classification}`);
    },
    async key(ms) {
      own.calls.push(`key:${Number.isFinite(ms) ? ms : 'block'}`);
      const next = own.keys.shift();
      if (next === undefined) throw new Error('the test ran out of keys');
      // A timeout is the wait elapsing, the same as the real reader: the clock moves by the
      // slice it was given. A key the owner presses does not.
      if (next === 'timeout') OWN_CLOCK.advance(ms);
      return next;
    },
    async sleep(ms) {
      own.calls.push(`sleep:${ms}`);
      OWN_CLOCK.advance(ms);
    },
    now: () => OWN_CLOCK.now(),
    idleTimeout: 4,
    polled: false,
  };
  return own;
}

const OWN_CLOCK = {
  at: 0,
  now() {
    return this.at;
  },
  advance(ms: number) {
    this.at += ms;
  },
  reset() {
    this.at = 0;
  },
};

function input(over: Partial<PauseInput> = {}): PauseInput {
  return {
    seat: 'beta',
    classification: 'trust',
    pane: 'w2:p1',
    workspace: 'w2',
    label: 'claude opus 5.5',
    repairLine: '`team remove beta --keep` then `team add beta` (or `team down` then `team up` for the whole team)',
    ...over,
  };
}

const PROMPT = 'beta is waiting at trust: [o] open pane, [s] skip seat, [q] stop cleanly';

describe('the prompt', () => {
  test('is the exact line, and an unknown key reprints it and changes nothing', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['other', 'other', 'q'] });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'stopped' });
    expect(f.calls.filter((call) => call.startsWith('prompt:'))).toEqual([`prompt:${PROMPT}`, `prompt:${PROMPT}`, `prompt:${PROMPT}`]);
    // One entry, one record; no lock, no write beyond the entry's, no close: nothing moved.
    expect(f.calls.filter((call) => call.startsWith('record:'))).toEqual(['record:trust']);
    expect(f.calls.filter((call) => call.startsWith('write:'))).toEqual(['write:waiting-owner:trust']);
    expect(f.calls).not.toContain('lock');
  });

  test('the entry: entering and the record come before the first prompt; the write is first of all', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['q'] });
    await runPause(input(), f.host);
    expect(f.calls.slice(0, 6)).toEqual(['write:waiting-owner:trust', 'entering:trust', 'record:trust', 'drain', `prompt:${PROMPT}`, 'key:4000']);
  });

  test('every prompt is preceded by a drain: type-ahead is never answered by the next prompt', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['other', 's'] });
    await runPause(input(), f.host);
    expect(f.calls.filter((call) => call === 'drain' || call.startsWith('prompt:'))).toEqual([
      'drain',
      `prompt:${PROMPT}`,
      'drain',
      `prompt:${PROMPT}`,
      'drain', // the drain on the way out
    ]);
  });

  test('the pause drains once more on the way out, whatever the key was', async () => {
    OWN_CLOCK.reset();
    const done = fake({ keys: ['q'] });
    await runPause(input(), done.host);
    expect(done.calls[done.calls.length - 1]).toBe('drain');

    OWN_CLOCK.reset();
    const opened = fake({ keys: ['o'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    await runPause(input(), opened.host);
    expect(opened.calls[opened.calls.length - 1]).toBe('drain');
  });

  test('without polling the key read waits out the idle timeout; with polling it reads one idle poll at a time', async () => {
    OWN_CLOCK.reset();
    const blocked = fake({ keys: ['q'] });
    await runPause(input(), blocked.host);
    expect(blocked.calls).toContain('key:4000');

    const polled = fake({ keys: ['q'] });
    polled.host.polled = true;
    await runPause(input(), polled.host);
    expect(polled.calls).toContain(`key:${IDLE_POLL_MS}`);
  });
});

describe('an unanswered prompt cannot hold the run', () => {
  const left = { kind: 'left out', reason: 'timed out after 4 s waiting for its owner; left as it is', detail: '' };

  test('a trust prompt with no key ends after the idle timeout, the seat left as it is', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['timeout'] });
    const result = await runPause(input(), f.host);
    expect(result).toEqual(left);
    expect(f.calls).toContain('key:4000');
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls).not.toContain('drop');
    expect(f.calls).not.toContain('clear');
    expect(f.state.current?.waiting?.state).toBe('waiting-owner');
    expect(f.calls[f.calls.length - 1]).toBe('drain');
  });

  test('a permission prompt is capped the same way', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['timeout'] });
    const result = await runPause(input({ classification: 'permission' }), f.host);
    expect(result).toEqual(left);
    expect(f.calls).toContain('prompt:beta is waiting at permission: [o] open pane, [s] skip seat, [q] stop cleanly');
  });

  test('a polled trust prompt ends once the ticks have spent the idle timeout', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['timeout', 'timeout', 'timeout'], readings: ['trust'] });
    f.host.polled = true;
    const result = await runPause(input(), f.host);
    expect(result).toEqual(left);
    expect(f.calls.filter((call) => call.startsWith('key:')).length).toBe(2);
    expect(f.calls.filter((call) => call.startsWith('prompt:')).length).toBe(2);
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('opening the pane starts a new ask, so the prompt after the poll still waits', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['o', 'timeout'],
      readings: ['working'],
      state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } },
    });
    const result = await runPause(input(), f.host);
    expect(result).toEqual(left);
    expect(f.calls).toContain('prompt:beta is waiting at timeout: [o] open pane, [s] skip seat, [q] stop cleanly');
    expect(f.calls.filter((call) => call === 'key:4000').length).toBe(2);
  });
});

describe('end of input is not q', () => {
  test('eof leaves the seat exactly as it is: nothing focused, nothing closed, the state and record kept', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['eof'] });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'left out', reason: 'its input ended; left as it is', detail: '' });
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls).not.toContain('drop');
    expect(f.calls).not.toContain('clear');
    expect(f.state.current?.waiting?.state).toBe('waiting-owner');
    expect(f.calls[f.calls.length - 1]).toBe('drain');
  });

  test('eof after another key: the seat is still only left out, never stopped', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['other', 'eof'] });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'left out', reason: 'its input ended; left as it is', detail: '' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });
});

describe('o, open the pane', () => {
  test('a fresh reading of idle: the record says manual, the pane is focused, and nothing is typed', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], readings: ['idle'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'idle' });
    const interesting = f.calls.filter((call) => !call.startsWith('prompt:') && !call.startsWith('sleep:'));
    expect(interesting).toEqual([
      'write:waiting-owner:trust',
      'entering:trust',
      'record:trust',
      'drain',
      'key:4000',
      'lock',
      'state',
      'seats',
      'agents',
      'workspaces',
      'process',
      'write:waiting-owner:trust:manual',
      'release',
      'focus',
      'lock',
      'state',
      'seats',
      'agents',
      'workspaces',
      'process',
      `screen:idle`,
      'clear',
      'release',
      'drain', // the drain on the way out
    ]);
    // No key or text was sent to the pane: the host has no such call, and focus is the only act.
    expect(f.calls.filter((call) => call === 'focus').length).toBe(1);
  });

  test('a seat made ready under it: no focus, a ready record', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], state: { current: { stage: 'ready', pane: 'w2:p1' } } });
    const result = await runPause(input(), f.host);
    expect(result.kind).toBe('ready');
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call === 'lock').length).toBe(1);
  });

  test('the pane is gone: fail closed, nothing focused, nothing closed, the state kept', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], agents: [] });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting pane is gone' });
    expect((result as { detail: string }).detail).toContain('team remove beta --keep');
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls.filter((call) => call.startsWith('write:')).length).toBe(1); // the entry's alone
  });

  test('the pane holds another process: fail closed, never closed, never typed into', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['o'],
      state: { current: { stage: 'launched', pane: 'w2:p1', launched: { shell: 99, cli: [98] } } },
      process: { shell: 10, foreground: [10] },
    });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting pane holds another process' });
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('a recorded seat herdr can no longer read: fail closed', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['o'],
      state: { current: { stage: 'launched', pane: 'w2:p1', launched: { shell: 10, cli: [11] } } },
      process: null,
    });
    expect(await runPause(input(), f.host)).toMatchObject({ kind: 'left out', reason: 'its waiting pane could not be read' });
  });

  test('the poll ends at the deadline with a timeout prompt, manual kept', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o', 'q'], readings: ['working'], state: { current: { stage: 'launched', pane: 'w2:p1' } } });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'stopped' });
    expect(f.calls).toContain('record:timeout');
    expect(f.calls).toContain(`prompt:beta is waiting at timeout: [o] open pane, [s] skip seat, [q] stop cleanly`);
    // Two polls, then the deadline.
    expect(f.calls.filter((call) => call === 'sleep:2000').length).toBe(2);
  });

  test('another dialog found in the pane prompts again at once, with that classification', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o', 'q'], readings: ['permission'], state: { current: { stage: 'launched', pane: 'w2:p1' } } });
    await runPause(input(), f.host);
    expect(f.calls).toContain('record:permission');
    expect(f.calls).toContain('prompt:beta is waiting at permission: [o] open pane, [s] skip seat, [q] stop cleanly');
  });

  test('a recovery left behind mid-poll is shown as such and offers the same keys', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['o', 'q'],
      readings: ['idle'],
      state: { current: { stage: 'launched', pane: 'w2:p1', launched: { shell: 10, cli: [11] }, waiting: { state: 'trust-sent-recovery', classification: 'trust' } } },
    });
    await runPause(input({ recorded: { state: 'trust-sent-recovery', classification: 'trust' } }), f.host);
    expect(f.calls).toContain('record:trust sent; recovery required');
  });

  test('a lock another command holds refuses the open gently, and the prompt asks again', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o', 'q'], lockHeld: 4242 });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'stopped' });
    expect(f.calls.some((call) => call.startsWith('say:beta: another command holds it'))).toBe(true);
    expect(f.calls).not.toContain('focus');
  });
});

describe('s, skip the seat', () => {
  test('closes the workspace without input, clears the state, and reports skipped', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'skipped' });
    expect(f.calls.filter((call) => !call.startsWith('prompt:') && !call.startsWith('say:'))).toEqual([
      'write:waiting-owner:trust',
      'entering:trust',
      'record:trust',
      'drain',
      'key:4000',
      'lock',
      'state',
      'seats',
      'agents',
      'workspaces',
      'process',
      'agents',
      'panes:w2',
      'process',
      'close:w2',
      'drop',
      'release',
      'drain', // the drain on the way out
    ]);
    expect(f.state.current).toBeUndefined();
  });

  test('a workspace that does not close keeps the state and never claims the skip', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['s'],
      closeResult: false,
      state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } },
    });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'trust; its workspace did not close; left as it is' });
    expect(f.calls).not.toContain('drop');
    expect(f.state.current?.waiting?.state).toBe('waiting-owner');
  });

  test('a pane that is no longer the seat is refused: nothing closed', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], agents: [], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    expect(await runPause(input(), f.host)).toMatchObject({ kind: 'left out', reason: 'its waiting pane is gone' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls).not.toContain('drop');
  });
});

describe('the waiting proof: the state is a hint, never an authority', () => {
  const refusal = (seat: string, what: string) =>
    `the state names one ${what} for two seats (beta and ${seat}); nothing renamed, nothing closed, the state as it was`;

  test('a record with no process identity is never opened: it names the repair', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], process: null });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting record has no process identity' });
    expect((result as { detail: string }).detail).toContain(
      'close that pane, then run `team remove beta --keep` then `team add beta` (or `team down` then `team up` for the whole team), to establish one by a run',
    );
    expect(f.calls).not.toContain('focus');
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('a record with no process identity is never skipped: nothing closed, the state kept', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], process: null });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting record has no process identity' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls).not.toContain('drop');
    expect(f.state.current?.waiting?.state).toBe('waiting-owner');
  });

  test('the repair printed is the seat\'s own: a lead seat hears only the whole-team sequence', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], process: null });
    const result = await runPause(
      input({ seat: 'claude-coordinator-acme', repairLine: '`team down` then `team up` (to restart the whole team)' }),
      f.host,
    );
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting record has no process identity' });
    expect((result as { detail: string }).detail).toContain('close that pane, then run `team down` then `team up` (to restart the whole team), to establish one by a run');
    expect((result as { detail: string }).detail).not.toContain('remove');
  });

  test('a record with no process identity whose pane carries its name asks for the dialog first', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], process: null, agents: [agent('w2:p1', 'beta')] });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting record has no process identity' });
    expect((result as { detail: string }).detail).toContain(
      'answer or close its dialog in its pane, then run `team remove beta --keep` then `team add beta` (or `team down` then `team up` for the whole team), to establish one by a run',
    );
  });

  test('(a) another seat recorded on the same pane refuses it: nothing renamed, nothing closed', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['o'],
      seats: {
        beta: { stage: 'launched', pane: 'w2:p1', workspace: 'w2', launched: { shell: 10, cli: [11] } },
        gamma: { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
      },
    });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: refusal('gamma', 'pane') });
    expect(f.calls).not.toContain('focus');
  });

  test('(a) another seat recorded on the same workspace alone refuses it too', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['s'],
      seats: {
        beta: { stage: 'launched', pane: 'w2:p1', workspace: 'w2', launched: { shell: 10, cli: [11] } },
        gamma: { stage: 'launched', pane: 'w7:p1', workspace: 'w2' },
      },
    });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: refusal('gamma', 'workspace') });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('(b) an agent named for another seat refuses it', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], agents: [agent('w2:p1', 'gamma')] });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({
      kind: 'left out',
      reason: 'the multiplexer names gamma in its pane, not beta; nothing renamed, nothing closed, the state as it was',
    });
    expect(f.calls).not.toContain('focus');
  });

  test('(b) an agent already carrying this seat\'s name is its own', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], agents: [agent('w2:p1', 'beta')], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    expect(await runPause(input(), f.host)).toEqual({ kind: 'idle' });
  });

  test('(c) a workspace labelled for another launch refuses it', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], workspaces: [{ id: 'w2', label: 'gpt sol 6' }] });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its workspace is labelled gpt sol 6, not claude opus 5.5; nothing renamed, nothing closed, the state as it was' });
    expect(f.calls).not.toContain('focus');
  });

  test('a pane the multiplexer put in another workspace refuses it', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'], agents: [agent('w2:p1', null, 'w9')] });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its pane is in workspace w9, not its recorded w2; nothing renamed, nothing closed, the state as it was' });
  });

  test('a seat record read that fails refuses it', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['o'] });
    f.host.seats = () => null;
    expect(await runPause(input(), f.host)).toMatchObject({ kind: 'left out', reason: "its session's seat records could not be read" });
  });
});

describe('the close: the workspace of the pane just verified', () => {
  test('s closes the live workspace of its own pane, never the stored one when they differ', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], state: { current: { stage: 'launched', pane: 'w2:p1' } } });
    // The record says w9; the multiplexer says the verified pane 'w2:p1' lives in w2.
    const result = await runPause(input({ workspace: 'w9' }), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its pane is in workspace w2, not its recorded w9; nothing renamed, nothing closed, the state as it was' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls).not.toContain('drop');
  });

  test('a workspace holding another agent pane is never closed', async () => {
    OWN_CLOCK.reset();
    const f = fake({
      keys: ['s'],
      agents: [agent('w2:p1'), agent('w2:p2')],
      panes: ['w2:p1', 'w2:p2'],
      state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } },
    });
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: "its workspace holds another seat's pane; nothing closed (close its pane there, then run team up)" });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('a workspace that does not hold the pane is never closed', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], panes: ['w2:p7'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    expect(await runPause(input(), f.host)).toMatchObject({ kind: 'left out', reason: 'its workspace does not hold its pane; nothing closed' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('a workspace whose panes cannot be read is never closed', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], panes: null, state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    expect(await runPause(input(), f.host)).toMatchObject({ kind: 'left out', reason: 'its workspace could not be read; nothing closed' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('a process replaced between the proof and the close is refused at the close', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    // The proof reads it once (same); the close's own read, directly before it, sees another.
    let reads = 0;
    f.host.process = () => {
      reads += 1;
      f.calls.push('process');
      return reads === 1 ? { shell: 10, foreground: [11] } : { shell: 10, foreground: [98] };
    };
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'left as it is: its process changed' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });

  test('a pane moved to another workspace between the proof and the close is refused at the close', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['s'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } } });
    let reads = 0;
    f.host.agents = () => {
      reads += 1;
      f.calls.push('agents');
      return [reads === 1 ? agent('w2:p1', null, 'w2') : agent('w2:p1', null, 'w9')];
    };
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its pane is in workspace w9, not its recorded w2; nothing closed, the state as it was' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });
});

describe('q and Ctrl-C', () => {
  test('stop cleanly: no close here, the caller owns what this run created', async () => {
    OWN_CLOCK.reset();
    const f = fake({ keys: ['q'] });
    expect(await runPause(input(), f.host)).toEqual({ kind: 'stopped' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
    expect(f.calls).not.toContain('drop');
  });
});

describe('the recovery record', () => {
  test('is kept exactly as the answer left it: no entry write, shown, and the keys still work', async () => {
    OWN_CLOCK.reset();
    const recorded = { state: 'trust-sent-recovery' as const, classification: 'trust' as const, sentAt: '2026-10-05T00:00:00.000Z' };
    const f = fake({ keys: ['s'], state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2', launched: { shell: 10, cli: [11] }, waiting: recorded } } });
    const result = await runPause(input({ recorded }), f.host);
    expect(result).toEqual({ kind: 'skipped' });
    expect(f.calls.filter((call) => call.startsWith('write:')).length).toBe(0);
    expect(f.calls).toContain('record:trust sent; recovery required');
    expect(f.calls[0]).toBe('entering:trust');
  });

  test('the o path keeps it a recovery: manual is added, the state is never rewritten', async () => {
    OWN_CLOCK.reset();
    const recorded = { state: 'trust-sent-recovery' as const, classification: 'trust' as const };
    const f = fake({
      keys: ['o', 'q'],
      readings: ['trust'],
      state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2', launched: { shell: 10, cli: [11] }, waiting: recorded } },
    });
    await runPause(input({ recorded }), f.host);
    expect(f.calls).toContain('write:trust-sent-recovery:trust:manual');
    expect(f.calls).toContain('focus');
  });
});

describe('the polled prompt (coordinator policy)', () => {
  function polled(): Fake {
    const f = fake({
      keys: ['timeout', 'q'],
      readings: ['idle'],
      state: { current: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } },
    });
    f.host.polled = true;
    return f;
  }

  test('a timeout with an unchanged state re-prompts from the fresh reading', async () => {
    OWN_CLOCK.reset();
    const f = polled();
    f.readings = ['working'];
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'stopped' });
    expect(f.calls.filter((call) => call === 'lock').length).toBe(1);
    expect(f.calls).toContain('screen:working');
    expect(f.calls.filter((call) => call.startsWith('prompt:')).length).toBe(2);
  });

  test('a seat that became ready is taken as ready, no prompt again', async () => {
    OWN_CLOCK.reset();
    const f = polled();
    f.state.current = { stage: 'ready', pane: 'w2:p1' };
    const result = await runPause(input(), f.host);
    expect(result.kind).toBe('ready');
    expect(f.calls.filter((call) => call.startsWith('prompt:')).length).toBe(1);
  });

  test('a recovery read at the tick is shown with the same keys', async () => {
    OWN_CLOCK.reset();
    const f = polled();
    const recorded = { state: 'trust-sent-recovery' as const, classification: 'trust' as const };
    f.state.current = { stage: 'launched', pane: 'w2:p1', launched: { shell: 10, cli: [11] }, waiting: recorded };
    const result = await runPause(input({ recorded }), f.host);
    expect(result).toEqual({ kind: 'stopped' });
    expect(f.calls).toContain('record:trust sent; recovery required');
    expect(f.calls).toContain('prompt:beta is waiting at trust sent; recovery required: [o] open pane, [s] skip seat, [q] stop cleanly');
    expect(f.calls.filter((call) => call.startsWith('write:')).length).toBe(0); // the recovery is kept as is
  });

  test('a fresh dialog reading becomes the prompt', async () => {
    OWN_CLOCK.reset();
    const f = polled();
    f.readings = ['permission'];
    await runPause(input(), f.host);
    expect(f.calls).toContain('record:permission');
  });

  test('an idle pane finishes the seat: the waiting field is cleared', async () => {
    OWN_CLOCK.reset();
    const f = polled();
    const result = await runPause(input(), f.host);
    expect(result).toEqual({ kind: 'idle' });
    expect(f.calls).toContain('clear');
  });

  test('a pane gone under the prompt is refused, nothing closed', async () => {
    OWN_CLOCK.reset();
    const f = polled();
    f.agents = [];
    const result = await runPause(input(), f.host);
    expect(result).toMatchObject({ kind: 'left out', reason: 'its waiting pane is gone' });
    expect(f.calls.filter((call) => call.startsWith('close:')).length).toBe(0);
  });
});
