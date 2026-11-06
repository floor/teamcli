// Synthetic frames only. No CLI is started.
import { expect, test } from 'bun:test';
import { GROK_SANDBOX_UNAPPLIED, grokSandboxUnapplied, sandboxUnappliedNotes } from '../src/launch/grok-sandbox.ts';

const FRAME = [
  'warning: sandbox could not be applied: Custom sandbox profile was not found.',
  '',
  'user@pane %',
].join('\n');

test('a synthetic frame that carries the sandbox refusal is recognised', () => {
  expect(grokSandboxUnapplied(FRAME)).toBe(true);
  expect(grokSandboxUnapplied(`stderr: ${GROK_SANDBOX_UNAPPLIED}\n`)).toBe(true);
  expect(grokSandboxUnapplied('idle prompt\n› ')).toBe(false);
});

test('team status names the stopped seat from the record, not from a stored sentence', () => {
  const notes = sandboxUnappliedNotes(
    [{ name: 'worker' }, { name: 'other' }],
    { seats: { worker: { sandbox_unapplied: { why: 'ignore this stored sentence' } } } },
  );
  expect(notes).toEqual([`worker: stopped: ${GROK_SANDBOX_UNAPPLIED}`]);
});
