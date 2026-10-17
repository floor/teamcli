// The feed's boundaries: it shows one team's messages and no other team's, with --all as the
// only door through which the rest appear; the 0600 history log is read and never rewritten,
// before or during a follow; a malformed line in the log or the audit file is skipped, never
// shown and never executed; and following the log grows it by nothing the feed itself wrote.
import { describe, expect, test, afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFeed } from '../src/commands/feed.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { appendHistory, historyPath, parseHistoryLine } from '../src/send/history.ts';
import { storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: helper
session: acme
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: helper
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
`;
}

function world() {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-feed-boundaries-')));
  const home = join(base, 'home');
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home)));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, home };
}

function feedIds(out: string): string[] {
  return (JSON.parse(out) as { events: Array<{ id: string }> }).events.map((event) => event.id);
}

describe('the feed\'s boundaries', () => {
  test('a message of another team is never shown without --all', async () => {
    const { root, home } = world();
    appendHistory('acme', root, home, {
      ts: '2026-10-14T16:00:00.000Z', from: 'owner', to: 'lead',
      body: 'the acme stand-down', id: 'acme-1', outcome: 'delivered',
    });
    appendHistory('beta', join(base, 'beta-root'), home, {
      ts: '2026-10-14T16:00:01.000Z', from: 'owner', to: 'worker',
      body: 'the beta secret', id: 'beta-1', outcome: 'delivered',
    });
    appendHistory('acme', join(base, 'acme-other'), home, {
      ts: '2026-10-14T16:00:02.000Z', from: 'owner', to: 'lead',
      body: 'the other checkout line', id: 'acme-2', outcome: 'delivered',
    });

    const io = testIo(root);
    expect(await runFeed(['--json'], io, { home })).toBe(0);
    expect(feedIds(io.out)).toEqual(['acme-1']);
    expect(io.out).not.toContain('the beta secret');
    expect(io.out).not.toContain('the other checkout line');

    // --all is the only door through which the other teams' messages appear
    const all = testIo(root);
    expect(await runFeed(['--all', '--json'], all, { home })).toBe(0);
    expect(feedIds(all.out)).toEqual(['acme-1', 'beta-1', 'acme-2']);
  });

  test('the 0600 history log is read and never rewritten, plain or following', async () => {
    const { root, home } = world();
    appendHistory('acme', root, home, {
      ts: '2026-10-14T16:00:00.000Z', from: 'owner', to: 'lead',
      body: 'one', id: 'm1', outcome: 'delivered',
    });
    appendHistory('acme', root, home, {
      ts: '2026-10-14T16:00:01.000Z', from: 'owner', to: 'lead',
      body: 'two', id: 'm2', outcome: 'delivered',
    });

    const logPath = historyPath('acme', root, home);
    const storeDir = storePath('acme', root, home);
    const before = readFileSync(logPath, 'utf8');
    const mtime = statSync(logPath).mtimeMs;
    const storeMode = statSync(storeDir).mode & 0o777;

    const plain = testIo(root);
    expect(await runFeed([], plain, { home })).toBe(0);
    const follow = testIo(root);
    expect(await runFeed(['--follow'], follow, { home, poll: async (tick) => tick < 2 })).toBe(0);
    expect(follow.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND       SEAT           DETAIL\n' +
        '  16:00:00  delivered  owner -> lead  one\n' +
        '  16:00:01  delivered  owner -> lead  two\n' +
        '2 event(s)\n',
    );

    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(logPath, 'utf8')).toBe(before);
    expect(statSync(logPath).mtimeMs).toBe(mtime);
    expect(statSync(storeDir).mode & 0o777).toBe(storeMode);
    expect(readdirSync(storeDir).sort()).toEqual(['messages.jsonl']);
  });

  test('a malformed line in the log or the audit file is skipped, not executed', async () => {
    const { root, home } = world();
    const logPath = historyPath('acme', root, home);
    appendHistory('acme', root, home, {
      ts: '2026-10-14T16:00:00.000Z', from: 'owner', to: 'lead',
      body: 'kept', id: 'm1', outcome: 'delivered',
    });
    // Junk around one more real entry: broken JSON, an array, and an object with a missing field
    writeFileSync(logPath, [
      readFileSync(logPath, 'utf8').trimEnd(),
      'this line is not json',
      '{"ts":"2026-10-14T16:00:09.000Z","from":"lead"',
      '[]',
      '{"ts":"2026-10-14T16:00:10.000Z","from":"lead","to":"helper","body":"a body with no id","outcome":"delivered"}',
      '',
      'not-json-at-the-end',
    ].join('\n') + '\n', { flag: 'w' });

    const io = testIo(root);
    expect(await runFeed(['--json'], io, { home })).toBe(0);
    expect(feedIds(io.out)).toEqual(['m1']);
    expect(io.out).not.toContain('this line is not json');
    expect(io.out).not.toContain('a body with no id');

    // The same rule on the audit file the feed is told to read
    const auditPath = join(base, 'desk-audit.jsonl');
    mkdirSync(dirname(auditPath), { recursive: true });
    writeFileSync(auditPath, [
      'not json either',
      '{"ts":"2026-10-14T16:00:11.000Z","event":"guard.ask","request_id":"r9","reason":"install"}',
      '{}',
      '',
    ].join('\n') + '\n', { mode: 0o600 });
    const auditIo = testIo(root);
    expect(await runFeed(['--audit', auditPath, '--json'], auditIo, { home })).toBe(0);
    expect(feedIds(auditIo.out)).toEqual(['m1', 'audit:r9:guard.ask:2026-10-14T16:00:11.000Z']);
    expect(auditIo.out).not.toContain('not json either');
  });

  test('following the log picks up a new line and adds nothing of its own', async () => {
    const { root, home } = world();
    const logPath = historyPath('acme', root, home);
    appendHistory('acme', root, home, {
      ts: '2026-10-14T16:00:00.000Z', from: 'owner', to: 'lead',
      body: 'the first line', id: 'm1', outcome: 'delivered',
    });
    const before = readFileSync(logPath, 'utf8');
    const next = {
      ts: '2026-10-14T16:00:05.000Z', from: 'owner', to: 'lead',
      body: 'the line the team wrote while it was followed', id: 'm2', outcome: 'delivered',
    };

    const io = testIo(root);
    expect(await runFeed(['--follow'], io, {
      home,
      poll: async (tick) => {
        if (tick !== 0) return false;
        appendHistory('acme', root, home, next);
        return true;
      },
    })).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND       SEAT           DETAIL\n' +
        '  16:00:00  delivered  owner -> lead  the first line\n' +
        '1 event(s)\n' +
        '  TIME      KIND       SEAT           DETAIL\n' +
        '  16:00:05  delivered  owner -> lead  the line the team wrote while it was followed\n' +
        '1 event(s)\n',
    );

    const after = readFileSync(logPath, 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(`${JSON.stringify(next)}\n`);
    expect(parseHistoryLine(after.split('\n').filter((line) => line !== '').at(-1) ?? '')).toEqual(next);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(storePath('acme', root, home)).sort()).toEqual(['messages.jsonl']);
  });
});
