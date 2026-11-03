// A body that is more than one line still reaches the pane as one short line. The
// single-line case lives in send.test.ts. No live pane.
import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { TRIGGER_MAX, readTriggerLine, triggerLine } from '../src/send/native.ts';
import { MESSAGE_LINE_MAX } from '../src/settings/message-display.ts';
import { recordBody } from './helpers.ts';
import { dropDir, filed, nativeHost, owner, world } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

test('a multi-line body is filed whole and the pane gets one short line', async () => {
  const made = world();
  cleanup = made.cleanup;
  const body = 'HEAD-LINE\nTAIL-LINE';
  const { host, pane } = nativeHost(made, ['idle', 'working']);

  const code = await runSend(['native', body], owner(made.root), host);

  expect(code).toBe(0);
  expect(pane.typed.length).toBe(0);
  // The first content line is the summary; the rest of the body stays in the drop.
  const drops = dropDir(made.dir);
  const names = readdirSync(drops).filter((name) => !name.includes('.'));
  expect(names.length).toBe(1);
  const path = join(drops, names[0] as string);
  const line = readTriggerLine('native', 'acme', { seat: 'owner', team: 'acme', body });
  expect(recordBody(path)).toBe(filed(body));
  expect(host.frames).toEqual([]);
});

test('a wake with a sender names its seat and team; one without keeps the old form', () => {
  const path = '/drops/teamcli/native/tester-1/4a9f';
  expect(triggerLine(path)).toBe(`Read ${path} and do that.`);
  expect(triggerLine(path, { seat: 'tester-2', team: 'teamcli' })).toBe(
    `Message from tester-2 (tester-2@teamcli): Read it at ${path}.`,
  );
});

test('a named wake fits at exactly the measured limit and is refused one character past it', () => {
  const sender = { seat: 'tester-2', team: 'teamcli' };
  // `Message from tester-2 (tester-2@teamcli): Read it at <path>.` is 54 characters around the
  // path for this sender: 146 makes exactly 200, 147 makes 201.
  const fits = `/${'x'.repeat(145)}`;
  const over = `/${'x'.repeat(146)}`;
  const named = `Message from tester-2 (tester-2@teamcli): Read it at ${fits}.`;
  expect(named.length).toBe(TRIGGER_MAX);
  expect(triggerLine(fits, sender)).toBe(named);
  // The full line never drops the name: one character more gives up the summary and the long
  // opening but keeps the sender in the shipped compact address, never a nameless line.
  expect(triggerLine(over, sender)).toBe(`From tester-2@teamcli: read ${over} and do that.`);
  // A path that only fits the nameless form is refused, not written nameless: a wake for a
  // message always names its sender.
  const oldFits = `/${'x'.repeat(TRIGGER_MAX - 'Read  and do that.'.length - 1)}`;
  expect(`Read ${oldFits} and do that.`.length).toBe(TRIGGER_MAX);
  expect(triggerLine(oldFits)).toBe(`Read ${oldFits} and do that.`);
  expect(triggerLine(oldFits, sender)).toBeNull();
  expect(triggerLine(`/${'x'.repeat(TRIGGER_MAX)}`, sender)).toBeNull();
});

test('a sender that is not one clean line is sanitised to one line, never written nameless', () => {
  // A name is data: its line breaks become spaces before the header is built, and the seat name
  // the file could not carry is still the name shown.
  expect(triggerLine('/drops/a', { seat: 'tester\n2', team: 'teamcli' })).toBe(
    'Message from tester 2 (tester 2@teamcli): Read it at /drops/a.',
  );
  expect(triggerLine('/drops/a', { seat: 'tester-2', team: 'team\ncli' })).toBe(
    'Message from tester-2 (tester-2@team cli): Read it at /drops/a.',
  );
  expect(readTriggerLine('lead', 'acme', { seat: 'tester\n2', team: 'teamcli' })).toBe(
    'Message from tester 2 (tester 2@teamcli): Read it with: team drops --read.',
  );
  expect(readTriggerLine('lead', 'acme', { seat: 'tester-2', team: 'team\ncli' })).toBe(
    'Message from tester-2 (tester-2@team cli): Read it with: team drops --read.',
  );
});

test('a read wake with a sender names it; one without keeps the old form', () => {
  expect(readTriggerLine('lead', 'acme')).toBe('Run team drops --read --seat lead --session acme and do that.');
  expect(readTriggerLine('lead', 'acme', { seat: 'tester-2', team: 'teamcli' })).toBe(
    'Message from tester-2 (tester-2@teamcli): Read it with: team drops --read.',
  );
});

test('the appended sentence names the receiving profile’s fastest read path', () => {
  const sender = { seat: 'tester-2', team: 'teamcli' };
  // The inbox profiles' wake sends the woken turn straight to the tool that lists the waiting
  // messages with their ids: the typed line never carries the id `inbox_read` takes, so naming
  // the read alone would earn a refused call.
  for (const cli of ['antigravity', 'cursor']) {
    const line = readTriggerLine('lead', 'acme', sender, cli) as string;
    expect(line).toBe('Message from tester-2 (tester-2@teamcli): Read it with: call inbox_check now.');
    expect(line.length).toBeLessThanOrEqual(MESSAGE_LINE_MAX);
  }
  // A profile with no inbox keeps the shipped drops read, and so does a CLI with no profile and
  // a caller that names none.
  const shipped = 'Message from tester-2 (tester-2@teamcli): Read it with: team drops --read.';
  expect(readTriggerLine('lead', 'acme', sender, 'muse')).toBe(shipped);
  expect(readTriggerLine('lead', 'acme', sender, 'claude-code')).toBe(shipped);
  expect(readTriggerLine('lead', 'acme', sender)).toBe(shipped);
});

test('the profile’s sentence stays whole when the header gives way, and the body is never the line', () => {
  const sender = { seat: 'tester-2', team: 'teamcli', body: 'HEAD-LINE\nTAIL-LINE' };
  const line = readTriggerLine('lead', 'acme', sender, 'cursor') as string;
  expect(line.length).toBeLessThanOrEqual(MESSAGE_LINE_MAX);
  expect(line.endsWith(' Read it with: call inbox_check now.')).toBe(true);
  expect(line.startsWith('Message from tester-2')).toBe(true);
  expect(line).not.toContain('TAIL-LINE');
});

test('a named read wake keeps the fixed hint whole inside the measured limit', () => {
  const sender = { seat: 'tester-2', team: 'teamcli', body: 'x'.repeat(80) };
  const named = readTriggerLine('lead', 'acme', sender) as string;
  expect(named.length).toBeLessThanOrEqual(MESSAGE_LINE_MAX);
  // The hint is never cut or dropped; the header gives way to it.
  expect(named.endsWith('Read it with: team drops --read.')).toBe(true);
  expect(named.startsWith('Message from tester-2')).toBe(true);
  // The nameless form is never the fallback: a wake for a message always names its sender.
  expect(readTriggerLine('lead', 'acme')).not.toBeNull();
});

test('adversarial long summary and multi-line body: cursor, antigravity, and muse keep their exact hint inside 80 chars and never include the body', () => {
  const longSummary = `FIRST-SUMMARY-${'A'.repeat(120)}`;
  const secretBody = `${longSummary}\nSECOND-LINE-SECRET-PAYLOAD\nTHIRD-LINE-NEVER-TYPED`;
  const sender = {
    name: 'helper · tester 3',
    seat: 'tester-3',
    team: 'teamcli',
    subject: `SUBJECT-${'S'.repeat(90)}`,
    body: secretBody,
  };

  for (const cli of ['cursor', 'antigravity']) {
    const line = readTriggerLine('dev', 'teamcli', sender, cli);
    expect(line).not.toBeNull();
    expect((line as string).length).toBe(MESSAGE_LINE_MAX);
    expect((line as string).endsWith(' Read it with: call inbox_check now.')).toBe(true);
    expect(line as string).not.toContain('\n');
    expect(line as string).not.toContain('SECOND-LINE-SECRET-PAYLOAD');
    expect(line as string).not.toContain('THIRD-LINE-NEVER-TYPED');
    expect(line as string).not.toContain('team drops --read');
  }

  for (const cli of ['muse', 'claude-code', 'codex', undefined]) {
    const line = readTriggerLine('dev', 'teamcli', sender, cli);
    expect(line).not.toBeNull();
    expect((line as string).length).toBe(MESSAGE_LINE_MAX);
    expect((line as string).endsWith(' Read it with: team drops --read.')).toBe(true);
    expect(line as string).not.toContain('\n');
    expect(line as string).not.toContain('SECOND-LINE-SECRET-PAYLOAD');
    expect(line as string).not.toContain('THIRD-LINE-NEVER-TYPED');
    expect(line as string).not.toContain('inbox_check');
  }
});

