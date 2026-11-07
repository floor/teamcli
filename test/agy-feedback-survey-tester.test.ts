// Independent check of the Antigravity feedback survey skip (src/send/typed-wake.ts,
// src/watch/screen-core.ts). The pane is synthetic. The wake's key stays inside the
// host this file hands in.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const SURVEY = readFileSync(join(FIXTURES, 'feedback-survey.txt'), 'utf8');
const PERMISSION = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2', 'permission.txt'), 'utf8');
const TRUST = readFileSync(join(import.meta.dir, 'fixtures', 'antigravity', '1.4.2', 'trust.txt'), 'utf8');
const PROMPT = "  How's the CLI experience so far? Help us improve:";
const CHOICES = '  [1] Good  [2] Fine  [3] Bad  [0] Skip';
const LINE = 'fixture wake line';
const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function holding(text: string): string {
  return IDLE.replace(/\n>\n(─+)\n/, (_match, rule: string) => `\n> ${text}\n${rule}\n`);
}

function quoted(screen: string): string {
  return screen.replace('  ready\n', `  ready\n${PROMPT}\n${CHOICES}\n`);
}

function wake(screen: (read: number, keys: readonly string[]) => string | null): {
  host: TypedWakeHost;
  typed: string[];
  keys: string[];
  enters: number;
} {
  const typed: string[] = [];
  const prompts: string[] = [];
  const keys: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => screen(reads++, keys),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    prompt: (_pane, text) => {
      prompts.push(text);
      enters += 1;
      return true;
    },
    key: (_pane, key) => {
      keys.push(key);
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    keys,
    get enters() {
      return enters;
    },
  };
}

test('a survey at the bottom is skipped once, then two idle reads let the wake type', async () => {
  expect(readScreen('antigravity', SURVEY).kind).toBe('feedback survey');
  const screens = [SURVEY, IDLE, IDLE, WORKING];
  const pane = wake((read) => screens[Math.min(read, screens.length - 1)] ?? null);
  const out = await deliverTypedWake(pane.host, PANE, LINE, 'antigravity', FAST);
  expect(out).toMatchObject({ delivered: true, tries: 1, reason: 'the working screen showed after the agent prompt' });
  expect(pane.keys).toEqual(['0']);
  expect(pane.typed).toEqual([]);
  expect(pane.enters).toBe(1);
});

test('survey text quoted above a live composer is not skipped', async () => {
  const aboveIdle = quoted(IDLE);
  const aboveDraft = quoted(holding('fixture draft'));
  expect(readScreen('antigravity', aboveIdle).kind).toBe('idle');
  expect(readScreen('antigravity', aboveDraft).kind).toBe('unsent');

  const idlePane = wake(() => aboveIdle);
  await deliverTypedWake(idlePane.host, PANE, LINE, 'antigravity', FAST);
  expect(idlePane.keys).toEqual([]);

  const draftPane = wake(() => aboveDraft);
  const refused = await deliverTypedWake(draftPane.host, PANE, LINE, 'antigravity', FAST);
  expect(refused.delivered).toBe(false);
  expect(draftPane.keys).toEqual([]);
  expect(draftPane.typed).toEqual([]);
  expect(draftPane.enters).toBe(0);
});

test('a permission or trust dialog is never answered, even with the survey rows under it', async () => {
  for (const screen of [PERMISSION, `${PERMISSION}\n${PROMPT}\n${CHOICES}`, TRUST, `${TRUST}\n${PROMPT}\n${CHOICES}`]) {
    const kind = readScreen('antigravity', screen).kind;
    expect(kind === 'permission' || kind === 'trust').toBe(true);
    const pane = wake(() => screen);
    const out = await deliverTypedWake(pane.host, PANE, LINE, 'antigravity', FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.keys).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  }
});

test('a survey that stays after 0 gets no second key and no wake line', async () => {
  const stays = wake(() => SURVEY);
  const out = await deliverTypedWake(stays.host, PANE, LINE, 'antigravity', FAST);
  expect(out.delivered).toBe(false);
  expect(out.reason).toContain('after the skip key');
  expect(out.reason).toContain('no wake line was typed');
  expect(stays.keys).toEqual(['0']);
  expect(stays.typed).toEqual([]);
  expect(stays.enters).toBe(0);

  const second = wake((read) => (read === 0 ? SURVEY : read === 1 ? IDLE : SURVEY));
  const again = await deliverTypedWake(second.host, PANE, LINE, 'antigravity', FAST);
  expect(again.delivered).toBe(false);
  expect(again.reason).toContain('second idle read');
  expect(second.keys).toEqual(['0']);
  expect(second.typed).toEqual([]);
  expect(second.enters).toBe(0);
});

test('a survey under a working spinner is left alone, and another CLI has no survey handling', async () => {
  const under = `${WORKING}\n${PROMPT}\n${CHOICES}`;
  expect(readScreen('antigravity', under).kind).toBe('working');
  const spinning = wake(() => under);
  const refused = await deliverTypedWake(spinning.host, PANE, LINE, 'antigravity', FAST);
  expect(refused.delivered).toBe(false);
  expect(refused.typed).toBe(false);
  expect(refused.reason).toContain('working');
  expect(spinning.keys).toEqual([]);
  expect(spinning.typed).toEqual([]);

  expect(readScreen('cursor', SURVEY).kind).not.toBe('feedback survey');
  const other = wake(() => SURVEY);
  const cursor = await deliverTypedWake(other.host, PANE, LINE, 'cursor', FAST);
  expect(cursor.delivered).toBe(false);
  expect(cursor.typed).toBe(false);
  expect(other.keys).toEqual([]);
  expect(other.typed).toEqual([]);
  expect(other.enters).toBe(0);
});
