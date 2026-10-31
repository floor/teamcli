// The delivery classes: each shipped profile's measured word, the launch refinement that turns
// it into what a seat actually has, and the plain words a console prints. The refinement is
// pinned case by case because dispatch and `up` now refuse or warn on it: a seat read as
// wakeable when it is not would spend an attempt on a message nothing delivers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declaredDeliveryClass,
  deliveryWords,
  effectiveDeliveryClass,
  seatDeliveryClass,
  wakeableWhileIdle,
  type DeliveryFacts,
} from '../src/launch/delivery-class.ts';
import { DELIVERY_CLASSES, profileFor } from '../src/profiles/profile.ts';

const FACTS: DeliveryFacts = {
  declared: 'push',
  watcher: 'hook',
  channel: false,
  socket: false,
  endpoint: false,
};

const CLASS_OF = (over: Partial<DeliveryFacts>): string =>
  effectiveDeliveryClass({ ...FACTS, ...over });

const BINDING = 'prs_0123456789ab';

describe('the shipped profiles', () => {
  test('every CLI declares one measured class, and the table is the measurement', () => {
    const measured: Record<string, string> = {
      'claude-code': 'push',
      codex: 'between-turns',
      cursor: 'pull-on-turn',
      gemini: 'pull-on-turn',
      grok: 'pull-on-turn',
      antigravity: 'none',
      muse: 'none',
      jules: 'none',
    };
    for (const [cli, cls] of Object.entries(measured)) {
      const profile = profileFor(cli);
      expect(profile).not.toBeNull();
      expect(`${cli} ${profile!.delivery}`).toBe(`${cli} ${cls}`);
      expect((DELIVERY_CLASSES as readonly string[]).includes(profile!.delivery)).toBe(true);
    }
  });

  test('a CLI with no shipped profile declares none', () => {
    expect(declaredDeliveryClass('no-such-cli')).toBe('none');
  });
});

describe('the launch refines the declared class', () => {
  test('an event adapter makes the seat push, whichever one the launch installed', () => {
    expect(CLASS_OF({ channel: true })).toBe('push');
    expect(CLASS_OF({ socket: true })).toBe('push');
    expect(CLASS_OF({ channel: true, watcher: 'none' })).toBe('push');
  });

  test('a push seat whose launch turned no adapter on falls to its watcher', () => {
    expect(CLASS_OF({})).toBe('pull-on-turn');
    expect(CLASS_OF({ watcher: 'none' })).toBe('none');
  });

  test('a runtime queue between turns needs its managed endpoint', () => {
    expect(CLASS_OF({ declared: 'between-turns', watcher: 'inbox', endpoint: true })).toBe('between-turns');
    expect(CLASS_OF({ declared: 'between-turns', watcher: 'inbox' })).toBe('pull-on-turn');
    expect(CLASS_OF({ declared: 'between-turns', watcher: 'none' })).toBe('none');
  });

  test('an inbox read on a turn is pull-only, and nothing at all is none', () => {
    expect(CLASS_OF({ declared: 'pull-on-turn', watcher: 'inbox' })).toBe('pull-on-turn');
    expect(CLASS_OF({ declared: 'pull-on-turn', watcher: 'none' })).toBe('none');
    expect(CLASS_OF({ declared: 'none', watcher: 'none' })).toBe('none');
  });

  test('a person’s pane is never woken, whatever its launch carries', () => {
    expect(CLASS_OF({ human: true, channel: true })).toBe('none');
    expect(CLASS_OF({ human: true, endpoint: true })).toBe('none');
  });

  test('only push and between-turns reach an idle seat', () => {
    expect(wakeableWhileIdle('push')).toBe(true);
    expect(wakeableWhileIdle('between-turns')).toBe(true);
    expect(wakeableWhileIdle('pull-on-turn')).toBe(false);
    expect(wakeableWhileIdle('none')).toBe(false);
  });
});

describe('the plain words', () => {
  test('each class says what happens next, never a bare unconfirmed', () => {
    expect(deliveryWords('push', 'helper')).toBe('woken through its event adapter');
    expect(deliveryWords('between-turns', 'helper')).toBe('woken through its runtime queue');
    expect(deliveryWords('pull-on-turn', 'helper')).toBe('queued; helper reads it at its next turn (pull-only)');
    expect(deliveryWords('none', 'helper')).toBe('queued; helper has no way to be woken while idle');
  });
});

describe('a seat read from its records', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delivery-class-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (input: {
    seat?: string;
    declared?: { cli: string; launch: string; human?: true };
    state?: Parameters<typeof seatDeliveryClass>[0]['state'];
  }) => seatDeliveryClass({
    dir,
    root: dir,
    session: 'acme',
    seat: input.seat ?? 'helper',
    ...(input.declared === undefined ? {} : { declared: input.declared }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });

  test('a claude seat with its hook and no adapter is pull-on-turn, and says so', () => {
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(`${read_.class} ${read_.evidence.watcher} ${read_.evidence.watcherFrom}`)
      .toBe('pull-on-turn hook recorded');
    expect(read_.words).toBe('queued; helper reads it at its next turn (pull-only)');
    expect(read_.evidence.declared).toBe('push');
  });

  test('the development channel on the line makes the recorded seat push', () => {
    const read_ = read({
      declared: {
        cli: 'claude-code',
        launch: 'claude --dangerously-load-development-channels server:team-inbox',
      },
      state: {
        cli: 'claude-code',
        watcher: 'hook',
        launch_line: 'claude --dangerously-load-development-channels server:team-inbox',
      },
    });
    expect(read_.class).toBe('push');
    expect(read_.evidence.channel).toBe(true);
    expect(read_.words).toBe('woken through its event adapter');
  });

  test('an accepted cross-session socket makes the seat push without any channel', () => {
    mkdirSync(join(dir, 'hooks', 'acme'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'acme', 'helper.json'), '{"crossSessionInbound":"accept"}\n');
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(read_.evidence.socket).toBe(true);
    expect(read_.class).toBe('push');
  });

  test('a held socket is not evidence, and the seat stays pull-on-turn', () => {
    mkdirSync(join(dir, 'hooks', 'acme'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'acme', 'helper.json'), '{"crossSessionInbound":"hold"}\n');
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(read_.evidence.socket).toBe(false);
    expect(read_.class).toBe('pull-on-turn');
  });

  test('a codex seat reads between turns only while its endpoint is bound to its runtime', () => {
    const endpoint = {
      url: `unix://${join(dir, 'codex.sock')}`,
      binding: BINDING,
      pid: 4321,
      started_at: '2026-10-01T00:00:00Z',
    };
    const launched = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: { cli: 'codex', watcher: 'inbox', presence_binding: BINDING, codex_endpoint: endpoint },
    });
    expect(launched.class).toBe('between-turns');
    expect(launched.words).toBe('woken through its runtime queue');
    const rebound = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: { cli: 'codex', watcher: 'inbox', presence_binding: 'prs_ba9876543210', codex_endpoint: endpoint },
    });
    expect(rebound.evidence.endpoint).toBe(false);
    expect(rebound.class).toBe('pull-on-turn');
  });

  test('a codex seat with no endpoint falls to its inbox: pull-on-turn, never between-turns', () => {
    const read_ = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: { cli: 'codex', watcher: 'inbox' },
    });
    expect(read_.evidence.endpoint).toBe(false);
    expect(read_.class).toBe('pull-on-turn');
  });

  test('a launch line with no recorded watcher derives it, and a CLI with no inbox derives none', () => {
    const derived = read({
      declared: { cli: 'codex', launch: 'codex' },
    });
    expect(`${derived.evidence.watcherFrom} ${derived.evidence.watcher}`).toBe('derived inbox');
    const nothing = read({
      declared: { cli: 'muse', launch: 'muse --yolo' },
    });
    expect(`${nothing.evidence.watcherFrom} ${nothing.evidence.watcher}`).toBe('derived none');
    expect(nothing.class).toBe('none');
  });

  test('a CLI with no inbox or adapter is none, and a person’s pane is none', () => {
    const muse = read({
      declared: { cli: 'muse', launch: 'muse --yolo' },
      state: { cli: 'muse', watcher: 'none' },
    });
    expect(muse.class).toBe('none');
    expect(muse.words).toBe('queued; helper has no way to be woken while idle');
    const human = read({
      declared: { cli: 'claude-code', launch: 'claude', human: true },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(human.class).toBe('none');
    expect(human.evidence.human).toBe(true);
  });
});
