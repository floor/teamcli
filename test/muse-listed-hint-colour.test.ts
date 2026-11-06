import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';
import { classifyComposer, readBox, readScreen } from '../src/watch/screen.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');

const LISTED = '/tasks shows your open tasks';
const TYPED_BLUE = '\x1b[38;2;90;160;255m';
const DECLARED_GREY = '\x1b[38;2;103;108;116m';
const TRIGGER_LINE = 'Read /t/mail/msg-01 and act on it.';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function withInput(styledText: string): string {
  return IDLE.replace('❯\n', `❯ ${styledText}\n`);
}

function holding(text: string): string {
  return IDLE.replace('❯\n', `❯ ${text}\n`);
}

function makeWakeHost(
  screenAt: (read: number, enters: number) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number } {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => screenAt(reads++, enters),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return enters;
    },
  };
}

describe('a listed Muse hint is the empty box only when faint or declared', () => {
  test('typed blue on a listed hint is a draft, not the empty box', () => {
    const frame = withInput(`${TYPED_BLUE}${LISTED}\x1b[0m`);
    expect(readScreen('muse', frame).kind).toBe('unsent');
    expect(classifyComposer('muse', frame.split('\n')).kind).toBe('unsent');
    expect(readBox('muse', frame)?.first).toBe(LISTED);
    expect(boxHoldsText('muse', LISTED, frame)).toBe(true);
  });

  test('an undeclared grey on a listed hint is a draft too', () => {
    const frame = withInput(`\x1b[90m${LISTED}\x1b[0m`);
    expect(readScreen('muse', frame).kind).toBe('unsent');
    expect(readBox('muse', frame)?.first).toBe(LISTED);
    expect(boxHoldsText('muse', LISTED, frame)).toBe(true);
  });

  test('the typed wake refuses typed blue on a listed hint before any key', async () => {
    const frame = withInput(`${TYPED_BLUE}${LISTED}\x1b[0m`);
    const pane = makeWakeHost(() => frame);
    const out = await deliverTypedWake(pane.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: false,
      typed: false,
      tries: 0,
      reason: 'the first read showed unsent, not an empty idle prompt; nothing was typed',
    });
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test('the declared grey and a faint row stay idle, and the declared grey wake delivers', async () => {
    const declared = withInput(`${DECLARED_GREY}${LISTED}\x1b[0m`);
    const faint = withInput(`\x1b[2m${LISTED}\x1b[0m`);
    expect(readScreen('muse', declared).kind).toBe('idle');
    expect(readBox('muse', declared)).toBeNull();
    expect(readScreen('muse', faint).kind).toBe('idle');
    expect(readBox('muse', faint)).toBeNull();

    const wake = makeWakeHost((read, enters) => (enters > 0 ? WORKING : read < 2 ? declared : holding(TRIGGER_LINE)));
    const out = await deliverTypedWake(wake.host, 'pane-1', TRIGGER_LINE, 'muse', FAST);
    expect(out).toEqual({
      delivered: true,
      typed: true,
      tries: 1,
      reason: 'the working screen showed after 1 Enter',
      submittedAt: expect.any(Number),
      workingAt: expect.any(Number),
    });
    expect(wake.typed).toEqual([TRIGGER_LINE]);
    expect(wake.enters).toBe(1);
  });
});
