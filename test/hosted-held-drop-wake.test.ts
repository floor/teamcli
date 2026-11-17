// A held drop's `.pending` marker (leg `drop`, written by a send to a pull-only seat) is the
// held-drop retry's to act on. The daemon-hosted watch never runs that retry, so the unread pass
// must not leave the message to it there: the seat was never woken (2026-11-17, an idle Grok
// tester unread for hours after a reboot). Helpers copied from the rewake test:
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
import { markPending } from '../src/send/pending.ts';

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

function museTeamYaml(root: string, lobby: string, webhookExtra = '', operator = 'helper'): string {
  return `format: 1
project: acme
coordinator: lead
operator: ${operator}
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
  scratchBase = realpathSync(mkdtempSync(join(tmpdir(), 'team-held-drop-wake-')));
  const root = join(scratchBase, 'acme');
  const home = join(scratchBase, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  // These are the generic worker typed-wake scenes, not the lead/operator wake path.
  const yaml = museTeamYaml(root, lobbyDir(home), webhookExtra, 'lead');
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


async function pass(made: World, team: ReturnType<typeof parseTeam>, sources: RetrySources, now: Date, heldDropRetry?: boolean): Promise<string[]> {
  const said: string[] = [];
  await wakeUnreadDrops(
    { dir: made.dir, session: 'acme', root: made.root, home: made.home, team, live: liveHelper('idle'), ownPane: null, sources, now, say: (text) => said.push(text) },
    { unreadAfter: UNREAD_WINDOW, ...(heldDropRetry === undefined ? {} : { heldDropRetry }) },
  );
  return said;
}

describe('a held drop marker under a watch with no held-drop retry', () => {
  function scene() {
    const { made, team } = makeWorld();
    const ts = new Date(NOW.getTime() - 11 * MIN);
    const dropDir = seedUnreadDrop(made, 'helper', MSG_A, 'ping', ts);
    seedSendHistory(made, 'helper', MSG_A, { via: 'drop' });
    markPending(dropDir, { ts: ts.toISOString(), from: 'owner', to: 'helper', body: 'ping', id: MSG_A, leg: 'drop' });
    expect(existsSync(join(dropDir, `${MSG_A}.pending`))).toBe(true);
    const fake = makeFakeWakeHost((_i, enters, typed) => {
      if (enters >= 1) return MUSE_WORKING;
      if (typed.length >= 1) return museHolding(typed[typed.length - 1]!);
      return MUSE_IDLE;
    });
    const sources: RetrySources = {
      screen: () => MUSE_IDLE,
      status: () => 'idle',
      typeText: () => false,
      pressEnter: () => false,
      sleep: async () => {},
      typedWake: (paneId, line, cli) => deliverTypedWake(fake.host, paneId, line, cli, FAST),
    };
    return { made, team, dropDir, fake, sources };
  }

  test('while the held-drop retry runs (the default), the marker keeps the unread pass away', async () => {
    const { made, team, dropDir, fake, sources } = scene();
    await pass(made, team, sources, NOW);
    await pass(made, team, sources, NOW, true);
    expect(fake.typed).toEqual([]);
    expect(existsSync(wakePath(dropDir, MSG_A))).toBe(false);
  });

  test('a watch that runs no held-drop retry wakes the idle seat once', async () => {
    const { made, team, dropDir, fake, sources } = scene();
    await pass(made, team, sources, NOW, false);
    expect(fake.typed).toHaveLength(1);
    expect(fake.typed[0]).toContain('Message from owner');
    expect(fake.enters).toBe(1);
    expect(wakeMarkerOf(made, 'helper', MSG_A)).toMatchObject({ id: MSG_A, state: 'sent' });
    // The wake is reserved: a later pass does not type it again.
    await pass(made, team, sources, new Date(NOW.getTime() + 30_000), false);
    expect(fake.typed).toHaveLength(1);
    expect(existsSync(wakeTryPath(dropDir, MSG_A)) || existsSync(wakePath(dropDir, MSG_A))).toBe(true);
  });
});
