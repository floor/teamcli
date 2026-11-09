// A limit sentence on the live tail is out of tokens only when no rule recognised the screen.
// A custom rule on the unknown stage keeps that dialog. The shipped exit screen, the one that
// says how to resume the session, stays that dialog too. A tail no rule saw, on a pane that
// would otherwise be idle, becomes out of tokens. The modal and the tail are synthetic. The
// exit screen is the shipped capture.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { classifyWith, parseOverrides } from '../src/profiles/overrides.ts';
import { outOfTokensState } from '../src/quota/token-fallback.ts';
import { readScreen } from '../src/watch/screen.ts';

const LIMIT = 'usage limit reached until 3pm';

function customRule() {
  const parsed = parseOverrides(`format: 1
profiles:
  claude-code:
    screen:
      unknown:
        - any: ['Hold this choice']
`);
  if (!parsed.ok) throw new Error(parsed.errors[0]?.message);
  return parsed.profiles;
}

test('a custom rule at the unknown stage keeps the dialog when the tail names a limit', () => {
  const text = ['Hold this choice before the seat continues', 'the choice is the seat\'s own', LIMIT].join('\n');
  const screen = classifyWith('claude-code', text, customRule());
  expect(screen.kind).toBe('unknown');
  expect(screen.kind === 'unknown' ? screen.provenance : undefined).toBe('custom');
  expect(outOfTokensState(screen)).toBeNull();
});

test('a shipped exited session stays that dialog when the tail names a limit', () => {
  const captured = readFileSync(new URL('./fixtures/claude-code/2.1.302/exit.txt', import.meta.url), 'utf8');
  const screen = readScreen('claude-code', `${captured}\n${LIMIT}`);
  expect(screen.kind).toBe('unknown');
  expect(screen.kind === 'unknown' ? screen.provenance : undefined).toBe('profile');
  expect(outOfTokensState(screen)).toBeNull();
});

test('a limit tail no rule recognised is out of tokens', () => {
  const rule = '─'.repeat(40);
  const text = `${LIMIT}\n${rule}\n❯ \n${rule}\n  main · acme\n`;
  const screen = readScreen('claude-code', text);
  expect(screen).toEqual({ kind: 'rate limit', reset: { kind: 'at', value: '3pm' }, reason: 'out of tokens' });
  expect(outOfTokensState(screen)).toBe('out of tokens');
});
