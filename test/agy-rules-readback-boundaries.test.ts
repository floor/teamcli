// The clearing key is sent for one case only: a line this run typed, sitting unsent,
// on an idle CLI that is still the pane's foreground. The builder's rows pin the
// outcomes when the key goes out — cleared, not delivered, stayed — and the foreign
// and resumed boxes it leaves alone. These are the guards around the send: a CLI no
// longer in the foreground, a mid-turn status, and a dialog each keep the key unsent,
// and a CLI resting at done still gets it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deliverRules, type Delivery, type Refusal } from '../src/launch/deliver.ts';
import { rulesLine } from '../src/launch/rules-file.ts';

const CAPTURED_PATH = '/home/owner/.config/team/demo-3f9c2a8e1d7b/rules/implementer.md';
const capturedLine = rulesLine(CAPTURED_PATH, '5e1d0a9c4b2f');

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/antigravity/1.3.5/${name}.txt`, import.meta.url), 'utf8');
}

/** The captured idle frame once `text` sits in the box, drawn as the 1.3.5 capture draws it. */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('\n>\n', `\n${body}\n`);
}

function delivery() {
  let raw = fixture('idle');
  let status = 'idle';
  let clock = 0;
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const keys: string[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true,
    type(text) { calls.push(text); return true; },
    enter() { calls.push('Enter'); raw = fixture('working'); status = 'working'; return true; },
    key(name) { keys.push(name); return true; },
    foreground: () => ['agy'],
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return {
    io, calls, refusals, keys,
    show: (name: string) => { raw = fixture(name); },
    showText: (screen: string) => { raw = screen; },
    setStatus: (value: string) => { status = value; },
    setForeground: (names: string[]) => { io.foreground = () => names; },
  };
}

// The read-back fails the same way in every row: the box shows the captured line with
// its hash one character off, so the stop is a read-back stop and the guard alone
// decides whether the key goes out.
function mismatched(d: ReturnType<typeof delivery>): void {
  d.io.type = (text) => {
    d.calls.push(text);
    d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
    return true;
  };
  d.io.key = (name) => {
    d.keys.push(name);
    d.show('idle');
    return true;
  };
}

describe('the clearing key goes out for one case only', () => {
  test('a CLI that drops from the foreground keeps the key unsent', async () => {
    const d = delivery();
    mismatched(d);
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
      d.setForeground(['zsh']);
      return true;
    };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    expect(d.keys).toEqual([]);
    expect(d.refusals.at(-1)?.cleared).toBeUndefined();
  });

  test('a mid-turn status keeps the key unsent', async () => {
    const d = delivery();
    mismatched(d);
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
      d.setStatus('working');
      return true;
    };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    expect(d.keys).toEqual([]);
    expect(d.refusals.at(-1)?.cleared).toBeUndefined();
  });

  test('a dialog in place of the box keeps the key unsent', async () => {
    const d = delivery();
    d.io.type = (text) => {
      d.calls.push(text);
      d.show('question');
      return true;
    };
    d.io.key = (name) => { d.keys.push(name); d.show('idle'); return true; };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    expect(d.keys).toEqual([]);
  });

  test('a CLI resting at done still gets the key', async () => {
    const d = delivery();
    mismatched(d);
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(fixture('rules-line').replace('5e1d0a9c4b2f', '5e1d0a9c4b2e'));
      d.setStatus('done');
      return true;
    };
    expect(await deliverRules('antigravity', capturedLine, 1, d.io)).toBe(false);
    expect(d.calls).toEqual([capturedLine]);
    expect(d.keys).toEqual(['ctrl+u']);
    expect(d.refusals.at(-1)?.cleared).toBe('yes');
  });
});
