// `seat.dialog.answer` at load. The watchdog does not answer a dialog; these scenes are
// the catalogue it refuses a restart against. No pane, no CLI, no credential folder.
import { describe, expect, test } from 'bun:test';
import { loadDialogAnswer } from '../src/policy/dialog-answer.ts';
import { getPolicySpec, parseDialogAnswer } from '../src/policy/types.ts';

const now = new Date('2026-11-04T08:00:00.000Z');
const roots = ['/work/acme'];
const fresh = new Date(now.getTime() - 1_000).toISOString();

describe('seat.dialog.answer', () => {
  test('the release default answers nothing', () => {
    const loaded = loadDialogAnswer({ now, roots, levels: {} });
    expect(loaded).toEqual({ ok: true, answer: { trust: [], permission: [], login: 'never' } });
    expect(getPolicySpec('seat.dialog.answer')?.defaultValue).toEqual([]);
  });

  test('a trust folder outside the entity roots is refused', () => {
    const loaded = loadDialogAnswer({
      now,
      roots,
      levels: { team: { value: ['trust:/other'] } },
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.why).toContain('outside the entity\'s roots');
  });

  test('a team may drop an entity trust scope', () => {
    const loaded = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/acme', 'trust:/work/acme/lib'] },
        team: { value: ['trust:/work/acme'] },
      },
    });
    expect(loaded).toEqual({ ok: true, answer: { trust: ['/work/acme'], permission: [], login: 'never' } });
  });

  test('login set to anything but never is refused', () => {
    expect(parseDialogAnswer(['login:always'])).toBeNull();
    const loaded = loadDialogAnswer({
      now,
      roots,
      levels: { entity: { value: ['login:always'] } },
    });
    expect(loaded.ok).toBe(false);
  });

  test('a loosening without a fresh owner proof is refused, and a tightening loads', () => {
    const loosened = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/acme'] },
        team: { value: ['trust:/work/acme', 'permission:rerun-failed'] },
      },
    });
    expect(loosened.ok).toBe(false);
    const tightened = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/acme', 'permission:rerun-failed', 'permission:deploy'] },
        team: { value: ['permission:rerun-failed'] },
      },
    });
    expect(tightened).toEqual({
      ok: true,
      answer: { trust: [], permission: ['rerun-failed'], login: 'never' },
    });
  });

  test('a loosening with a fresh owner proof loads, and a stale proof does not', () => {
    const proved = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/acme'] },
        team: { value: ['trust:/work/acme', 'permission:deploy'], proofAt: fresh },
      },
    });
    expect(proved.ok).toBe(true);
    const stale = loadDialogAnswer({
      now,
      roots,
      levels: {
        entity: { value: ['trust:/work/acme'] },
        team: {
          value: ['trust:/work/acme', 'permission:deploy'],
          proofAt: new Date(now.getTime() - 60_000).toISOString(),
        },
      },
    });
    expect(stale.ok).toBe(false);
  });
});
