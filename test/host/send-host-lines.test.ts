// Which lines the warm send host runs, and which environments it can honour (rfc-bus-send-server
// §2.5): only a seat's plain send, reply and ack; every other shape is handed back before
// anything runs.
import { describe, expect, test } from 'bun:test';
import { envFallback, lineFallback } from '../../src/host/run.ts';

describe('lines the host runs', () => {
  for (const argv of [
    ['send', 'lead', 'hello'],
    ['send', 'lead', 'hello', '--subject', 'x', '--json', '--dry-run'],
    ['send', 'lead', '--file', 'body.md'],
    ['send', 'lead', '--brief', 'brief.md', '--subject', 's'],
    ['reply', 'abcd1234'],
    ['reply', 'abcd1234', 'thanks', '--json'],
    ['reply', 'abcd1234', '--close'],
    ['ack', 'abcd1234'],
    ['ack', 'abcd1234', '--json'],
  ]) {
    test(argv.join(' '), () => expect(lineFallback(argv)).toBeNull());
  }
});

describe('lines handed back', () => {
  for (const argv of [
    ['status'],
    ['send'],
    ['send', 'lead'],
    ['send', 'lead', 'a', 'b'],
    ['send', 'lead', '-'],
    ['send', 'lead', 'hi', '--wait'],
    ['send', 'lead', 'hi', '--timeout', '5'],
    ['send', 'lead', 'hi', '--request'],
    ['send', 'lead', 'hi', '--approval', 'r1'],
    ['send', 'lead', 'hi', '--general', 'g', '--key', 'k'],
    ['send', '--client', 'g', '--key', 'k', 'lead', 'hi'],
    ['send', '--confirm', 'x'],
    ['send', '--list'],
    ['send', '--record', 'lead', '--channel', 'c', '--ms', '1'],
    ['send', 'lead', '--file'],
    ['send', 'lead', 'hi', '--help'],
    ['reply'],
    ['reply', 'id', 'a', 'b'],
    ['reply', 'id', 'x', '--general', 'g'],
    ['ack'],
    ['ack', '--seat', 's', '--older-than', '1d'],
    ['ack', 'id', '--dry-run'],
  ]) {
    test(argv.join(' ') || '(empty)', () => expect(lineFallback(argv)).not.toBeNull());
  }
});

describe('the environment', () => {
  test('the same HOME and TMPDIR are honoured; unrelated variables may differ', () => {
    expect(envFallback({ HOME: '/h', TMPDIR: '/t', OTHER: 'a' }, { HOME: '/h', TMPDIR: '/t', OTHER: 'b' })).toBeNull();
  });
  test('another HOME, another TMPDIR, or one set where the host has none is handed back', () => {
    expect(envFallback({ HOME: '/x', TMPDIR: '/t' }, { HOME: '/h', TMPDIR: '/t' })).toContain('HOME');
    expect(envFallback({ HOME: '/h', TMPDIR: '/x' }, { HOME: '/h', TMPDIR: '/t' })).toContain('TMPDIR');
    expect(envFallback({ HOME: '/h', TMPDIR: '/t' }, { HOME: '/h' })).toContain('TMPDIR');
  });
});
