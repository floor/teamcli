// RFC event-comms E2: a launch brief whose walk took no leg is offered once more when its seat is
// ready, bound to the seat's current claim. Stale or superseded deliveries are refused, a read
// brief and a delivered brief are left alone, a seat not ready is left alone, and a failed offer
// leaves the brief to the unread sweep (it marks nothing). The walk, the claim read and the receipt
// read are scripted; no CLI runs.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendHost } from '../src/commands/send.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { TypedWakeHost } from '../src/send/typed-wake.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { offerBriefsAtReady, pointerWake, type ReadyWalk } from '../src/launch/brief-at-ready.ts';
import type { TeamFile } from '../src/file/types.ts';
import type { BriefDeliveryReport, BriefWalkPlan, CurrentBriefClaim } from '../src/launch/general-brief.ts';

const made: string[] = [];
afterEach(() => discardFixtures(made.splice(0)));

const CLAIM: CurrentBriefClaim = {
  id: 'brief-1', at: '2026-11-17T20:00:00.000Z', incarnation: 'inc-1', epoch: 'ep-1', sha256: 'sha-1', attempt: 1, stage: 'ready', superseded: [],
};
const plan = (seat: string, over: Record<string, unknown> = {}): BriefWalkPlan => ({
  seat,
  cli: 'codex',
  payload: { id: 'brief-1', incarnation: 'inc-1', brief_sha256: 'sha-1', ...over } as unknown as BriefWalkPlan['payload'],
});
const failed = (seat: string): BriefDeliveryReport['deliveries'][number] => ({
  seat, ok: false, reason: 'the signed record stands, but no delivery leg took the brief (no live route)',
  message: { via: null, walked: true, exit: 1, failures: ['no live route'], text: '' },
});
const base = { dir: '/fixture/.agents', root: '/fixture', session: 'fixture', home: '/fixture-home', team: {} as TeamFile };

/** A scripted ready walk. It records the plan it was given; the real walk is exercised by the
 *  integration test in test/antigravity-typed-wake.test.ts. */
function walker(ok: boolean): { walk: ReadyWalk; calls: BriefWalkPlan[] } {
  const calls: BriefWalkPlan[] = [];
  return {
    calls,
    walk: async (input) => {
      calls.push(input.plan);
      return ok ? { ok: true, via: 'typed' } : { ok: false, reason: 'no leg took it' };
    },
  };
}

describe('E2: the launch brief offered at ready', () => {
  test('a kept brief of a ready seat, bound to its current claim and unread, is walked once', async () => {
    const w = walker(true);
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [failed('op')], walks: [plan('op')] }, ready: new Set(['op']),
      claimOf: () => CLAIM, isRead: () => false, walk: w.walk,
    });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.seat).toBe('op');
    expect((w.calls[0]!.payload as { id?: string }).id).toBe('brief-1');
    expect(notes).toEqual([{ seat: 'op', offered: true, said: 'op: the launch brief was offered at ready (typed)' }]);
  });

  test('a seat that is not ready is left alone', async () => {
    const w = walker(true);
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [failed('op')], walks: [plan('op')] }, ready: new Set(),
      claimOf: () => CLAIM, isRead: () => false, walk: w.walk,
    });
    expect(w.calls).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  test('a stale epoch (the record is not the current claim) is refused and never walked', async () => {
    for (const over of [{ id: 'brief-0' }, { incarnation: 'inc-0' }, { brief_sha256: 'sha-0' }]) {
      const w = walker(true);
      const notes = await offerBriefsAtReady({
        ...base, report: { deliveries: [failed('op')], walks: [plan('op', over)] }, ready: new Set(['op']),
        claimOf: () => CLAIM, isRead: () => false, walk: w.walk,
      });
      expect(w.calls).toHaveLength(0);
      expect(notes[0]?.offered).toBe(false);
      expect(notes[0]?.said).toContain('not the seat\'s current claim');
    }
  });

  test('no current claim at all is refused', async () => {
    const w = walker(true);
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [failed('op')], walks: [plan('op')] }, ready: new Set(['op']),
      claimOf: () => null, isRead: () => false, walk: w.walk,
    });
    expect(w.calls).toHaveLength(0);
    expect(notes[0]?.offered).toBe(false);
  });

  test('an already read brief is not offered again', async () => {
    const w = walker(true);
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [failed('op')], walks: [plan('op')] }, ready: new Set(['op']),
      claimOf: () => CLAIM, isRead: () => true, walk: w.walk,
    });
    expect(w.calls).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  test('a brief the launch walk already delivered, or whose record never stood, is left alone', async () => {
    const w = walker(true);
    const delivered = { seat: 'op', ok: true as const, id: 'brief-1', at: CLAIM.at, incarnation: 'inc-1', epoch: 'ep-1' };
    const unwritten = { seat: 'op2', ok: false as const, reason: 'the record path is a folder', blocked: 'nonfile' as const };
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [delivered, unwritten], walks: [plan('op'), plan('op2')] }, ready: new Set(['op', 'op2']),
      claimOf: () => CLAIM, isRead: () => false, walk: w.walk,
    });
    expect(w.calls).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  test('an offer no leg takes leaves the brief to the unread sweep, and says so', async () => {
    const w = walker(false);
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [failed('op')], walks: [plan('op')] }, ready: new Set(['op']),
      claimOf: () => CLAIM, isRead: () => false, walk: w.walk,
    });
    expect(w.calls).toHaveLength(1);
    expect(notes[0]).toEqual({ seat: 'op', offered: false, said: 'op: the launch brief was not taken at ready (no leg took it); the unread sweep still offers it' });
  });

  test('a walk that throws is a refusal the sweep picks up, never a crash of the launch', async () => {
    const notes = await offerBriefsAtReady({
      ...base, report: { deliveries: [failed('op')], walks: [plan('op')] }, ready: new Set(['op']),
      claimOf: () => CLAIM, isRead: () => false, walk: async () => { throw new Error('herdr went away'); },
    });
    expect(notes[0]).toEqual({ seat: 'op', offered: false, said: 'op: the launch brief was not taken at ready (herdr went away); the unread sweep still offers it' });
  });

  test('no report (a --no-launch run) offers nothing', async () => {
    expect(await offerBriefsAtReady({ ...base, report: undefined, ready: new Set(['op']) })).toEqual([]);
  });
});

describe('E2: the default ready offer is a pointer, never the brief body', () => {
  const BODY = 'GENERAL BRIEF BODY: role, rules and first task';
  const IDLE = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.88', 'idle-hint-ansi.txt'), 'utf8');
  const WORKING = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8');

  function setup(seat: { name: string; cli: string; human?: boolean }, orchestrator = 'lead'): { dir: string; team: TeamFile } {
    const dir = mkdtempSync(join(tmpdir(), 'e2-pointer-'));
    made.push(dir);
    updateState(dir, (state) => {
      state.sessions.fixture = { ...(state.sessions.fixture ?? emptySession()) };
      state.sessions.fixture.seats[seat.name] = { stage: 'ready', pane: 'pane-1' } as never;
    });
    const team = { project: 'fixture', orchestrator, seats: [seat] } as unknown as TeamFile;
    return { dir, team };
  }

  function pane(screen: (prompted: number) => string): { host: TypedWakeHost; typed: string[]; prompts: string[]; native: number } {
    const typed: string[] = [];
    const prompts: string[] = [];
    const host: TypedWakeHost = {
      read: () => screen(prompts.length + typed.length),
      type: (_p, text) => { typed.push(text); return true; },
      enter: () => true,
      prompt: (_p, text) => { prompts.push(text); return true; },
      wait: async () => {},
    };
    return { host, typed, prompts, native: 0 };
  }

  const briefPlan = (seat: string, cli: string): BriefWalkPlan => ({
    seat, cli, payload: { id: 'brief-1', incarnation: 'inc-1', brief_sha256: 'sha-1', from: 'the launch', body: BODY } as unknown as BriefWalkPlan['payload'],
  });

  test('the pointer line goes through the seat\'s typed wake; the body never leaves', async () => {
    const { dir, team } = setup({ name: 'grok', cli: 'grok' });
    const p = pane((n) => (n > 0 ? WORKING : IDLE));
    const host = { typedWake: () => p.host } as unknown as SendHost;
    const out = await pointerWake({ dir, root: dir, session: 'fixture', home: dir, team, host, plan: briefPlan('grok', 'grok') });
    expect(out).toEqual({ ok: true, via: 'typed' });
    const sent = [...p.prompts, ...p.typed];
    expect(sent).toEqual(['Run team drops --read --seat grok --session fixture and do that.']);
    expect(sent.join('\n')).not.toContain(BODY);
  });

  test('a concurrent inbox read between the check and the wake still yields one body: the wake carries none', async () => {
    // The seat's own reader serves the brief while the offer runs (here: between the two idle
    // reads). The pointer then lands; whatever the seat reads next, the offer exposed no body.
    const { dir, team } = setup({ name: 'grok', cli: 'grok' });
    let served = 0;
    const p = pane((n) => {
      if (n === 0 && served === 0) served += 1; // the claim-bound reader served the body once
      return n > 0 ? WORKING : IDLE;
    });
    const host = { typedWake: () => p.host } as unknown as SendHost;
    const out = await pointerWake({ dir, root: dir, session: 'fixture', home: dir, team, host, plan: briefPlan('grok', 'grok') });
    expect(out.ok).toBe(true);
    expect(served).toBe(1);
    expect([...p.prompts, ...p.typed].join('\n')).not.toContain(BODY);
  });

  test('refusals type nothing: human seat, orchestrator, a CLI with no typed wake, no pane, a busy box', async () => {
    const cases: Array<{ seat: { name: string; cli: string; human?: boolean }; reason: string; noPane?: boolean; busy?: boolean }> = [
      { seat: { name: 'person', cli: 'grok', human: true }, reason: 'a human seat is never typed into' },
      { seat: { name: 'lead', cli: 'grok' }, reason: 'the orchestrator\'s pane is never typed into by a launch' },
      { seat: { name: 'claude', cli: 'claude-code' }, reason: 'claude-code has no typed wake; the brief waits for the seat\'s own inbox read' },
      { seat: { name: 'grok', cli: 'grok' }, reason: 'the seat records no pane', noPane: true },
      { seat: { name: 'grok', cli: 'grok' }, reason: '', busy: true },
    ];
    for (const one of cases) {
      const { dir, team } = setup(one.seat);
      if (one.noPane === true) updateState(dir, (state) => { delete (state.sessions.fixture!.seats[one.seat.name] as { pane?: string }).pane; });
      const p = pane(() => (one.busy === true ? WORKING : IDLE));
      const host = { typedWake: () => p.host } as unknown as SendHost;
      const out = await pointerWake({ dir, root: dir, session: 'fixture', home: dir, team, host, plan: briefPlan(one.seat.name, one.seat.cli) });
      expect(out.ok).toBe(false);
      if (one.reason !== '' && !out.ok) expect(out.reason).toBe(one.reason);
      expect([...p.prompts, ...p.typed]).toEqual([]);
    }
  });
});
