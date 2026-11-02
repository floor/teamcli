// The owner's absolute rule (2026-10-31): no message, wake, reminder, nudge or rules line is ever
// typed into a seat's pane. This file holds the messaging paths to it.
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { deliverRules } from '../src/launch/deliver.ts';
import { deliverTrigger } from '../src/send/deliver.ts';
import { submitTrigger } from '../src/send/native.ts';
import { isTypingLeg, NO_PANE_MESSAGING } from '../src/send/no-pane-messaging.ts';

const root = join(import.meta.dir, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

// An import of a pane writer from herdr, under whatever local name: `sendKey as keys` is the
// same writer as `sendKey`, and the scan reads the alias too, so a renamed import cannot carry
// a pane writer past it.
const PANE_WRITERS: ReadonlySet<string> = new Set(['typeText', 'pressEnter', 'sendKey']);
function importsPaneWriter(text: string): boolean {
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/herdr\.ts['"]/g)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const name = specifier.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0]?.trim();
      if (name !== undefined && PANE_WRITERS.has(name)) return true;
    }
  }
  return false;
}

test('the pane-writer scan reads an import alias as the writer it names', () => {
  expect(importsPaneWriter("import { sendKey } from '../herdr.ts';")).toBe(true);
  expect(importsPaneWriter("import { sendKey as keys } from '../herdr.ts';")).toBe(true);
  expect(importsPaneWriter("import { typeText as write } from '../herdr.ts';")).toBe(true);
  expect(importsPaneWriter("import {\n  readAnsi,\n  pressEnter as enter,\n} from '../herdr.ts';")).toBe(true);
  expect(importsPaneWriter("import { paneRead, agentList } from '../herdr.ts';")).toBe(false);
  expect(importsPaneWriter("import { sendKey } from '../other.ts';")).toBe(false);
});

// The one exemption: a profile that declares `typed_wake: screen` lets a send type
// one trigger line into an empty idle box it saw twice. That wake lives in one module, and its
// own scenes pin what it does with the pane (test/typed-wake.test.ts); every other messaging
// module still stops at this scan.
const TYPED_WAKE_EXEMPTION = 'src/send/typed-wake.ts';

test('no messaging module types into a pane with herdr directly, except the one profile-gated typed wake', () => {
  const messaging = [...files(join(root, 'src', 'send')), ...files(join(root, 'src', 'watch')), ...files(join(root, 'src', 'mcp')), join(root, 'src', 'daemon', 'watch-run.ts'), join(root, 'src', 'launch', 'deliver.ts'), join(root, 'src', 'commands', 'send.ts')];
  // An allow-list entry that names no file would silently cover nothing.
  expect(existsSync(join(root, TYPED_WAKE_EXEMPTION))).toBe(true);
  const offenders: string[] = [];
  for (const path of messaging) {
    if (relative(root, path) === TYPED_WAKE_EXEMPTION) continue;
    const text = readFileSync(path, 'utf8');
    if (/['"]send-(text|keys)['"]/.test(text)) offenders.push(`${relative(root, path)}: herdr send-text/send-keys`);
    if (importsPaneWriter(text)) offenders.push(`${relative(root, path)}: imports a herdr pane writer`);
  }
  expect(offenders).toEqual([]);
  // And the exemption is exactly one module: the files that hold a pane writer are named here,
  // so a second one cannot appear without failing this line.
  const typers = messaging.filter((path) => importsPaneWriter(readFileSync(path, 'utf8')));
  expect(typers.map((path) => relative(root, path))).toEqual([TYPED_WAKE_EXEMPTION]);
});

// The acts a command may use a pane's keyboard for, each said in its own words. Answering a
// dialog, sending a CLI its exit keys, and launching one are not messaging; nothing else is.
const PANE_ACTS: ReadonlyArray<readonly [file: string, act: string]> = [
  ['answer.ts', 'answers a permission or trust dialog'],
  ['down.ts', 'sends a CLI its exit keys'],
  ['remove.ts', 'sends a CLI its exit keys'],
  ['up.ts', 'launches a CLI'],
  ['add.ts', 'launches a CLI'],
  ['reload.ts', 'launches a CLI'],
  ['restart.ts', 'launches a CLI'],
];

test('a command outside the pane acts imports no herdr pane writer and names no herdr key command', () => {
  for (const [file, act] of PANE_ACTS) {
    // An allow-list entry that names no file would silently cover nothing.
    expect(existsSync(join(root, 'src', 'commands', file)), `${file} (${act})`).toBe(true);
  }
  const allowed = new Set(PANE_ACTS.map(([file]) => file));
  const offenders: string[] = [];
  for (const path of files(join(root, 'src', 'commands'))) {
    if (allowed.has(basename(path))) continue;
    const text = readFileSync(path, 'utf8');
    if (/['"]send-(text|keys)['"]/.test(text)) offenders.push(`${relative(root, path)}: herdr send-text/send-keys`);
    if (importsPaneWriter(text)) {
      offenders.push(`${relative(root, path)}: imports a herdr pane writer`);
    }
  }
  expect(offenders).toEqual([]);
});

test('the send and watch bind no pane writer: their typeText, pressEnter and sendKey refuse', () => {
  for (const rel of ['src/commands/send.ts', 'src/send/daemon.ts', 'src/commands/watch.ts']) {
    const text = readFileSync(join(root, rel), 'utf8');
    expect(text, rel).toContain('typeText: refuseTyping');
    expect(text, rel).toContain('pressEnter: refuseTyping');
    expect(text, rel).toContain('sendKey: refuseTyping');
  }
});

test('the typed leg is a typing leg, never walked; the native leg is a runtime queue, and the native pane trigger refuses (below)', () => {
  expect(isTypingLeg('typed')).toBe(true);
  for (const leg of ['native', 'mcp-inbox', 'channel', 'socket', 'drop', 'headless-resume']) expect(isTypingLeg(leg)).toBe(false);
});

const touched: string[] = [];
const pane = {
  status: () => 'idle',
  typeText: () => { touched.push('type'); return true; },
  pressEnter: () => { touched.push('enter'); return true; },
  sendKey: () => { touched.push('key'); return true; },
  readAnsi: () => '',
  wait: async () => {},
};

test('a send trigger is never typed', async () => {
  touched.length = 0;
  const out = await deliverTrigger(pane as never, 'p', 'Read /x and do that.', 'claude');
  expect(out.outcome).toBe('unreachable');
  expect(out.reason).toBe(NO_PANE_MESSAGING);
  expect(touched).toEqual([]);
});

test('a native trigger is never typed', async () => {
  touched.length = 0;
  const native = { status: () => 'idle', typeText: () => { touched.push('type'); return true; }, pressEnter: () => { touched.push('enter'); return true; } };
  const out = await submitTrigger(native as never, 's', 'p', 'line');
  expect(out).toEqual({ ok: false, reason: NO_PANE_MESSAGING });
  expect(touched).toEqual([]);
});

test('a rules line is never typed; the refusal is reported', async () => {
  touched.length = 0;
  const reasons: unknown[] = [];
  const out = await deliverRules('claude-code', 'Read /rules.md', 1, {
    screen: () => '', status: () => 'idle', foreground: () => null,
    type: () => { touched.push('type'); return true; }, enter: () => { touched.push('enter'); return true; },
    file: () => true, report: (why: unknown) => { reasons.push(why); },
  } as never);
  expect(out).toBe(false);
  expect(touched).toEqual([]);
  expect(JSON.stringify(reasons)).toContain('never a delivery');
});
