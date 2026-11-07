// agy and Grok Build submit a typed wake with `herdr agent prompt`, not by typing the line
// and pressing Enter. The frames are the captured idle and working screens. The host is a fake:
// it records agent-prompt calls and pane type/Enter calls, and no herdr runs.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileFor } from '../src/profiles/index.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';

const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1, ackSettleMs: 1 };
const LINE = 'Read it with: run team drops --read';

function frames(cli: 'grok' | 'antigravity'): { idle: string; working: string } {
  if (cli === 'grok') {
    return {
      idle: readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.70', 'idle.txt'), 'utf8'),
      working: readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.52', 'working.txt'), 'utf8'),
    };
  }
  const dir = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
  return {
    idle: readFileSync(join(dir, 'idle.txt'), 'utf8'),
    working: readFileSync(join(dir, 'working-synthetic.txt'), 'utf8'),
  };
}

function fake(screen: (read: number, prompts: number) => string | null): {
  host: TypedWakeHost;
  prompts: string[];
  typed: string[];
  enters: number;
} {
  const prompts: string[] = [];
  const typed: string[] = [];
  const state = { reads: 0, prompts: 0, enters: 0 };
  const host: TypedWakeHost = {
    read: () => screen(state.reads++, state.prompts),
    type: (_pane, text) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      state.enters += 1;
      return true;
    },
    prompt: (_pane, line) => {
      prompts.push(line);
      state.prompts += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    prompts,
    typed,
    get enters() {
      return state.enters;
    },
  };
}

for (const cli of ['antigravity', 'grok'] as const) {
  test(`${cli}: two idle reads, one agent prompt, no typed line and no Enter`, async () => {
    const { idle, working } = frames(cli);
    const pane = fake((read, prompts) => (prompts > 0 ? working : read < 2 ? idle : idle));
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, cli, FAST);
    expect(out.delivered).toBe(true);
    expect(out.reason).toBe('the working screen showed after the agent prompt');
    expect(pane.prompts).toEqual([LINE]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });

  test(`${cli}: a working screen is not prompted`, async () => {
    const { working } = frames(cli);
    const pane = fake(() => working);
    const out = await deliverTypedWake(pane.host, 'pane-1', LINE, cli, FAST);
    expect(out.delivered).toBe(false);
    expect(out.typed).toBe(false);
    expect(pane.prompts).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(pane.enters).toBe(0);
  });
}

test('antigravity names the drops read, and muse keeps the type-and-Enter wake', () => {
  expect(profileFor('antigravity')?.readHint).toBe('Read it with: run team drops --read');
  expect(profileFor('antigravity')?.wake).toBe('agent-prompt');
  expect(profileFor('grok')?.wake).toBe('agent-prompt');
  expect(profileFor('muse')?.wake).toBeNull();
});
