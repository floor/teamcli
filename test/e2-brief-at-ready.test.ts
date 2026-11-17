// RFC event-comms E2: a launch brief whose walk took no leg is offered once more when its seat is
// ready, bound to the seat's current claim. Stale or superseded deliveries are refused, a read
// brief and a delivered brief are left alone, a seat not ready is left alone, and a failed offer
// leaves the brief to the unread sweep (it marks nothing). The walk, the claim read and the receipt
// read are scripted; no CLI runs.
import { describe, expect, test } from 'bun:test';
import { offerBriefsAtReady } from '../src/launch/brief-at-ready.ts';
import type { BriefDeliveryReport, BriefWalkPlan, CurrentBriefClaim } from '../src/launch/general-brief.ts';

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
const base = { dir: '/fixture/.agents', root: '/fixture', session: 'fixture', home: '/fixture-home' };

function walker(ok: boolean): { walk: (r: BriefDeliveryReport) => Promise<BriefDeliveryReport>; calls: BriefDeliveryReport[] } {
  const calls: BriefDeliveryReport[] = [];
  return {
    calls,
    walk: async (r) => {
      calls.push(r);
      const one = r.deliveries[0]!;
      return {
        deliveries: [ok
          ? { ...(one as Extract<typeof one, { ok: true }>), message: { via: 'channel', walked: true, exit: 0, failures: [], text: '' } }
          : { seat: one.seat, ok: false, reason: 'no leg took it' }],
      };
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
    expect(w.calls[0]!.deliveries[0]).toMatchObject({ seat: 'op', ok: true, id: 'brief-1', epoch: 'ep-1' });
    expect(notes).toEqual([{ seat: 'op', offered: true, said: 'op: the launch brief was offered at ready (channel)' }]);
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

  test('no report (a --no-launch run) offers nothing', async () => {
    expect(await offerBriefsAtReady({ ...base, report: undefined, ready: new Set(['op']) })).toEqual([]);
  });
});
