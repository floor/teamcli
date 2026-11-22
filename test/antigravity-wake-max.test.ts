// The antigravity wake carries a short body inline. The profile's `typed_wake_max` was measured
// through `herdr agent prompt` on Antigravity CLI 1.5.10 (prompts up to 8000 bytes reached the
// model whole); 4000 is the bound shipped. Below the 200-byte default nearly every message went
// as a "read it with team drops" hint. The scenes script the pane; no CLI runs.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileFor } from '../src/profiles/index.ts';
import { TYPED_WAKE_MAX, typedWakeMaxFor } from '../src/send/readable-wake.ts';
import { deliverTypedWake, type TypedWakeHost } from '../src/send/typed-wake.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'antigravity', '1.4.12');
const IDLE = readFileSync(join(FIXTURES, 'idle.txt'), 'utf8');
const WORKING = readFileSync(join(FIXTURES, 'working-synthetic.txt'), 'utf8');
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

function promptHost(): { host: TypedWakeHost; prompts: string[] } {
  const prompts: string[] = [];
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => (prompts.length > 0 ? WORKING : (reads++, IDLE)),
    type: () => true,
    enter: () => true,
    prompt: (_pane: string, text: string) => {
      prompts.push(text);
      return true;
    },
    wait: async () => {},
  };
  return { host, prompts };
}

const lineOf = (bytes: number): string => {
  const tail = ' ↩ team reply 0123abcd';
  return 'x'.repeat(bytes - Buffer.byteLength(tail, 'utf8')) + tail;
};

describe('the antigravity wake bound', () => {
  test('the profile names the measured bound, well past the 200-byte default', () => {
    expect(profileFor('antigravity')?.typedWakeMax).toBe(4000);
    expect(typedWakeMaxFor('antigravity')).toBe(4000);
    expect(TYPED_WAKE_MAX).toBe(200);
  });

  test('a 3000-byte body goes inline through the agent prompt, whole', async () => {
    const pane = promptHost();
    const line = lineOf(3000);
    const out = await deliverTypedWake(pane.host, 'pane-1', line, 'antigravity', FAST);
    expect(out.delivered).toBe(true);
    expect(pane.prompts).toEqual([line]);
  });

  test('a line past the bound is refused and nothing is prompted', async () => {
    const pane = promptHost();
    const out = await deliverTypedWake(pane.host, 'pane-1', lineOf(4001), 'antigravity', FAST);
    expect(out).toMatchObject({ delivered: false, typed: false, tries: 0 });
    expect(out.reason).toContain('4000 bytes');
    expect(pane.prompts).toEqual([]);
  });
});
