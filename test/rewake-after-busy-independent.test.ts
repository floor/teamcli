// Independent verification for fix/rewake-after-busy:
// 1. A seat busy at send time that goes idle with the grey Muse `/goal` placeholder
//    (`/goal pins a session objective with a progress bar`) is woken within the unread window
//    by driving `wakeUnreadDrops` through `deliverTypedWake` against a fake host.
// 2. The `grok` truecolor edge (`test/fixtures/grok/1.0.50/idle-ansi.txt`) reads `idle`.
// 3. A grey draft, a bold word, a second colour, and an inverse cursor all stay `unsent`
//    and are never typed into.
// 4. A webhook seat whose first post returned (`.posted` exists and history has `via: 'webhook'`)
//    but whose drop stays unread is posted once more with the same id, and never a third time.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oneColourAfter } from '../src/ansi.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { boxHoldsText } from '../src/launch/deliver.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { appendHistory, readHistory } from '../src/send/history.ts';
import { dropMessage } from '../src/send/native.ts';
import { signRecord } from '../src/send/record.ts';
import { deliverTypedWake, type TypedWakeHost, type TypedWakeResult } from '../src/send/typed-wake.ts';
import type { Live } from '../src/status/compare.ts';
import type { RetrySources } from '../src/watch/retry.ts';
import { classifyComposer, readBox, readScreen } from '../src/watch/screen.ts';
import { wakePath, wakeTryPath, wakeUnreadDrops } from '../src/watch/unread.ts';

const MUSE_FIXTURES = join(import.meta.dir, 'fixtures', 'muse', '1.4.11');
const MUSE_IDLE = readFileSync(join(MUSE_FIXTURES, 'idle.txt'), 'utf8');
const MUSE_WORKING = readFileSync(join(MUSE_FIXTURES, 'working-synthetic.txt'), 'utf8');
const GROK_IDLE_ANSI = readFileSync(join(import.meta.dir, 'fixtures', 'grok', '1.0.50', 'idle-ansi.txt'), 'utf8');

const GOAL_PLACEHOLDER = '/goal pins a session objective with a progress bar';
const NOW = new Date('2026-10-17T04:00:00.000Z');
const MIN = 60_000;
const UNREAD_WINDOW = 600;
const MSG_A = 'aaaaaaaa-0000-4000-8000-000000000201';
const MSG_B = 'bbbbbbbb-0000-4000-8000-000000000202';
const FAST = { settleMs: 1, enterSettleMs: 1, pollMs: 1, verifyMs: 1 };

let scratchBase = '';
const hookStops: (() => unknown)[] = [];

afterEach(() => {
  for (const stop of hookStops.splice(0)) stop();
  if (scratchBase) {
    rmSync(scratchBase, { recursive: true, force: true });
    scratchBase = '';
  }
});

function museHolding(inputContent: string): string {
  return MUSE_IDLE.replace('❯\n', `❯ ${inputContent}\n`);
}

function makeFakeWakeHost(
  screenAt: (readIndex: number, enters: number, typed: readonly string[]) => string | null,
): { host: TypedWakeHost; typed: string[]; enters: number; reads: number } {
  const typed: string[] = [];
  let enters = 0;
  let reads = 0;
  const host: TypedWakeHost = {
    read: () => screenAt(reads++, enters, typed),
    type: (_pane: string, text: string) => {
      typed.push(text);
      return true;
    },
    enter: () => {
      enters += 1;
      return true;
    },
    wait: async () => {},
  };
  return {
    host,
    typed,
    get enters() {
      return enters;
    },
    get reads() {
      return reads;
    },
  };
}

type World = { root: string; dir: string; home: string };

function museTeamYaml(root: string, lobby: string, webhookExtra = ''): string {
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
    cli: muse
    vendor: meta
    model: Muse Wonder Full
    version: "1"
    launch: muse
${webhookExtra}`;
}

function makeWorld(webhookExtra = ''): { made: World; team: ReturnType<typeof parseTeam> } {
  scratchBase = realpathSync(mkdtempSync(join(tmpdir(), 'team-rewake-busy-')));
  const root = join(scratchBase, 'acme');
  const home = join(scratchBase, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const yaml = museTeamYaml(root, lobbyDir(home), webhookExtra);
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
  return {
    made: { root, dir: join(root, '.agents'), home },
    team: parseTeam(yaml),
  };
}

function parseTeam(text: string) {
  const res = validateTeamFile(text);
  if (!res.ok) throw new Error(JSON.stringify(res.errors));
  return res.team;
}

function seedUnreadDrop(at: World, seat: string, id: string, body: string, ts: Date): string {
  const dropDir = join(at.dir, 'send-drops', 'acme', seat);
  const record = signRecord(
    {
      kind: 'message',
      id,
      to: seat,
      to_id: null,
      root: realpathSync(at.root),
      session: 'acme',
      at: ts.toISOString(),
      body,
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      thread: id,
    },
    at.home,
  );
  dropMessage(dropDir, id, `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(join(dropDir, id), new Date(), ts);
  return dropDir;
}

function seedSendHistory(at: World, seat: string, id: string, line: { via?: string; failed?: string[] }): void {
  const wrote = appendHistory('acme', at.root, at.home, {
    ts: new Date(NOW.getTime() - 11 * MIN).toISOString(),
    from: 'owner',
    to: seat,
    body: `work ${id}`,
    id,
    outcome: 'delivered',
    ms: 4,
    ...line,
  });
  if (!wrote.ok) throw new Error(wrote.reason);
}

function historyFor(at: World, id: string) {
  const read = readHistory('acme', at.root, at.home);
  if (!read.ok) throw new Error(read.reason);
  return read.entries.filter((entry) => entry.id === id);
}

function wakeMarkerOf(at: World, seat: string, id: string): Record<string, unknown> | null {
  const path = wakePath(join(at.dir, 'send-drops', 'acme', seat), id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function liveHelper(status = 'idle'): Live {
  const agents: HerdrAgent[] = [
    { name: 'helper', agent: 'muse', pane: 'helper:pane', workspace: 'first', status, cwd: null },
    { name: 'lead', agent: 'claude', pane: 'lead:pane', workspace: 'lead', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

type HookHit = { method: string; authorization: string; body: string };

function startHookServer(answer: (hit: HookHit) => Response = () => new Response('ok')): { url: string; hits: HookHit[] } {
  const hits: HookHit[] = [];
  const state = { url: '', hits };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const hit: HookHit = {
        method: request.method,
        authorization: request.headers.get('authorization') ?? '',
        body: await request.text(),
      };
      hits.push(hit);
      return answer(hit);
    },
  });
  hookStops.push(() => server.stop(true));
  state.url = `http://127.0.0.1:${String(server.port)}/routine`;
  return state;
}

describe('1. busy Muse seat going idle with grey /goal placeholder wakes within the unread window', () => {
  test('wakeUnreadDrops skips while Muse seat is working, then drives deliverTypedWake when idle with grey /goal placeholder', async () => {
    const { made, team } = makeWorld();
    const dropDir = seedUnreadDrop(
      made,
      'helper',
      MSG_A,
      'please check the release notes',
      new Date(NOW.getTime() - 11 * MIN),
    );
    seedSendHistory(made, 'helper', MSG_A, { via: 'typed' });

    const greyGoalIdle = museHolding(`\x1b[90m${GOAL_PLACEHOLDER}\x1b[0m`);
    let seatBusy = true;

    const fake = makeFakeWakeHost((_readIdx, enters, typed) => {
      if (seatBusy) return MUSE_WORKING;
      if (enters >= 1) return MUSE_WORKING;
      if (typed.length >= 1) return museHolding(typed[typed.length - 1]!);
      return greyGoalIdle;
    });

    const said: string[] = [];
    const sources: RetrySources = {
      screen: () => (seatBusy ? MUSE_WORKING : greyGoalIdle),
      status: () => (seatBusy ? 'working' : 'idle'),
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      typedWake: (paneId, line, cli, _session) =>
        deliverTypedWake(fake.host, paneId, line, cli, FAST),
    };

    // Pass 1: Seat was busy at send time and is still busy when the unread window opens.
    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('working'),
        ownPane: null,
        sources,
        now: NOW,
        say: (text) => said.push(text),
      },
      { unreadAfter: UNREAD_WINDOW },
    );

    expect(fake.typed).toEqual([]);
    expect(fake.enters).toBe(0);
    expect(wakeMarkerOf(made, 'helper', MSG_A)).toBeNull();
    expect(existsSync(wakeTryPath(dropDir, MSG_A))).toBe(false);

    // Pass 2: Seat finishes its turn and goes idle with the grey `/goal` placeholder.
    seatBusy = false;
    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('idle'),
        ownPane: null,
        sources,
        now: new Date(NOW.getTime() + 15_000),
        say: (text) => said.push(text),
      },
      { unreadAfter: UNREAD_WINDOW },
    );

    expect(fake.typed).toHaveLength(1);
    expect(fake.typed[0]).toContain('Message from owner');
    expect(fake.enters).toBe(1);
    expect(wakeMarkerOf(made, 'helper', MSG_A)).toMatchObject({
      id: MSG_A,
      state: 'sent',
    });
    const history = historyFor(made, MSG_A);
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      to: 'helper',
      id: MSG_A,
      via: 'typed',
      outcome: 'delivered (typed wake)',
    });

    // Pass 3: Subsequent pass sees `.wake` and does not wake a second time.
    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('idle'),
        ownPane: null,
        sources,
        now: new Date(NOW.getTime() + 30_000),
        say: (text) => said.push(text),
      },
      { unreadAfter: UNREAD_WINDOW },
    );
    expect(fake.typed).toHaveLength(1);
    expect(fake.enters).toBe(1);
  });

  test('256-colour (38;5;244) and truecolor (38;2;103;108;116) grey Muse listed placeholders also read idle and wake', async () => {
    const palettes = [
      `\x1b[90m${GOAL_PLACEHOLDER}\x1b[0m`,
      `\x1b[38;5;244m${GOAL_PLACEHOLDER}\x1b[0m`,
      `\x1b[38;2;103;108;116m${GOAL_PLACEHOLDER}\x1b[39m`,
      '\x1b[90m/tasks shows your open tasks\x1b[0m',
      '\x1b[38;5;244m/tasks shows workflows, subagents and terminals in one place\x1b[0m',
      '\x1b[38;2;103;108;116mTab queues or steers while a run is active\x1b[0m',
    ];

    for (const styled of palettes) {
      const frame = museHolding(styled);
      expect(readScreen('muse', frame).kind).toBe('idle');
      expect(classifyComposer('muse', frame.split('\n')).kind).toBe('idle');
      expect(readBox('muse', frame)).toBeNull();

      const fake = makeFakeWakeHost((_readIdx, enters, typed) => {
        if (enters >= 1) return MUSE_WORKING;
        if (typed.length >= 1) return museHolding(typed[0]!);
        return frame;
      });
      const res = await deliverTypedWake(
        fake.host,
        'pane-muse',
        'Read /t/mail/msg-01 and act on it.',
        'muse',
        FAST,
      );
      expect(res.delivered).toBe(true);
      expect(res.typed).toBe(true);
      expect(fake.typed).toEqual(['Read /t/mail/msg-01 and act on it.']);
      expect(fake.enters).toBe(1);
    }
  });
});

describe('2. grok truecolor edge fixture reads idle', () => {
  test('test/fixtures/grok/1.0.50/idle-ansi.txt reads idle and empty box, while a truecolor draft inside the box stays unsent', () => {
    expect(readScreen('grok', GROK_IDLE_ANSI).kind).toBe('idle');
    expect(classifyComposer('grok', GROK_IDLE_ANSI.split('\n')).kind).toBe('idle');
    expect(readBox('grok', GROK_IDLE_ANSI)).toBeNull();
    expect(boxHoldsText('grok', '│', GROK_IDLE_ANSI)).toBe(false);

    // If a truecolor grey draft stands before the closing `│` edge, Grok reads `unsent`.
    const grokDraft = GROK_IDLE_ANSI.replace(
      '\x1b[38;2;200;200;200m\x1b[48;2;20;20;20m❯ \x1b[0m\x1b[38;2;225;225;225m\x1b[48;2;20;20;20m                                            ',
      '\x1b[38;2;200;200;200m\x1b[48;2;20;20;20m❯ \x1b[0m\x1b[38;2;80;80;88m\x1b[48;2;20;20;20mfix the socket test                         ',
    );
    expect(readScreen('grok', grokDraft).kind).toBe('unsent');
    expect(readBox('grok', grokDraft)?.first).toBe('fix the socket test');
    expect(boxHoldsText('grok', 'fix the socket test', grokDraft)).toBe(true);
  });
});

describe('3. grey draft, bold word, second colour, and inverse cursor stay unsent and are never typed into', () => {
  const unsentCases: Array<{ label: string; styledInput: string; expectedText: string }> = [
    {
      label: 'grey draft (SGR 90 non-listed prose)',
      styledInput: '\x1b[90mfix the retry loop in unread wake\x1b[0m',
      expectedText: 'fix the retry loop in unread wake',
    },
    {
      label: 'grey draft (256-colour 38;5;244 non-listed prose)',
      styledInput: '\x1b[38;5;244mcheck the webhook claim state\x1b[0m',
      expectedText: 'check the webhook claim state',
    },
    {
      label: 'grey draft (truecolor 38;2;120;125;130, not the declared hint colour)',
      styledInput: '\x1b[38;2;120;125;130mship the patch\x1b[0m',
      expectedText: 'ship the patch',
    },
    {
      label: 'grey draft (/goal placeholder with extra user words appended)',
      styledInput: `\x1b[90m${GOAL_PLACEHOLDER} today\x1b[0m`,
      expectedText: `${GOAL_PLACEHOLDER} today`,
    },
    {
      label: 'bold word (entire /goal text in bold grey SGR 1;90)',
      styledInput: `\x1b[1;90m${GOAL_PLACEHOLDER}\x1b[0m`,
      expectedText: GOAL_PLACEHOLDER,
    },
    {
      label: 'bold word (single bold word inside grey /goal text)',
      styledInput: '\x1b[90m/goal \x1b[1mpins\x1b[22;90m a session objective with a progress bar\x1b[0m',
      expectedText: GOAL_PLACEHOLDER,
    },
    {
      label: 'second colour (SGR 90 switching to 38;5;244 mid-placeholder)',
      styledInput: '\x1b[90m/goal pins \x1b[38;5;244ma session objective with a progress bar\x1b[0m',
      expectedText: GOAL_PLACEHOLDER,
    },
    {
      label: 'second colour (two distinct truecolor greys across /goal text)',
      styledInput:
        '\x1b[38;2;103;108;116m/goal\x1b[38;2;120;125;130m pins a session objective with a progress bar\x1b[0m',
      expectedText: GOAL_PLACEHOLDER,
    },
    {
      label: 'second colour (default foreground switching to SGR 90 mid-placeholder)',
      styledInput: '/goal \x1b[90mpins a session objective with a progress bar\x1b[0m',
      expectedText: GOAL_PLACEHOLDER,
    },
    {
      label: 'inverse cursor (SGR 7 cell at start of grey /goal placeholder)',
      styledInput: '\x1b[90;7m/\x1b[27mgoal pins a session objective with a progress bar\x1b[0m',
      expectedText: GOAL_PLACEHOLDER,
    },
    {
      label: 'inverse cursor (SGR 7 cell mid-word in grey /goal placeholder)',
      styledInput: '\x1b[90m/goal \x1b[7mp\x1b[27mins a session objective with a progress bar\x1b[0m',
      expectedText: GOAL_PLACEHOLDER,
    },
  ];

  test('every case reads unsent in readScreen, classifyComposer, and readBox', () => {
    for (const item of unsentCases) {
      const frame = museHolding(item.styledInput);
      expect(readScreen('muse', frame).kind).toBe('unsent');
      expect(classifyComposer('muse', frame.split('\n')).kind).toBe('unsent');
      const box = readBox('muse', frame);
      expect(box).not.toBeNull();
      expect(box?.first).toBe(item.expectedText);
    }
  });

  test('oneColourAfter rejects bold, inverse, and multi-colour spans while accepting uniform non-bold colour', () => {
    expect(oneColourAfter(`❯ \x1b[90m${GOAL_PLACEHOLDER}\x1b[0m`, 1)).toBe(true);
    expect(oneColourAfter(`❯ \x1b[38;5;244m${GOAL_PLACEHOLDER}\x1b[0m`, 1)).toBe(true);
    expect(oneColourAfter(`❯ \x1b[38;2;103;108;116m${GOAL_PLACEHOLDER}\x1b[39m`, 1)).toBe(true);

    // Bold word, second colour, and inverse cell all fail oneColourAfter.
    expect(oneColourAfter('❯ \x1b[90m/goal \x1b[1mpins\x1b[22;90m a session\x1b[0m', 1)).toBe(false);
    expect(oneColourAfter('❯ \x1b[90m/goal \x1b[38;5;244mpins a session\x1b[0m', 1)).toBe(false);
    expect(oneColourAfter('❯ \x1b[90;7m/\x1b[27mgoal pins a session\x1b[0m', 1)).toBe(false);
  });

  test('neither deliverTypedWake nor wakeUnreadDrops ever types into or presses Enter on any of the unsent cases', async () => {
    const { made, team } = makeWorld();
    const dropDir = seedUnreadDrop(
      made,
      'helper',
      MSG_A,
      'do not clobber the user draft',
      new Date(NOW.getTime() - 11 * MIN),
    );
    seedSendHistory(made, 'helper', MSG_A, { via: 'typed' });

    for (const item of unsentCases) {
      const frame = museHolding(item.styledInput);
      const fake = makeFakeWakeHost(() => frame);

      // Direct deliverTypedWake call refuses immediately on read 0.
      const direct: TypedWakeResult = await deliverTypedWake(
        fake.host,
        'helper:pane',
        'Read /t/mail/msg-01 and act on it.',
        'muse',
        FAST,
      );
      expect(direct.delivered).toBe(false);
      expect(direct.typed).toBe(false);
      expect(direct.tries).toBe(0);
      expect(fake.typed).toEqual([]);
      expect(fake.enters).toBe(0);

      // Full wakeUnreadDrops pass also refuses and leaves no wake reservation.
      const sources: RetrySources = {
        screen: () => frame,
        status: () => 'idle',
        typeText: () => false,
        pressEnter: () => false,
        sleep: async () => {},
        typedWake: (paneId, line, cli, _session) =>
          deliverTypedWake(fake.host, paneId, line, cli, FAST),
      };

      await wakeUnreadDrops(
        {
          dir: made.dir,
          session: 'acme',
          root: made.root,
          home: made.home,
          team,
          live: liveHelper('idle'),
          ownPane: null,
          sources,
          now: NOW,
          say: () => {},
        },
        { unreadAfter: UNREAD_WINDOW },
      );

      expect(fake.typed).toEqual([]);
      expect(fake.enters).toBe(0);
      expect(wakeMarkerOf(made, 'helper', MSG_A)).toBeNull();
      expect(existsSync(wakeTryPath(dropDir, MSG_A))).toBe(false);
    }
  });
});

describe('4. webhook seat with .posted and via: webhook is re-posted once with the same id and never a third time', () => {
  function makeWebhookWorld(url: string) {
    scratchBase = realpathSync(mkdtempSync(join(tmpdir(), 'team-rewake-hook-')));
    const root = join(scratchBase, 'acme');
    const home = join(scratchBase, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home, { recursive: true });
    mkdirSync(lobbyDir(home), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });

    const hookDir = join(home, 'hook');
    mkdirSync(hookDir, { recursive: true });
    const urlFile = join(hookDir, 'url');
    const secretFile = join(hookDir, 'secret');
    writeFileSync(urlFile, `${url}\n`);
    writeFileSync(secretFile, 'synthetic-watch-secret\n', { mode: 0o600 });
    chmodSync(secretFile, 0o600);

    const webhookBlock = `    webhook:
      url_file: ${JSON.stringify(urlFile)}
      secret_file: ${JSON.stringify(secretFile)}
      body: inbox
`;
    const yaml = museTeamYaml(root, lobbyDir(home), webhookBlock);
    writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
    return {
      made: { root, dir: join(root, '.agents'), home },
      team: parseTeam(yaml),
    };
  }

  test('unread webhook drop with .posted is posted once more with the same id, writes .wake, and never posts a third time', async () => {
    const receiver = startHookServer();
    const { made, team } = makeWebhookWorld(receiver.url);
    const dropDir = seedUnreadDrop(
      made,
      'helper',
      MSG_A,
      'first webhook returned 200 but session stayed unread',
      new Date(NOW.getTime() - 11 * MIN),
    );
    seedSendHistory(made, 'helper', MSG_A, { via: 'webhook' });
    writeFileSync(join(dropDir, `${MSG_A}.posted`), `${NOW.toISOString()}\n`);

    const typedCalls: string[] = [];
    const sources: RetrySources = {
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      typedWake: async (_pane, line) => {
        typedCalls.push(line);
        return { delivered: true, typed: true, tries: 1, reason: 'unexpected' };
      },
    };

    // First unread pass: re-posts once with the same message id, writes .wake, does not call typedWake.
    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('idle'),
        ownPane: null,
        sources,
        now: NOW,
        say: () => {},
      },
      { unreadAfter: UNREAD_WINDOW },
    );

    expect(receiver.hits).toHaveLength(1);
    expect(receiver.hits[0]?.method).toBe('POST');
    const payload = JSON.parse(receiver.hits[0]!.body) as { id?: string; message?: { id?: string } };
    expect(payload.id ?? payload.message?.id ?? receiver.hits[0]!.body).toContain(MSG_A);
    expect(typedCalls).toEqual([]);
    expect(wakeMarkerOf(made, 'helper', MSG_A)).toMatchObject({
      id: MSG_A,
      state: 'sent',
      evidence: 'webhook',
    });

    const historyAfterFirstPass = historyFor(made, MSG_A);
    expect(historyAfterFirstPass).toHaveLength(2);
    expect(historyAfterFirstPass[1]).toMatchObject({
      id: MSG_A,
      to: 'helper',
      via: 'webhook',
      outcome: 'delivered',
    });

    // Second & third unread passes: .wake marker stops dueForWake, so the webhook is never posted a third time.
    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('idle'),
        ownPane: null,
        sources,
        now: new Date(NOW.getTime() + 60_000),
        say: () => {},
      },
      { unreadAfter: UNREAD_WINDOW },
    );
    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('idle'),
        ownPane: null,
        sources,
        now: new Date(NOW.getTime() + 120_000),
        say: () => {},
      },
      { unreadAfter: UNREAD_WINDOW },
    );

    expect(receiver.hits).toHaveLength(1);
    expect(typedCalls).toEqual([]);
    expect(historyFor(made, MSG_A)).toHaveLength(2);
  });

  test('a .posting claim left in state sent is not posted again', async () => {
    const receiver = startHookServer();
    const { made, team } = makeWebhookWorld(receiver.url);
    const dropDir = seedUnreadDrop(
      made,
      'helper',
      MSG_B,
      'first post outcome was uncertain',
      new Date(NOW.getTime() - 11 * MIN),
    );
    seedSendHistory(made, 'helper', MSG_B, { via: 'webhook' });
    writeFileSync(join(dropDir, `${MSG_B}.posting`), JSON.stringify({ state: 'sent' }));

    const typedCalls: string[] = [];
    const sources: RetrySources = {
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      typedWake: async (_pane, line) => {
        typedCalls.push(line);
        return { delivered: true, typed: true, tries: 1, reason: 'fallback' };
      },
    };

    await wakeUnreadDrops(
      {
        dir: made.dir,
        session: 'acme',
        root: made.root,
        home: made.home,
        team,
        live: liveHelper('idle'),
        ownPane: null,
        sources,
        now: NOW,
        say: () => {},
      },
      { unreadAfter: UNREAD_WINDOW },
    );

    expect(receiver.hits).toHaveLength(0);
  });
});
