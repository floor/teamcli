import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runFeed, USAGE } from '../src/commands/feed.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { FEED_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { appendHistory, historyPath, MAX_HISTORY_BYTES, readHistory } from '../src/send/history.ts';
import type { NativePane } from '../src/send/native.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

type FeedDoc = {
  schema: { name: string; version: number };
  format: number;
  project: string | null;
  session: string | null;
  events: Array<Record<string, unknown>>;
};

const NOW = new Date('2026-10-14T15:30:00.000Z');

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function teamFile(root: string, lobby: string): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
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
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m implementer
  - role: reviewer
    name: native
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex -m test
# This fixture's sends exercise the typed leg: the inbox is tried and skipped for want of a
# listener, then the trigger line is typed. The team's word keeps the default's drop step out.
delivery_order: [mcp-inbox, typed]
`;
}

function world(): { root: string; dir: string; home: string; sockets: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-feed-')));
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamFile(root, lobbyDir(home)));
  return { root, dir: join(root, '.agents'), home, sockets };
}

function scripted(samples: string[]): NativePane {
  let read = 0;
  return {
    typeText: () => true,
    pressEnter: () => true,
    status: () => samples[Math.min(read++, samples.length - 1)] ?? 'idle',
    wait: async () => {},
  };
}

function hostFor(home: string, sockets: string, patch: Partial<SendHost> = {}): SendHost {
  return {
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'helper', pane: 'pane-helper' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (): Promise<SendOutcome> => ({ ok: true }),
    native: scripted(['idle', 'working']),
    now: () => NOW,
    home,
    ...patch,
  };
}

function recordSeat(dir: string, seat: string, pane: string): void {
  updateState(dir, (state) => {
    state.sessions.acme = {
      seats: { [seat]: { stage: 'launched', pane, workspace: 'w1' } },
      worktrees: {},
    };
  });
}

/** The agent record `up` writes for a launched seat: the identity admission reads, and the id
 *  the drop file's header names. */
function registerSeat(home: string, seat: string, role: string, cli = 'claude-code'): void {
  const id = `agt_${Buffer.from(seat).toString('hex').slice(0, 12).padEnd(12, '0')}`;
  const file = join(home, '.config', 'team', 'agents', `${id}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${id}"`,
      `name: "${seat}"`,
      'signing:',
      '  model: "Test"',
      '  version: "1"',
      `  role: "${role}"`,
      'lab: "test"',
      `cli: "${cli}"`,
      'launcher: null',
      'launch: "claude"',
      'reach:',
      '  team: "acme"',
      `  seat: "${seat}"`,
      '  session: "acme"',
      `  pane: "pane-${seat}"`,
      '  address: null',
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-05T04:00:00.000Z"',
      '  updated_at: "2026-10-05T04:00:00.000Z"',
      '',
    ].join('\n'),
  );
}

/** What the owner's send opens the filed body with: `senderHeader`'s owner line, then the empty
 *  line under it. The wording itself is pinned in send.test.ts and send-admit.test.ts. */
const OWNER_HEADER = 'from the owner — admitted by: the owner\n\n';

describe('team send history log & team feed', () => {
  test('writes 0600 JSONL under the state folder, never in a lobby or the repo, and an A->B send appears once', async () => {
    const { root, dir, home, sockets } = world();
    // A seat to its own team's orchestrator: the pair the authority rules admit without a grant.
    recordSeat(dir, 'helper', 'pane-helper');
    registerSeat(home, 'helper', 'implementer', 'codex');
    const host = hostFor(home, sockets);
    const callerIo = testIo(root, { kind: 'seat', name: 'helper', pane: 'pane-helper', session: 'acme' });

    const secret = 'distinctive-secret-payload';
    const code = await runSend(['lead', secret, '--json'], callerIo, host);
    expect(code).toBe(0);
    const sentDoc = JSON.parse(callerIo.out) as { ids: { sent: string } };

    const logPath = historyPath('acme', root, home);
    const store = storePath('acme', root, home);
    expect(logPath.startsWith(store)).toBe(true);
    expect(logPath.includes('.agents')).toBe(false);
    expect(logPath.includes('lobbies')).toBe(false);
    expect(statSync(store).mode & 0o777).toBe(0o700);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);

    const rawLines = readFileSync(logPath, 'utf8').trim().split('\n');
    expect(rawLines.length).toBe(1);
    const parsed = JSON.parse(rawLines[0] as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['body', 'failed', 'from', 'id', 'ms', 'outcome', 'thread', 'to', 'ts', 'via']);
    // The seat's send files the body under its header: the seat's readable name, and the rule.
    const seatHeader = 'from helper — admitted by: a seat to its own team\'s orchestrator\n\n';
    expect(parsed).toEqual({
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      body: `${seatHeader}${secret}`,
      id: sentDoc.ids.sent,
      outcome: 'delivered',
      // The thread is the first message's id; a first message is its own thread's id.
      thread: sentDoc.ids.sent,
      ms: 0,
      via: 'typed',
      // The walk landed on the typed leg through the inbox ahead of it: no server was listening.
      // The native leg is not in the order in force — the default is mcp-inbox, drop, typed — so
      // it is not walked, and nothing about it is recorded.
      failed: [
        'mcp-inbox: no live inbox listener',
      ],
    });

    // Team log in .agents/ keeps only byte counts, never the message body; lobbies stay empty.
    const teamLog = readFileSync(join(dir, LOG_FILE), 'utf8');
    expect(teamLog).not.toContain(secret);
    expect(existsSync(join(dir, 'messages.jsonl'))).toBe(false);
    expect(readdirSync(lobbyDir(home))).toEqual([]);

    // The table's KIND keeps the channel and the timing, and DETAIL folds the filed body's
    // header and blank line onto the one line its cell can hold.
    const feedIo = testIo(root);
    expect(await runFeed([], feedIo, { home })).toBe(0);
    expect(feedIo.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND                           SEAT            DETAIL\n' +
        `  15:30:00  delivered (via typed in 0 ms)  helper -> lead  ${seatHeader.split('\n')[0] ?? ''} ${secret}\n` +
        '1 event\n',
    );

    // One envelope, not one line per event; it carries the legs that failed before the typed one.
    const jsonIo = testIo(root);
    expect(await runFeed(['--json'], jsonIo, { home })).toBe(0);
    const doc = assertMatchesOutputSchema<FeedDoc>(jsonIo.out, FEED_OUTPUT_SCHEMA);
    expect(doc.schema).toEqual({ name: 'team.feed', version: 1 });
    expect(doc).toMatchObject({ format: 1, project: 'acme', session: 'acme' });
    expect(doc.events).toHaveLength(1);
    expect(doc.events[0]).toMatchObject({
      ts: NOW.toISOString(),
      from: 'helper',
      to: 'lead',
      id: sentDoc.ids.sent,
      outcome: 'delivered',
      ms: 0,
      via: 'typed',
    });
    expect(doc.events[0]?.failed).toEqual([
      'mcp-inbox: no live inbox listener',
    ]);
  });

  test('--json carries the address a send kept beside the seat, and the line keeps it', async () => {
    const { root, home } = world();
    const wrote = appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      spec: 'zeus@acme',
      resolved: 'agt_0123456789ab',
      body: `${OWNER_HEADER}addressed`,
      id: 'seed-addressed',
      outcome: 'delivered',
      via: 'typed',
    });
    expect(wrote.ok).toBe(true);

    const raw = readFileSync(historyPath('acme', root, home), 'utf8');
    expect(raw).toContain('"spec":"zeus@acme"');
    expect(raw).toContain('"resolved":"agt_0123456789ab"');

    const jsonIo = testIo(root);
    expect(await runFeed(['--json'], jsonIo, { home })).toBe(0);
    const jsonDoc = JSON.parse(jsonIo.out) as { events: Record<string, unknown>[] };
    expect(jsonDoc.events[0]?.to).toBe('lead');
    expect(jsonDoc.events[0]?.spec).toBe('zeus@acme');
    expect(jsonDoc.events[0]?.resolved).toBe('agt_0123456789ab');

    // A line that wrote neither keeps the shape it always had.
    appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: `${OWNER_HEADER}plain`,
      id: 'seed-plain',
      outcome: 'delivered',
      via: 'typed',
    });
    const plainIo = testIo(root);
    expect(await runFeed(['--limit', '1', '--json'], plainIo, { home })).toBe(0);
    const plainDoc = JSON.parse(plainIo.out) as { events: Record<string, unknown>[] };
    expect(Object.keys(plainDoc.events[0] ?? {}).sort()).toEqual(['body', 'from', 'id', 'outcome', 'status', 'to', 'ts', 'via']);
  });

  test('one message is one row: a later receipt replaces the unconfirmed line it updates', async () => {
    const { root, home } = world();
    const body = `${OWNER_HEADER}sweep the pane`;
    appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      spec: 'lead@acme',
      resolved: 'agt_0123456789ab',
      body,
      id: 'seed-inbox',
      outcome: 'sent (unconfirmed)',
      ms: 8,
      via: 'mcp-inbox',
    });
    appendHistory('acme', root, home, {
      ts: new Date(NOW.getTime() + 60_000).toISOString(),
      from: 'owner',
      to: 'lead',
      body,
      id: 'seed-inbox',
      outcome: 'delivered (read)',
      via: 'mcp-inbox',
    });

    // The batch shows the later outcome once, and the address the send recorded stays on it.
    const io = testIo(root);
    expect(await runFeed([], io, { home })).toBe(0);
    expect(io.out).toContain('1 event\n');
    expect(io.out).not.toContain('sent (unconfirmed)');
    expect((io.out.match(/owner -> lead/g) ?? []).length).toBe(1);
    expect((io.out.match(/delivered \(read\) \(via mcp-inbox\)/g) ?? []).length).toBe(1);
    // The milliseconds timed the send, not the receipt, so the row does not claim them.
    expect(io.out).not.toContain('in 8 ms');

    const jsonIo = testIo(root);
    expect(await runFeed(['--json'], jsonIo, { home })).toBe(0);
    const jsonDoc = JSON.parse(jsonIo.out) as { events: Record<string, unknown>[] };
    expect(jsonDoc.events).toHaveLength(1);
    expect(jsonDoc.events[0]).toMatchObject({ id: 'seed-inbox', outcome: 'delivered (read)', via: 'mcp-inbox' });
    expect(jsonDoc.events[0]?.spec).toBe('lead@acme');
    expect(jsonDoc.events[0]?.resolved).toBe('agt_0123456789ab');
    expect(jsonDoc.events[0]?.ms).toBeUndefined();
  });

  test('--follow prints an outcome update for an id it has already shown', async () => {
    const { root, home } = world();
    const body = `${OWNER_HEADER}follow the pane`;
    appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body,
      id: 'seed-follow',
      outcome: 'sent (unconfirmed)',
      via: 'mcp-inbox',
    });

    const io = testIo(root);
    const code = await runFeed(['--follow'], io, {
      home,
      poll: async (tick) => {
        if (tick === 0) {
          appendHistory('acme', root, home, {
            ts: new Date(NOW.getTime() + 60_000).toISOString(),
            from: 'owner',
            to: 'lead',
            body,
            id: 'seed-follow',
            outcome: 'delivered (read)',
            via: 'mcp-inbox',
          });
          return true;
        }
        return false;
      },
    });
    expect(code).toBe(0);
    expect((io.out.match(/sent \(unconfirmed\)/g) ?? []).length).toBe(1);
    expect((io.out.match(/delivered \(read\)/g) ?? []).length).toBe(1);
  });

  test('records delivered, answered, timeout, and unreachable; skips refused, --list, and --dry-run', async () => {
    const { root, home, sockets } = world();
    // A file at the measured socket name stands while every send below runs: no path consults it.
    writeFileSync(join(sockets, '222.sock'), '');

    // 1. refused (unknown seat), --list, --dry-run write nothing to messages.jsonl
    expect(await runSend(['ghost', 'nope'], testIo(root, { kind: 'owner' }), hostFor(home, sockets))).toBe(1);
    expect(await runSend(['--list'], testIo(root, { kind: 'owner' }), hostFor(home, sockets))).toBe(0);
    expect(await runSend(['native', 'dry', '--dry-run'], testIo(root, { kind: 'owner' }), hostFor(home, sockets))).toBe(0);
    expect(existsSync(historyPath('acme', root, home))).toBe(false);

    // 2. delivered
    expect(await runSend(['native', 'msg-delivered'], testIo(root, { kind: 'owner' }), hostFor(home, sockets))).toBe(0);

    // 3. unreachable
    expect(
      await runSend(
        ['native', 'msg-unreachable'],
        testIo(root, { kind: 'owner' }),
        hostFor(home, sockets, { agents: () => [] }),
      ),
    ).toBe(1);

    // 4. answered and timeout: a waited send that gets no reply within its window records timeout
    // with the thread open; answered is seeded alongside it so the feed renders both waited outcomes.
    appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: `${OWNER_HEADER}msg-answered`,
      id: 'seed-answered',
      outcome: 'answered',
      ms: 0,
      via: 'socket',
    });
    expect(
      await runSend(
        ['lead', 'msg-timeout', '--wait', '--timeout', '1'],
        testIo(root, { kind: 'owner' }),
        hostFor(home, sockets, { waitMs: 0 }),
      ),
    ).toBe(1);

    const read = readHistory('acme', root, home);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((e) => ({ from: e.from, to: e.to, body: e.body, outcome: e.outcome }))).toEqual([
      { from: 'owner', to: 'native', body: `${OWNER_HEADER}msg-delivered`, outcome: 'delivered' },
      { from: 'owner', to: 'native', body: `${OWNER_HEADER}msg-unreachable`, outcome: 'unreachable' },
      { from: 'owner', to: 'lead', body: `${OWNER_HEADER}msg-answered`, outcome: 'answered' },
      { from: 'owner', to: 'lead', body: `${OWNER_HEADER}msg-timeout`, outcome: 'timeout' },
    ]);
  });

  test('tightens a 0644 history log back to 0600 and refuses a planted symlink', async () => {
    const { root, home } = world();
    const logPath = historyPath('acme', root, home);
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    writeFileSync(logPath, '', { mode: 0o644 });
    chmodSync(logPath, 0o644);
    expect(statSync(logPath).mode & 0o777).toBe(0o644);

    const wrote = appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: 'tightened',
      id: 'id-1',
      outcome: 'delivered',
    });
    expect(wrote.ok).toBe(true);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);

    // Replace messages.jsonl with a symlink to a target file; neither appendHistory nor team feed follows it.
    const victim = join(base, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    rmSync(logPath);
    symlinkSync(victim, logPath);
    expect(lstatSync(logPath).isSymbolicLink()).toBe(true);

    const refusedWrite = appendHistory('acme', root, home, {
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: 'should-not-land',
      id: 'id-2',
      outcome: 'delivered',
    });
    expect(refusedWrite).toEqual({ ok: false, reason: 'a symbolic link was found and not followed' });
    expect(readFileSync(victim, 'utf8')).toBe('untouched\n');

    const io = testIo(root);
    expect(await runFeed([], io, { home })).toBe(1);
    expect(io.err).toContain('the history log cannot be read: a symbolic link was found and not followed');

    // Under `--json` the same refusal is one team.error document on stdout, stderr empty.
    const json = testIo(root);
    expect(await runFeed(['--json'], json, { home })).toBe(1);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, {
      id: 'feed.unreadable',
      messageContains: 'the history log cannot be read: a symbolic link was found and not followed',
    });
  });

  test('--follow and --json are refused: the error document --json asks for', async () => {
    const { root, home } = world();
    const io = testIo(root);
    expect(await runFeed(['--follow', '--json'], io, { home })).toBe(2);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, {
      id: 'feed.usage',
      messageContains: "--follow and --json can't be used together",
    });
  });

  test('--json writes one team.feed document, names no team outside a checkout, and every refusal is a team.error', async () => {
    const { root, home } = world();
    const empty = testIo(root);
    expect(await runFeed(['--json'], empty, { home })).toBe(0);
    expect(assertMatchesOutputSchema<FeedDoc>(empty.out, FEED_OUTPUT_SCHEMA)).toMatchObject({
      format: 1,
      project: 'acme',
      session: 'acme',
      events: [],
    });

    // A run outside any checkout with --all is not team-scoped: the document names no team.
    const all = testIo(base);
    expect(await runFeed(['--all', '--json'], all, { home })).toBe(0);
    expect(assertMatchesOutputSchema<FeedDoc>(all.out, FEED_OUTPUT_SCHEMA)).toMatchObject({
      project: null,
      session: null,
      events: [],
    });

    // Outside any checkout the refusal names only the project: feed takes no --file.
    const plain = testIo(base);
    expect(await runFeed([], plain, { home })).toBe(2);
    expect(plain.err).toBe('team feed: not inside a git repository: run team from a project\n');

    const noFile = testIo(base);
    expect(await runFeed(['--json'], noFile, { home })).toBe(2);
    expect(noFile.err).toBe('');
    assertJsonErrorShape(noFile.out, { id: 'feed.configuration', messageContains: 'not inside a git repository: run team from a project' });
    expect(noFile.out).not.toContain('--file');

    const usage = testIo(root);
    expect(await runFeed(['--json', 'extra'], usage, { home })).toBe(2);
    expect(usage.err).toBe('');
    assertJsonErrorShape(usage.out, { id: 'feed.usage', messageContains: 'unexpected "extra"' });

    // The raw argv is scanned before the parser runs: an unknown option ahead of `--json`, or a
    // `--json=<value>` the parser refuses, still writes the error document and leaves stderr empty.
    const nope = testIo(root);
    expect(await runFeed(['--nope', '--json'], nope, { home })).toBe(2);
    expect(nope.err).toBe('');
    assertJsonErrorShape(nope.out, { id: 'feed.usage', messageContains: 'unknown option --nope' });

    const inline = testIo(root);
    expect(await runFeed(['--json=1'], inline, { home })).toBe(2);
    expect(inline.err).toBe('');
    assertJsonErrorShape(inline.out, { id: 'feed.usage', messageContains: 'unknown option --json' });

    const badLimit = testIo(root);
    expect(await runFeed(['--json', '--limit', '0'], badLimit, { home })).toBe(2);
    expect(badLimit.err).toBe('');
    assertJsonErrorShape(badLimit.out, { id: 'feed.usage', messageContains: '--limit takes a whole number' });
  });

  test('rotates at 1 MB keeping 3 files at mode 0600, and team feed --follow streams across rotation', async () => {
    const { root, home } = world();
    const logPath = historyPath('acme', root, home);
    const chunk = 'x'.repeat(250_000);

    // Write 9 entries (~2.25 MB total) so it rotates twice into .1 and .2
    for (let i = 1; i <= 9; i++) {
      const res = appendHistory('acme', root, home, {
        ts: new Date(NOW.getTime() + i * 1000).toISOString(),
        from: 'lead',
        to: 'helper',
        body: `${String(i)}:${chunk}`,
        id: `id-${String(i)}`,
        outcome: 'delivered',
      });
      expect(res.ok).toBe(true);
    }

    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(`${logPath}.2`)).toBe(true);
    expect(existsSync(`${logPath}.3`)).toBe(false);
    expect(statSync(logPath).size).toBeLessThanOrEqual(MAX_HISTORY_BYTES);
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${logPath}.1`).mode & 0o777).toBe(0o600);
    expect(statSync(`${logPath}.2`).mode & 0o777).toBe(0o600);

    // Follow mode across another rotation: the opening batch is the last line before it, and
    // the pass that crosses the rotation prints the four events it brought as its own table.
    const followIo = testIo(root);
    const code = await runFeed(['--limit', '1', '--follow'], followIo, {
      home,
      poll: async (tick) => {
        if (tick === 0) {
          // Force a rotation during --follow by writing 4 more large entries
          for (let j = 10; j <= 13; j++) {
            appendHistory('acme', root, home, {
              ts: new Date(NOW.getTime() + j * 1000).toISOString(),
              from: 'lead',
              to: 'helper',
              body: `followed-${String(j)}:${'z'.repeat(240_000)}`,
              id: `id-${String(j)}`,
              outcome: 'delivered',
            });
          }
          return true;
        }
        return false;
      },
    });
    expect(code).toBe(0);
    expect((followIo.out.match(/^ *TIME +KIND +SEAT +DETAIL$/gm) ?? []).length).toBe(2);
    expect((followIo.out.match(/team acme, session "acme"/g) ?? []).length).toBe(1);
    expect(followIo.out).toContain('1 event\n');
    expect(followIo.out).toContain('4 events\n');
    expect(followIo.out).toContain(`9:${chunk}`);
    for (let j = 10; j <= 13; j++) {
      expect(followIo.out).toContain(`followed-${String(j)}:${'z'.repeat(240_000)}`);
    }
  });

  test('filters by --seat, respects --limit, and merges briefs/*-to-*.md and audit.jsonl', async () => {
    const { root, home } = world();
    appendHistory('acme', root, home, {
      ts: '2026-10-14T15:00:01.000Z',
      from: 'lead',
      to: 'helper',
      body: 'first task',
      id: 'm1',
      outcome: 'delivered',
    });
    appendHistory('acme', root, home, {
      ts: '2026-10-14T15:00:03.000Z',
      from: 'lead',
      to: 'native',
      body: 'second task\nline two',
      id: 'm2',
      outcome: 'delivered',
    });

    const briefsDir = join(root, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    const briefFile = join(briefsDir, 'iris-to-atlas.md');
    writeFileSync(briefFile, 'handoff note\n');
    const briefTime = new Date('2026-10-14T15:00:02.000Z');
    utimesSync(briefFile, briefTime, briefTime);

    const auditPath = join(base, 'audit.jsonl');
    writeFileSync(
      auditPath,
      `${JSON.stringify({ ts: '2026-10-14T15:00:04.000Z', caller: 'desk', seat: 'lead', question: 'status check', request_id: 'req-1', event: 'verified' })}\n`,
    );

    const allIo = testIo(root);
    expect(await runFeed([], allIo, { home, auditPath })).toBe(0);
    expect(allIo.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND       SEAT            DETAIL\n' +
        '  15:00:01  delivered  lead -> helper  first task\n' +
        '  15:00:02  brief      iris -> atlas   handoff note\n' +
        '  15:00:03  delivered  lead -> native  second task line two\n' +
        '  15:00:04  verified   desk -> lead    status check\n' +
        '4 events\n',
    );

    const seatIo = testIo(root);
    expect(await runFeed(['--seat', 'helper'], seatIo, { home, auditPath })).toBe(0);
    expect(seatIo.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND       SEAT            DETAIL\n' +
        '  15:00:01  delivered  lead -> helper  first task\n' +
        '1 event\n',
    );

    const limitIo = testIo(root);
    expect(await runFeed(['--limit', '2', '--json'], limitIo, { home, auditPath })).toBe(0);
    expect(assertMatchesOutputSchema<FeedDoc>(limitIo.out, FEED_OUTPUT_SCHEMA).events.map((event) => event.id)).toEqual([
      'm2',
      'req-1',
    ]);
  });

  test('parses multi-section briefs/*-to-*.md with ## <ISO-8601> — From <Sender> headers in chronological order', async () => {
    const { root, home } = world();
    const briefsDir = join(root, 'briefs');
    mkdirSync(briefsDir, { recursive: true });
    writeFileSync(
      join(briefsDir, 'lead-to-worker.md'),
      [
        '# Lead -> Worker',
        '',
        '## 2026-10-14T15:00:01Z — From Lead: Round 1',
        '',
        'First brief section from Lead.',
        '',
        '---',
        '',
        '## 2026-10-14T15:00:05Z — From Worker: Round 1 Reply',
        '',
        'Reply section from Worker in the same file.',
        '',
      ].join('\n'),
    );

    const io = testIo(root);
    expect(await runFeed([], io, { home })).toBe(0);
    expect(io.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND   SEAT            DETAIL\n' +
        '  15:00:01  brief  lead -> worker  Round 1: First brief section from Lead.\n' +
        '  15:00:05  brief  worker -> lead  Round 1 Reply: Reply section from Worker in the same file.\n' +
        '2 events\n',
    );
  });

  test('streams across all project state folders (--all or outside a repo) and discovers Desk lobby guard/bridge audit and signed answers without touching files', async () => {
    const { root, home } = world();
    const otherRoot = join(base, 'other-repo');
    mkdirSync(otherRoot, { recursive: true });

    appendHistory('acme', root, home, {
      ts: '2026-10-14T16:00:01.000Z',
      from: 'lead',
      to: 'helper',
      body: 'acme message',
      id: 'acme-1',
      outcome: 'delivered',
    });
    appendHistory('beacon', otherRoot, home, {
      ts: '2026-10-14T16:00:02.000Z',
      from: 'keeper',
      to: 'reviewer',
      body: 'beacon message',
      id: 'beacon-1',
      outcome: 'delivered',
    });

    // Set up a Desk lobby guard subdir with guard.json, seat-reply-config.json, audit.jsonl, and answers/req-9.json
    const guardSubdir = join(lobbyDir(home), 'guard');
    const answersDir = join(guardSubdir, 'answers');
    mkdirSync(answersDir, { recursive: true });
    const lobbyAudit = join(guardSubdir, 'audit.jsonl');
    writeFileSync(
      join(guardSubdir, 'guard.json'),
      JSON.stringify({ target_alias: 'orchestrator', audit_file: lobbyAudit }),
    );
    writeFileSync(
      join(guardSubdir, 'seat-reply-config.json'),
      JSON.stringify({ seat_alias: 'orchestrator', answer_dir: answersDir }),
    );
    const auditContent = `${JSON.stringify({ ts: '2026-10-14T16:00:03.000Z', event: 'accepted', request_id: 'req-9' })}\n`;
    writeFileSync(lobbyAudit, auditContent);
    const answerFile = join(answersDir, 'req-9.json');
    const answerContent = JSON.stringify({
      request_id: 'req-9',
      seat: 'orchestrator',
      caller: 'desk',
      ts: '2026-10-14T16:00:04.000Z',
      summary: 'gate approved',
    });
    writeFileSync(answerFile, answerContent);

    // Running outside any git checkout (e.g. from the Desk lobby directory) merges all projects + Desk lobby records
    // Outside any checkout there is no team to name: no context line, and the table starts at
    // column 0.
    const deskPaneIo = testIo(lobbyDir(home));
    expect(await runFeed([], deskPaneIo, { home })).toBe(0);
    expect(deskPaneIo.out).toBe(
      'TIME      KIND       SEAT                  DETAIL\n' +
        '16:00:01  delivered  lead -> helper        acme message\n' +
        '16:00:02  delivered  keeper -> reviewer    beacon message\n' +
        '16:00:03  accepted   desk -> orchestrator  accepted (req-9)\n' +
        '16:00:04  answered   orchestrator -> desk  gate approved\n' +
        '4 events\n',
    );

    // Running inside `acme` with `--all`, `--audit`, and `--briefs` flags
    const customBriefs = join(base, 'custom-briefs');
    mkdirSync(customBriefs, { recursive: true });
    const briefPath = join(customBriefs, 'desk-to-lead.md');
    writeFileSync(briefPath, 'custom brief line\n');
    const briefTime = new Date('2026-10-14T16:00:05.000Z');
    utimesSync(briefPath, briefTime, briefTime);

    const customAudit = join(base, 'custom-audit.jsonl');
    writeFileSync(
      customAudit,
      `${JSON.stringify({ ts: '2026-10-14T16:00:06.000Z', from: 'desk', to: 'lead', body: 'explicit audit line', id: 'aud-1', event: 'forwarded' })}\n`,
    );

    const flagIo = testIo(root);
    expect(
      await runFeed(['--all', '--briefs', customBriefs, '--audit', customAudit], flagIo, { home }),
    ).toBe(0);
    expect(flagIo.out).toBe(
      'team acme, session "acme"\n' +
        '  TIME      KIND       SEAT                  DETAIL\n' +
        '  16:00:01  delivered  lead -> helper        acme message\n' +
        '  16:00:02  delivered  keeper -> reviewer    beacon message\n' +
        '  16:00:03  accepted   desk -> orchestrator  accepted (req-9)\n' +
        '  16:00:04  answered   orchestrator -> desk  gate approved\n' +
        '  16:00:05  brief      desk -> lead          custom brief line\n' +
        '  16:00:06  forwarded  desk -> lead          explicit audit line\n' +
        '6 events\n',
    );

    // Desk ask/answer and audit files remain untouched (read-only)
    expect(readFileSync(lobbyAudit, 'utf8')).toBe(auditContent);
    expect(readFileSync(answerFile, 'utf8')).toBe(answerContent);
  });
});

