// Independent check of the Codex account-warning row under the status line
// (src/watch/screen.ts, src/launch/deliver.ts, src/send/typed-wake.ts).
// The pane, its keys and the clock are synthetic. No live host, CLI, or process signal is invoked.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'codex', '0.161.0');
const SCREEN = readFileSync(join(FIXTURES, 'warning-row.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working.txt'), 'utf8');

const rows = SCREEN.split('\n');
const last = [...rows].reverse().find((line) => line.trim() !== '');
if (last === undefined) throw new Error('the warning fixture has no row');
const WARNING = last.trim();
const prompt = [...rows].reverse().find((line) => line.startsWith('› '));
if (prompt === undefined) throw new Error('the warning fixture has no composer row');
const COMPOSER: string = prompt;
const LINE = COMPOSER.slice(2);
const EMPTY = '› Ask Codex to do anything';

const PANE = 'fixture-pane-one';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function replaced(row: string): string {
  return rows.map((line) => (line.trim() === WARNING ? row : line)).join('\n');
}

function idle(): string {
  return SCREEN.replace(COMPOSER, EMPTY);
}

type Wake = { host: TypedWakeHost; typed: string[]; keys: string[]; enters: () => number };

function wakeOf(screen: (read: number) => string): Wake {
  let reads = 0;
  let enters = 0;
  const typed: string[] = [];
  const keys: string[] = [];
  const host: TypedWakeHost = {
    read: () => screen(reads++),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
    key: (_pane, key) => {
      keys.push(key);
      return true;
    },
  };
  return { host, typed, keys, enters: () => enters };
}

function script(screens: readonly string[]): (read: number) => string {
  return (read) => screens[Math.min(read, screens.length - 1)] ?? '';
}

test('the reported line above the warning row reads unsent and the box holds that line', () => {
  expect(WARNING).toBe('⚠ 1 warning · f2 to view');
  expect(readScreen('codex', SCREEN).kind).toBe('unsent');
  expect(classifyComposer('codex', SCREEN.split('\n')).kind).toBe('unsent');
  expect(boxHoldsText('codex', LINE, SCREEN)).toBe(true);
  const plural = replaced(last.replace('1 warning', '2 warnings'));
  expect(readScreen('codex', plural).kind).toBe('unsent');
});

test('the empty prompt over the same bottom region reads idle', () => {
  const frame = idle();
  expect(readScreen('codex', frame).kind).toBe('idle');
  expect(classifyComposer('codex', frame.split('\n')).kind).toBe('idle');
});

test('a near miss, a later row, or the warning with no status row does not read the composer', () => {
  expect(readScreen('codex', replaced('⚠ 1 warning · f2 to close view')).kind).toBe('unknown');
  expect(readScreen('codex', replaced(`notice: ${WARNING}`)).kind).toBe('unknown');
  expect(readScreen('codex', `${SCREEN}• a later row\n`).kind).toBe('unknown');
  expect(readScreen('codex', `${SCREEN}\n\n\n`).kind).toBe('unsent');
  expect(readScreen('codex', `• a transcript row\n  ${WARNING}\n`).kind).toBe('unknown');
});

test('a warning row higher in the transcript is not the chrome row, and a quote leaves the reading', () => {
  const anchor = '• The changelog matches the notes; no other change is listed.';
  const higher = replaced('• a row the seat printed').replace(
    anchor,
    `${anchor}\n\n                                ${WARNING}`,
  );
  expect(higher).not.toBe(SCREEN);
  expect(readScreen('codex', higher).kind).toBe('unknown');
  const quoted = idle().replace(EMPTY, `• the pane printed ${WARNING}\n\n${EMPTY}`);
  expect(readScreen('codex', quoted).kind).toBe('idle');
});

test('the wake types the line once, presses one Enter, and presses no other key', async () => {
  const empty = idle();
  const wake = wakeOf(script([empty, empty, SCREEN, SCREEN, WORKING]));
  const out = await deliverTypedWake(wake.host, PANE, LINE, 'codex', FAST);
  expect(out).toMatchObject({ delivered: true, typed: true, tries: 1 });
  expect(out.reason).toContain('working screen showed after 1 Enter');
  expect(wake.typed).toEqual([LINE]);
  expect(wake.enters()).toBe(1);
  expect(wake.keys).toEqual([]);
});
