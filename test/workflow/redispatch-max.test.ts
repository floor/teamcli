// Past redispatch-max the run goes failed. The lead's word authorizes one further redispatch
// and is audited. An authority step keeps its refusal. The store writes the decision, and a
// repeated ask at the same instant does not write it again.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRunStore, type RunStore } from '../../src/workflow/live/index.ts';
import {
  REDISPATCH_MAX,
  authorityConfirmation,
  redispatchCheck,
  type LeadWord,
} from '../../src/workflow/redispatch.ts';
import { createRunFor } from './reservation-live-fixture.ts';

const ITEM = { source: 'file' as const, project: 'acme', team: 'crew', id: 'm1' };
const WORD: LeadWord = { by: 'lead', at: '2026-11-03T18:00:00.000Z', reason: 'rerun the failed build' };

let base = '';

afterEach(() => {
  if (base !== '') rmSync(base, { recursive: true, force: true });
  base = '';
});

function store(): { store: RunStore; run: string } {
  base = mkdtempSync(join(tmpdir(), 'redispatch-max-'));
  const opened = openRunStore({ root: join(base, 'runs'), now: () => Date.parse('2026-11-03T18:00:00.000Z') });
  return { store: opened, run: createRunFor(opened, ITEM) };
}

describe('the redispatch-max check', () => {
  test('two redispatches pass, and the third goes failed', () => {
    expect(REDISPATCH_MAX).toBe(2);
    expect(redispatchCheck({ taken: 0, authority: false }).action).toBe('redispatch');
    expect(redispatchCheck({ taken: 1, authority: false }).action).toBe('redispatch');
    expect(redispatchCheck({ taken: 2, authority: false })).toEqual({
      action: 'step-failed',
      why: 'past redispatch-max (2)',
    });
  });

  test('the lead\'s word authorizes one rerun past the max, and another actor does not', () => {
    expect(redispatchCheck({ taken: 2, authority: false, lead: WORD })).toEqual({
      action: 'redispatch',
      audit: WORD,
    });
    expect(redispatchCheck({ taken: 2, authority: false, lead: { ...WORD, by: 'owner' } }).action).toBe('step-failed');
    expect(redispatchCheck({ taken: 2, authority: false, lead: { ...WORD, reason: '  ' } }).action).toBe('step-failed');
    expect(redispatchCheck({ taken: 2, authority: false, lead: { ...WORD, at: 'Tuesday' } }).action).toBe('step-failed');
  });

  test('an authority step keeps its refusal, lead word or not', () => {
    expect(authorityConfirmation('none')).toBe(false);
    expect(authorityConfirmation('owner')).toBe(true);
    expect(authorityConfirmation('grant')).toBe(true);
    expect(redispatchCheck({ taken: 0, authority: true, lead: WORD })).toEqual({
      action: 'refused',
      why: 'an authority step keeps its refusal',
    });
  });
});

describe('the store records the check', () => {
  test('the third redispatch is a refusal until the lead\'s word, which is audited once', () => {
    const scene = store();
    const ask = (at: string, lead?: LeadWord) => scene.store.transact((tx) => tx.requestRedispatch(scene.run, {
      stage: 'building',
      at,
      authority: false,
      ...(lead !== undefined ? { lead } : {}),
    }));

    expect(ask('2026-11-03T18:01:00.000Z').action).toBe('redispatch');
    expect(ask('2026-11-03T18:02:00.000Z').action).toBe('redispatch');
    const failed = ask('2026-11-03T18:03:00.000Z');
    expect(failed).toMatchObject({ action: 'step-failed', why: 'past redispatch-max (2)' });

    const rerun = ask('2026-11-03T18:04:00.000Z', WORD);
    expect(rerun.action).toBe('redispatch');
    if (rerun.action !== 'redispatch') return;
    expect(rerun.decisions.map((decision) => decision.decision)).toEqual(['lead-override', 'redispatch']);
    expect(rerun.decisions[0]?.detail).toEqual({ by: 'lead', at: WORD.at, reason: WORD.reason });

    const again = ask('2026-11-03T18:04:00.000Z', WORD);
    expect(again.action).toBe('redispatch');
    const spent = ask('2026-11-03T18:05:00.000Z', WORD);
    expect(spent).toMatchObject({ action: 'step-failed', why: 'past redispatch-max (2)' });

    const live = scene.store.liveState(scene.run);
    const kinds = live.decisions.map((decision) => decision.decision);
    expect(kinds).toEqual(['redispatch', 'redispatch', 'refusal', 'lead-override', 'redispatch', 'refusal']);
  });

  test('an authority step records the refusal and no redispatch', () => {
    const scene = store();
    const result = scene.store.transact((tx) => tx.requestRedispatch(scene.run, {
      stage: 'publishing',
      at: '2026-11-03T18:06:00.000Z',
      authority: true,
      lead: WORD,
    }));
    expect(result).toMatchObject({ action: 'refused', why: 'an authority step keeps its refusal' });
    expect(scene.store.liveState(scene.run).decisions.map((decision) => decision.decision)).toEqual(['refusal']);
  });

  test('another stage keeps its own count', () => {
    const scene = store();
    const building = (at: string) => scene.store.transact((tx) => tx.requestRedispatch(scene.run, {
      stage: 'building', at, authority: false,
    }));
    building('2026-11-03T18:01:00.000Z');
    building('2026-11-03T18:02:00.000Z');
    const testing = scene.store.transact((tx) => tx.requestRedispatch(scene.run, {
      stage: 'testing',
      at: '2026-11-03T18:03:00.000Z',
      authority: false,
    }));
    expect(testing.action).toBe('redispatch');
  });
});
