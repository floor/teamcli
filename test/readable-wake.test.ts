import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripSgr } from '../src/ansi.ts';
import { runSend } from '../src/commands/send.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { inlineWake, RUNTIME_WAKE_MAX } from '../src/send/readable-wake.ts';
import type { RecordPayload } from '../src/send/record.ts';
import { fake, owner, world } from './send-native-fixtures.ts';

const idle = stripSgr(readFileSync(new URL('./fixtures/codex/0.167.0/idle.txt', import.meta.url), 'utf8'));
const working = stripSgr(readFileSync(new URL('./fixtures/codex/0.167.0/working.txt', import.meta.url), 'utf8'));
const draw = (text: string) => idle.replace('› Ask Codex to do anything', `› ${text.replaceAll('\n', '\n  ')}`);

test('a full multiline typed wake is readable and settles its durable record after submission', async () => {
  const w = world(['typed']);
  try {
    let typed = '';
    let enters = 0;
    const io = owner(w.root);
    const host = fake(w, {
      agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
      typedWake: () => ({
        read: () => enters ? working : typed ? draw(typed) : idle,
        type: (_pane, text) => { typed = text; return true; },
        enter: () => { enters++; return true; },
        wait: async () => {},
      }),
      wakeVerifyMs: 1, wakePollMs: 1,
    });
    const code = await runSend(['native', 'First line.\nSecond line.'], io, host);
    expect(code, io.err + io.out).toBe(0);
    expect(typed).toContain('\n\n');
    expect(typed).toContain('First line.\nSecond line.');
    expect(typed).not.toContain('drops --read');
    expect(enters).toBe(1);
    const dir = join(w.dir, 'send-drops', 'acme', 'native');
    expect(readdirSync(dir).some((name) => name.endsWith('.read.json'))).toBe(true);
    expect(listUnread(dir, { root: w.root, session: 'acme', to: 'native' }, w.home)).toHaveLength(0);
  } finally { w.cleanup(); }
});

test('a draft is neither appended to nor receipted by an inline wake', async () => {
  const w = world(['typed']);
  try {
    let writes = 0;
    const io = owner(w.root);
    const host = fake(w, {
      agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
      typedWake: () => ({ read: () => draw('unfinished draft'), type: () => { writes++; return true; }, enter: () => { writes++; return true; }, wait: async () => {} }),
      wakeVerifyMs: 1, wakePollMs: 1,
    });
    await runSend(['native', 'Hello'], io, host);
    expect(writes).toBe(0);
    const dir = join(w.dir, 'send-drops', 'acme', 'native');
    expect(readdirSync(dir).some((name) => name.endsWith('.read.json'))).toBe(false);
  } finally { w.cleanup(); }
});

test('multiline read-back requires every row and refuses extra or partial text', () => {
  const text = 'Header\n\nMessage';
  expect(boxHoldsText('codex', text, draw(text))).toBe(true);
  expect(boxHoldsText('codex', text, draw(text + 'extra'))).toBe(false);
  expect(boxHoldsText('codex', text, draw('Header\n\nMess'))).toBe(false);
});

test('runtime wake retains all content and refuses an oversized body without truncating it', () => {
  const payload = { body: 'One\nTwo', from: 'runtime', root: '/synthetic', at: '2026-11-10T00:00:00Z', rule: 'synthetic rule' } as RecordPayload;
  expect(inlineWake(payload, '/synthetic')).toContain('One\nTwo');
  expect(inlineWake({ ...payload, body: 'x'.repeat(RUNTIME_WAKE_MAX) }, '/synthetic')).toBeNull();
});

test('the Codex queue adapter forwards a multiline body beyond the old pointer bound', async () => {
  const { codexPushAdapter } = await import('../src/send/push-adapters/codex.ts');
  let message = '';
  const adapter = codexPushAdapter({
    codexDaemon: 'on',
    resolveSession: () => ({ kind: 'bound', recorded: {
      agentId: 'synthetic-agent', seatHandle: null, sessionId: 'synthetic-thread',
      team: 'synthetic-team', seat: 'worker', cli: 'codex', herdrSession: 'synthetic-session', pane: null, address: null,
    } }),
    spawn: (_binary, args) => { message = args[args.indexOf('--message') + 1] ?? ''; return { status: 0, stdout: '', stderr: '' }; },
  });
  const text = 'Sender header\n\n' + 'body '.repeat(60);
  const outcome = await adapter.push({ root: '/synthetic-root', home: '/synthetic-home', session: 'synthetic-session', seat: 'worker', id: 'synthetic-message', sender: { seat: 'lead', team: 'synthetic-team' }, agentSession: 'synthetic-thread', pointer: text });
  expect(outcome.kind).toBe('enqueue');
  expect(message).toBe(text);
});

test('an oversized typed body explicitly requests a read and stays unread', async () => {
  const w = world(['typed']);
  try {
    let typed = '';
    let entered = false;
    const io = owner(w.root);
    const host = fake(w, {
      agents: () => [{ name: 'native', pane: 'synthetic-pane', cli: 'codex' }],
      typedWake: () => ({ read: () => entered ? working : typed ? draw(typed) : idle, type: (_pane, text) => { typed = text; return true; }, enter: () => { entered = true; return true; }, wait: async () => {} }),
      wakeVerifyMs: 1, wakePollMs: 1,
    });
    expect(await runSend(['native', 'x'.repeat(600)], io, host), io.err).toBe(0);
    expect(typed).toContain('Body too long; read it with: team drops --read.');
    const dir = join(w.dir, 'send-drops', 'acme', 'native');
    expect(readdirSync(dir).some((name) => name.endsWith('.read.json'))).toBe(false);
  } finally { w.cleanup(); }
});

test('compact socket delivery keeps every body line', async () => {
  const { socketMessageFrame } = await import('../src/send/frame.ts');
  const frame = JSON.parse(socketMessageFrame('synthetic-session', 'worker', 'First line\nSecond line', 'synthetic-message', { from: 'runtime', compact: true }));
  expect(frame.message.content).toContain('First line\nSecond line');
});
