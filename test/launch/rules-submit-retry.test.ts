// Independent coverage for the bounded submit retry in `team up`'s rules delivery: when the
// one Enter the delivery pressed did not take, and the seat still shows exactly the line this
// run typed in its composer, the delivery may press Enter again — a bounded number of attempts
// (the contract's proposed ceiling: three Enter attempts in all) — and only while the same live,
// verified CLI holds that exact text, the seat is free, and no classified dialog stands in the
// way. A retry that never takes stays a refusal: no attempt is ever reported as a delivery, and
// a box that did not read back as the line never gets a retry Enter at all.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deliverRules, refusalReport, type Delivery, type Refusal } from '../../src/launch/deliver.ts';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

const LINE = 'Read rules/implementer.md (sha256 5e1d0a).';

/** The captured idle frame once `text` sits in the box (see test/launch/codex.test.ts). */
function boxed(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const body = [`› ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return fixture('idle').replace('› Ask Codex to do anything', body);
}

/** A delivery whose first Enter is swallowed by default: the key is recorded, the screen keeps
 *  the boxed line, and the seat stays idle. A scene overrides `io.enter` to change any of that. */
function delivery() {
  let raw = fixture('idle');
  let status = 'idle';
  let clock = 0;
  let foreground = ['codex'];
  const calls: string[] = [];
  const refusals: Refusal[] = [];
  const io: Delivery = {
    screen: () => raw,
    status: () => status,
    report: (why) => { refusals.push(why); },
    file: () => true, // the delivery scenes prove the submit, not the file
    type(text) { calls.push(text); raw = boxed(text); return true; },
    // The first Enter is swallowed: nothing about the screen or the status changes.
    enter() { calls.push('Enter'); return true; },
    foreground: () => foreground,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  };
  return {
    io, calls, refusals,
    show: (name: string) => { raw = fixture(name); },
    showText: (screen: string) => { raw = screen; },
    setStatus: (value: string) => { status = value; },
    setForeground: (names: string[]) => { foreground = names; },
    accept: () => { raw = fixture('working'); status = 'working'; },
    boxed,
  };
}

/** How many Enters the delivery pressed. */
const enters = (calls: readonly string[]) => calls.filter((call) => call === 'Enter').length;

describe('team up rules delivery retries a submit that did not take', () => {
  test('no pane messaging, rules are never typed; was: the retry submits and the matching read-back is observed', async () => {
    const d = delivery();
    let pressed = 0;
    d.io.enter = () => {
      d.calls.push('Enter');
      pressed += 1;
      if (pressed === 2) d.accept();
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: the third attempt can still submit after two swallowed Enters', async () => {
    const d = delivery();
    let pressed = 0;
    d.io.enter = () => {
      d.calls.push('Enter');
      pressed += 1;
      if (pressed === 3) d.accept();
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: the retries are bounded and an unsent box ends in the unsent report', async () => {
    const d = delivery();
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: changed text in the composer gets no retry', async () => {
    const d = delivery();
    d.io.enter = () => {
      d.calls.push('Enter');
      d.showText(boxed('Read rules/implementer.md (sha256 5e1d0b).'));
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: a box that no longer holds the line gets no retry', async () => {
    const d = delivery();
    d.io.enter = () => {
      d.calls.push('Enter');
      d.show('idle');
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test.each(['trust', 'permission'])('a %s dialog after Enter gets no retry', async (dialog) => {
    const d = delivery();
    d.io.enter = () => {
      d.calls.push('Enter');
      d.show(dialog);
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: a busy seat gets no retry even while the line still shows', async () => {
    const d = delivery();
    d.io.enter = () => {
      d.calls.push('Enter');
      d.setStatus('working');
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: a CLI that leaves the foreground gets no retry and reports no agent', async () => {
    const d = delivery();
    d.io.enter = () => {
      d.calls.push('Enter');
      d.setForeground(['zsh']);
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: a rules file that changed after the first Enter gets no retry', async () => {
    const d = delivery();
    let entered = false;
    d.io.file = () => !entered;
    d.io.enter = () => {
      d.calls.push('Enter');
      entered = true;
      return true;
    };
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: the caller\'s own check before Enter can refuse the retry', async () => {
    const d = delivery();
    d.io.beforeInput = () => d.calls.filter((call) => call === 'Enter').length === 0;
    const retired = await deliverRules('codex', LINE, 30, d.io);
    expect(await retired).toBe(false);
  });

  test('no pane messaging, rules are never typed; was: a box that never read the line back gets no submit and no retry', async () => {
    // The paste renders as a different line: the read-back fails before the first Enter, and a
    // missing read-back is never turned into a submit.
    const d = delivery();
    d.io.type = (text) => {
      d.calls.push(text);
      d.showText(boxed('Read rules/implementer.md (sha256 5e1d0b).'));
      return true;
    };
    const retired = await deliverRules('codex', LINE, 1, d.io);
    expect(await retired).toBe(false);
  });
});
