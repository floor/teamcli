// The delivery-order walk: the receiving seat's own chain — entity, project, team, seat — decides
// the order a plain send walks (mcp-inbox, typed, drop when nothing declares one); a level may
// drop legs, reorder the ones it keeps, or add `native`, the sender's own recorded choice, and
// may never empty it — an empty word is set aside, and so is one adding any other leg. A leg that
// definitely cannot take the send hands it on and is recorded as a failure on the history line,
// and each leg says its own reason. The mcp-inbox leg takes the send only while a listener for this seat, session
// and root is alive, and then reports `delivered (read)` when the receipt lands inside its grace
// or `sent (unconfirmed)` when it does not; without a listener it is recorded `no live inbox
// listener`. The typed leg behind it writes the same 0600 file and one trigger line, and the
// drop leg behind that writes the file and types nothing: a scene here proves the pane sees no
// keystroke at all. A waited send is refused unless the native leg leads the order: the frame the
// reply listener stands beside is that leg, and only a declared word can put it there.
//
// Both ways a chain reaches the walk are here: handed in on the host, and — the production
// reading — left out, so the team file's own `delivery_order` and its seats' are what the walk
// resolves (`src/send/delivery.ts`), with the registry project's word when a test hands in a
// registry. A seat that declares no word of its own takes the one its shape implies: a human
// seat walks the drop file alone, and a CLI whose launch installs no watcher never walks drop.
//
// Fixtures only: fake seats, fake panes, a fake sockets folder, and a `deliver` that counts the
// attempt and throws, so a walk that dials fails loudly. No live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSend, type SendHost } from '../src/commands/send.ts';
import type { ProjectSources } from '../src/commands/projects.ts';
import type { ConfigKey, ConfigValue } from '../src/config/registry.ts';
import { planConfigSet, writeConfigSet } from '../src/config/sources.ts';
import type { TeamFile } from '../src/file/types.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { MESSAGE_ID, receiptPath } from '../src/mcp/inbox.ts';
import type { ProjectRecord } from '../src/registry/projects.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { agentsDir, registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { planPolicySet, writePolicySet } from '../src/policy/index.ts';
import { startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { deliveryChainOf } from '../src/send/delivery.ts';
import { readHistory } from '../src/send/history.ts';
import { readPending } from '../src/send/pending.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import type { DeliveryLeg, SettingLevel } from '../src/settings/inherit.ts';
import { storePath } from '../src/store/store.ts';
import { installKey, messageKeyState } from '../src/store/keys.ts';
import { isRead, signReceiptPayload, writeReceipt } from '../src/send/record.ts';
import { readTriggerLine } from '../src/send/native.ts';
import { recordBody, testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-17T06:00:00.000Z');
const RULE = '─'.repeat(30);
const HEADER = 'from the owner — admitted by: the owner\n\n';

/** What the walk records for the legs it cannot take, exactly as send.ts words it. */
const MCP_SKIP = 'mcp-inbox: no live inbox listener';
/** The native skip an owner's send records: no SendMessage of this caller's carries the frame. */
const NATIVE_UNAVAILABLE = "native: unavailable; the native leg is the sending session's own SendMessage";

type Delivery = Partial<Record<SettingLevel, readonly DeliveryLeg[] | undefined>>;

let base = '';
const handles: SendDaemonHandle[] = [];

afterEach(async () => {
  for (const handle of handles) await handle.close();
  handles.length = 0;
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

/** The fixture file. `extra.top` is a top-level line appended after the sections, and
 *  `extra.lead`, `extra.watchless` and `extra.own` lines inside those seat entries — the two
 *  places the delivery order is written, so a scene can declare one without a second fixture.
 *  Every seat keeps its CLI's launch shape: the lead and `own` run Claude Code (`own` setting its
 *  own settings, so no hook is installed), `native` runs codex, and `watcherless` runs muse — a
 *  CLI whose profile carries neither a hook nor an MCP inbox, so it watches nothing at all. */
function teamYaml(root: string, lobby: string, extra: { top?: string; lead?: string; watchless?: string; own?: string } = {}): string {
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
${extra.lead ?? ''}  - role: implementer
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
  - role: reviewer
    name: watcherless
    cli: muse
    vendor: test
    model: Test
    version: "1"
    launch: muse --model muse-wonder-1.0
${extra.watchless ?? ''}  - role: reviewer
    name: own
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude --settings /own.json
${extra.own ?? ''}${extra.top ?? ''}`;
}

function world(extra: { top?: string; lead?: string; watchless?: string; own?: string; entity?: string } = {}): { root: string; dir: string; sockets: string; home: string; team: TeamFile } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-walk-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  // An entity moves the team's lobby to `<home>/.config/team/lobbies/<slug>`; the trust list
  // names the lobby the file resolves to, so the scene creates and trusts that one.
  const lobby = extra.entity === undefined ? lobbyDir(home) : resolveLobby(home, { entity: extra.entity });
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  const top = `${extra.entity === undefined ? '' : `entity: ${extra.entity}\n`}${extra.top ?? ''}`;
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobby, { ...extra, top }));
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error('fixture team.yaml failed to load');
  return { root, dir, sockets, home, team: loaded.team };
}

type Walker = SendHost & DaemonHost & {
  typed: { pane: string; text: string }[];
  enters: string[];
  frames: string[];
  dials: () => number;
};

/** The host every scene is handed. `delivery` is the chain the walk resolves; absent, the walk
 *  reads the chain from the fixture files (`src/send/delivery.ts`). The pane is an idle box that
 *  reads back the trigger once it is typed, and `deliver` counts the attempt before throwing: no
 *  walk dials. */
function walker(w: { sockets: string; home: string }, delivery?: Delivery, graceMs?: number): Walker {
  const typed: { pane: string; text: string }[] = [];
  const enters: string[] = [];
  const frames: string[] = [];
  let dials = 0;
  const statusByPane: Record<string, string> = { 'pane-lead': 'idle', 'pane-native': 'idle' };
  return {
    typed,
    enters,
    frames,
    dials: () => dials,
    delivery,
    agents: () => [
      { name: 'lead', pane: 'pane-lead' },
      { name: 'native', pane: 'pane-native' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async (_socketPath: string, frame: string): Promise<SendOutcome> => {
      dials += 1;
      frames.push(frame);
      throw new Error('the socket was dialed');
    },
    native: {
      typeText: (_session, pane, text) => {
        typed.push({ pane, text });
        return true;
      },
      pressEnter: (_session, pane) => {
        enters.push(pane);
        statusByPane[pane] = 'working';
        return true;
      },
      status: (_session, pane) => statusByPane[pane] ?? 'idle',
      wait: async () => {},
      paneText: (_session, pane) => {
        const last = [...typed].reverse().find((one) => one.pane === pane);
        if (last && !enters.includes(pane)) return `${RULE}\n❯ ${last.text}\n${RULE}`;
        return `${RULE}\n❯ \n${RULE}`;
      },
    },
    now: () => NOW,
    home: w.home,
    ...(graceMs === undefined ? {} : { inboxGraceMs: graceMs }),
    deliverWaitMs: 50,
    pollReadyMs: 5,
  };
}

const owner = (root: string) => testIo(root, { kind: 'owner' });

function dropDir(root: string, seat: string): string {
  return join(root, '.agents', 'send-drops', 'acme', seat);
}

function dropped(root: string, seat: string): string {
  return join(dropDir(root, seat), readdirSync(dropDir(root, seat)).sort()[0] as string);
}

/** A live listener beside the lead's inbox: this process's pid and the fixture's own seat,
 *  session and root — the record a running inbox server leaves. */
function liveInbox(w: { root: string }, over: { seat?: string; session?: string; root?: string; pid?: number } = {}): string {
  const seat = over.seat ?? 'lead';
  const dir = dropDir(w.root, seat);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.inbox-listener'), `${JSON.stringify({
    v: 1,
    seat,
    session: over.session ?? 'acme',
    root: over.root ?? w.root,
    cli: seat === 'native' ? 'codex' : 'claude-code',
    pid: over.pid ?? process.pid,
    ts: NOW.toISOString(),
  })}\n`);
  return dir;
}

/** The message file the walk wrote: its UUID name is the id. */
function inboxDrop(dir: string): string {
  const id = readdirSync(dir).find((name) => MESSAGE_ID.test(name));
  if (id === undefined) throw new Error('no message file in the inbox');
  return id;
}

/** The receipt an `inbox_read` call would write, for the first message that appears while the
 *  send waits — a live server's answer without a server. It is the signed status receipt the
 *  server writes, through the same module, so the send's wait verifies it. Returns the stop for
 *  the poll. */
function receiptSoon(dir: string, home: string, root: string, over: { seat?: string; session?: string } = {}): () => void {
  const context = { to: over.seat ?? 'lead', root, session: over.session ?? 'acme' };
  const timer = setInterval(() => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const id = names.find((name) => MESSAGE_ID.test(name));
    if (id === undefined) return;
    const key = messageKeyState(home);
    if (key.kind === 'key' && isRead(dir, id, context, key.key)) {
      clearInterval(timer);
      return;
    }
    const written = writeReceipt(dir, signReceiptPayload({
      kind: 'receipt',
      status: 'read',
      id,
      to: context.to,
      root,
      session: context.session,
      at: NOW.toISOString(),
    }, home), home);
    if (written.ok) clearInterval(timer);
  }, 2);
  return () => clearInterval(timer);
}

/** One registry project record, with a delivery order when a scene declares one. */
function projectRecord(order?: DeliveryLeg[]): ProjectRecord {
  return {
    id: 'acme',
    name: 'acme',
    entity: null,
    lead: null,
    teams: [],
    ...(order ? { deliveryOrder: order } : {}),
    provenance: { registered_by: 'test', registered_at: NOW.toISOString(), updated_at: NOW.toISOString() },
  };
}

/** The registry seam a scene hands the host: one project, answering every read. */
function projectSources(record: ProjectRecord | null): ProjectSources {
  return { list: () => (record ? [record] : []), byName: () => record, ofTeam: () => record };
}

function lastEntry(root: string, home: string): Record<string, unknown> {
  const history = readHistory('acme', root, home);
  if (!history.ok) throw new Error('the history could not be read');
  const entry = history.entries[history.entries.length - 1];
  if (entry === undefined) throw new Error('no history entry');
  return entry as unknown as Record<string, unknown>;
}

describe('the walk records the channel and the legs it skipped', () => {
  test('a plain send to a Claude Code seat types the trigger and records the inbox skip', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    // The typed leg is the one that wakes an idle seat: one trigger line, no frame, no dial.
    expect(host.typed).toEqual([{ pane: 'pane-lead', text: readTriggerLine('lead', 'acme', { seat: 'owner', team: 'acme', body: 'hello' }) as string }]);
    expect(host.enters).toEqual(['pane-lead']);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(w.root),
      body: `${HEADER}hello`,
      id: expect.any(String),
      thread: expect.any(String),
      outcome: 'sent (unconfirmed)',
      note: 'trigger taken, no read receipt yet',
      ms: 0,
      via: 'typed',
      failed: [MCP_SKIP],
    });
  });

  test('a level that leaves the drop leg out walks the typed leg behind it', async () => {
    const w = world();
    const host = walker(w, { seat: ['mcp-inbox', 'typed'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(lastEntry(w.root, w.home).via).toBe('typed');
    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
    expect(host.typed[0]?.pane).toBe('pane-lead');
  });

  test('an order whose legs this build carries leaves no failure behind', async () => {
    const w = world();
    const host = walker(w, { seat: ['typed'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(Object.keys(entry).sort()).toEqual(['body', 'from', 'from_team', 'id', 'ms', 'note', 'outcome', 'thread', 'to', 'ts', 'via']);
  });

  test('a codex seat walks the implied native-first order: native fails and the typed trigger wakes it before inbox', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(0);

    // The implied default names the seat's runtime queue first while its `codex-daemon` policy
    // is on; this fixture records no thread for the seat, so the route stands down and the typed
    // trigger wakes the idle pane before the inbox can accept a silent write.
    expect(lastEntry(w.root, w.home).failed).toEqual(['native: no trusted runtime session is recorded for this seat (no agent record for this seat)']);
    expect(lastEntry(w.root, w.home).via).toBe('typed');
    expect(host.typed.map((one) => one.pane)).toEqual(['pane-native']);
    expect(existsSync(dropped(w.root, 'native'))).toBe(true);
  });

  test('a live Codex inbox does not swallow an idle send before its typed wake', async () => {
    const w = world();
    const dir = liveInbox(w, { seat: 'native' });
    const host = walker(w, undefined, 0);
    const io = owner(w.root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(0);

    expect(io.out).toContain('native: sent (unconfirmed) (typed,');
    expect(host.typed.map((one) => one.pane)).toEqual(['pane-native']);
    expect(lastEntry(w.root, w.home).via).toBe('typed');
    expect(lastEntry(w.root, w.home).failed).toEqual([
      'native: no trusted runtime session is recorded for this seat (no agent record for this seat)',
    ]);
  });

  test('a word adding a leg other than native is set aside and the walk in force stands', async () => {
    const w = world();
    const host = walker(w, { team: ['native', 'mcp-inbox', 'typed'], seat: ['typed', 'telepathy' as DeliveryLeg] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    // The seat's word names `telepathy`, which is no leg at all, so the word is set aside; the
    // team's word stands — `native` is the one leg a level may add. The walk enters native first
    // and records the skip this sender gives it, then the inbox, and the typed leg takes it.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([NATIVE_UNAVAILABLE, MCP_SKIP]);
    expect(host.typed[0]?.pane).toBe('pane-lead');
  });

  test('an empty order is set aside: the default walk still takes the send', async () => {
    // An order of no legs would walk nowhere and fail every send. The empty word is no drop: it
    // is set aside like one naming a leg the order does not have, and the default order walks
    // and records the skipped inbox — before the guard this resolved to `[]` and the send was
    // unreachable.
    const w = world();
    const host = walker(w, { team: [] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([MCP_SKIP]);
  });
});

describe('the mcp-inbox leg takes the send only for a live listener', () => {
  test('a receipt inside the grace is delivered (read): nothing typed, and the marker is cleared', async () => {
    const w = world();
    const dir = liveInbox(w);
    const stop = receiptSoon(dir, w.home, w.root);
    const host = walker(w, undefined, 1_000);
    const io = owner(w.root);

    try {
      expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
    } finally {
      stop();
    }

    // The receipt means the seat read the message — not that it acted on it.
    expect(io.out).toBe('team acme, session "acme"\nlead: delivered (read)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    const id = inboxDrop(dir);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(w.root),
      body: `${HEADER}hello`,
      id,
      thread: id,
      outcome: 'delivered (read)',
      ms: 0,
      via: 'mcp-inbox',
    });
    expect(existsSync(join(dir, `${id}.pending`))).toBe(false);
    expect(existsSync(receiptPath(dir, id))).toBe(true);
  });

  test('no receipt inside the grace is sent (unconfirmed): exit 0, the message stays, nothing typed', async () => {
    const w = world();
    const dir = liveInbox(w);
    const host = walker(w, undefined, 0);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (mcp-inbox, 0 ms)\n');
    expect(host.typed).toEqual([]);
    const id = inboxDrop(dir);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(w.root),
      body: `${HEADER}hello`,
      id,
      thread: id,
      outcome: 'sent (unconfirmed)',
      ms: 0,
      via: 'mcp-inbox',
    });
    // The record left beside the drop says which leg left it: the send types nothing, and the
    // watch promotes a later receipt, or types the drop once the ten-minute fallback ends.
    expect(JSON.parse(readFileSync(join(dir, `${id}.pending`), 'utf8'))).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: `${HEADER}hello`,
      id,
      thread: id,
      tries: 0,
      leg: 'mcp-inbox',
    });
  });

  test('--json names the read on the inbox channel', async () => {
    const w = world();
    const dir = liveInbox(w);
    const stop = receiptSoon(dir, w.home, w.root);
    const io = owner(w.root);
    try {
      expect(await runSend(['lead', 'hello', '--json'], io, walker(w, undefined, 1_000))).toBe(0);
    } finally {
      stop();
    }
    const doc = JSON.parse(io.out) as { status: string; action_summary: string; channel: string; ids: { sent: string } };
    expect(doc.status).toBe('delivered (read)');
    expect(doc.action_summary).toBe('lead: delivered (read)');
    expect(doc.channel).toBe('mcp-inbox');
    expect(doc.ids.sent).toBe(inboxDrop(dir));
  });

  test('--json names the unconfirmed ending on the inbox channel', async () => {
    const w = world();
    liveInbox(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--json'], io, walker(w, undefined, 0))).toBe(0);

    const doc = JSON.parse(io.out) as { status: string; action_summary: string; channel: string };
    expect(doc.status).toBe('sent (unconfirmed)');
    expect(doc.action_summary).toBe('lead: sent (unconfirmed) (mcp-inbox, 0 ms)');
    expect(doc.channel).toBe('mcp-inbox');
  });

  test('a marker whose process is gone is no listener: the leg is skipped and the typed leg takes it', async () => {
    const w = world();
    liveInbox(w, { pid: 999_999_999 });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
    expect(lastEntry(w.root, w.home).via).toBe('typed');
    expect(host.typed.map((one) => one.pane)).toEqual(['pane-lead']);
  });

  test('a marker naming another seat is no listener for this inbox', async () => {
    const w = world();
    liveInbox(w, { seat: 'helper' });

    expect(await runSend(['lead', 'hello'], owner(w.root), walker(w))).toBe(0);

    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
    expect(lastEntry(w.root, w.home).via).toBe('typed');
  });

  test('a marker naming another session is no listener for this inbox', async () => {
    const w = world();
    liveInbox(w, { session: 'other' });

    expect(await runSend(['lead', 'hello'], owner(w.root), walker(w))).toBe(0);

    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
    expect(lastEntry(w.root, w.home).via).toBe('typed');
  });

  test('a marker naming another root is no listener for this inbox', async () => {
    const w = world();
    liveInbox(w, { root: join(w.root, 'elsewhere') });

    expect(await runSend(['lead', 'hello'], owner(w.root), walker(w))).toBe(0);

    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
    expect(lastEntry(w.root, w.home).via).toBe('typed');
  });
});

describe('the chain is read from the files when the host hands none in', () => {
  test('a team file declaring typed-only makes the walk skip native, and the history shows it', async () => {
    const w = world({ top: 'delivery_order: [typed]\n' });
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (typed, 0 ms; trigger taken, no read receipt yet)\n');
    // The order in force holds the one leg, so the send goes by it and neither skip a default
    // walk records is walked: the history line has no `failed` at all.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.outcome).toBe('sent (unconfirmed)');
    expect('failed' in entry).toBe(false);
    expect(entry.body).toBe(`${HEADER}hello`);
    expect(existsSync(dropped(w.root, 'lead'))).toBe(true);
    expect(host.typed[0]?.pane).toBe('pane-lead');
  });

  test('a seat’s own word is read from the seat, and the walk goes by it', async () => {
    const w = world({ lead: '    delivery_order: [typed]\n' });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect('failed' in entry).toBe(false);
  });

  test('a project’s word is read from its registry record', async () => {
    const w = world();
    const host = walker(w);
    host.projects = projectSources(projectRecord(['typed']));
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect('failed' in entry).toBe(false);
  });

  test('a seat word that adds native is honoured over the project’s word, and native is walked first', async () => {
    const w = world({ lead: '    delivery_order: [native, typed]\n' });
    const host = walker(w);
    host.projects = projectSources(projectRecord(['typed']));
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    // The project's typed-only word is in force, and the seat's word keeps that leg while adding
    // `native` — the one leg a word may add. The walk enters native, records the skip this sender
    // gives it, and the typed leg behind it takes the send.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([NATIVE_UNAVAILABLE]);
    expect(host.typed[0]?.pane).toBe('pane-lead');
  });

  test('the team file’s word and the seat’s resolve to the team and seat levels', () => {
    const w = world({ top: 'delivery_order: [native, typed]\n', lead: '    delivery_order: [typed]\n' });
    const chain = deliveryChainOf({ root: w.root, seat: 'lead', home: w.home, projectOfTeam: () => null });
    expect(chain).toEqual({ team: ['native', 'typed'], seat: ['typed'] });
  });

  test('a file the reader cannot load declares nothing: the default order stands', () => {
    const w = world();
    writeFileSync(join(w.dir, 'team.yaml'), teamYaml(w.root, lobbyDir(w.home), { top: 'delivery_order: [telepathy]\n' }));
    expect(deliveryChainOf({ root: w.root, seat: 'lead', home: w.home, projectOfTeam: () => null })).toEqual({});
  });

  test('a registry that cannot answer is no project word, never a failed send', () => {
    const w = world({ top: 'delivery_order: [typed]\n' });
    const chain = deliveryChainOf({
      root: w.root,
      seat: 'lead',
      home: w.home,
      projectOfTeam: () => {
        throw new Error('team acme is named in 2 projects');
      },
    });
    expect(chain).toEqual({ team: ['typed'] });
  });

  test('the project word is asked for the team’s own id', () => {
    const w = world();
    const asked: string[] = [];
    const chain = deliveryChainOf({
      root: w.root,
      seat: 'lead',
      home: w.home,
      projectOfTeam: (id) => {
        asked.push(id);
        return projectRecord(['mcp-inbox', 'typed']);
      },
    });
    expect(asked).toEqual([teamIdOf(w.root)]);
    expect(chain).toEqual({ project: ['mcp-inbox', 'typed'] });
  });

  test('a signed entity policy is the entity’s word', () => {
    const w = world({ entity: 'acme-corp' });
    const written = writePolicySet(w.home, { level: 'entity', target: 'acme-corp', name: 'delivery-order', value: ['drop'] }, { now: NOW });
    expect(written.ok ? 'ok' : written.why).toBe('ok');

    expect(deliveryChainOf({ root: w.root, seat: 'lead', home: w.home, projectOfTeam: () => null }))
      .toEqual({ entity: ['drop'] });
  });

  test('the entity’s word reaches the walk: the drop leg takes the send and nothing is typed', async () => {
    const w = world({ entity: 'acme-corp' });
    const written = writePolicySet(w.home, { level: 'entity', target: 'acme-corp', name: 'delivery-order', value: ['drop'] }, { now: NOW });
    expect(written.ok ? 'ok' : written.why).toBe('ok');
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('drop');
    expect(host.typed).toEqual([]);
    expect(existsSync(dropped(w.root, 'lead'))).toBe(true);
  });

  test('a signed project policy shadows the registry record’s legacy word', () => {
    const w = world();
    const written = writePolicySet(w.home, { level: 'project', target: 'acme', name: 'delivery-order', value: ['drop'] }, { now: NOW });
    expect(written.ok ? 'ok' : written.why).toBe('ok');

    expect(deliveryChainOf({
      root: w.root,
      seat: 'lead',
      home: w.home,
      projectOfTeam: () => projectRecord(['native', 'typed']),
    })).toEqual({ project: ['drop'] });
  });

  test('the project’s signed word reaches the walk, over the record’s legacy word', async () => {
    const w = world();
    const written = writePolicySet(w.home, { level: 'project', target: 'acme', name: 'delivery-order', value: ['drop'] }, { now: NOW });
    expect(written.ok ? 'ok' : written.why).toBe('ok');
    const host = walker(w);
    host.projects = projectSources(projectRecord(['mcp-inbox', 'typed']));
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('drop');
    expect(host.typed).toEqual([]);
  });

  test('a signed team policy shadows the file’s word', () => {
    const w = world({ top: 'delivery_order: [mcp-inbox, typed]\n' });
    const written = writePolicySet(
      w.home,
      { level: 'team', target: w.root, teamRoot: w.root, name: 'delivery-order', value: ['drop'] },
      { now: NOW },
    );
    expect(written.ok ? 'ok' : written.why).toBe('ok');

    expect(deliveryChainOf({ root: w.root, seat: 'lead', home: w.home, projectOfTeam: () => null }))
      .toEqual({ team: ['drop'] });
  });

  test('an expired signed word leaves its level silent, and the legacy word it shadows does not come back', () => {
    const w = world({ top: 'delivery_order: [mcp-inbox, typed]\n' });
    const written = writePolicySet(
      w.home,
      {
        level: 'team',
        target: w.root,
        teamRoot: w.root,
        name: 'delivery-order',
        value: ['drop'],
        expiry: '2026-10-18T00:00:00.000Z',
      },
      { now: NOW },
    );
    expect(written.ok ? 'ok' : written.why).toBe('ok');

    expect(deliveryChainOf({
      root: w.root,
      seat: 'lead',
      home: w.home,
      projectOfTeam: () => null,
      now: new Date('2026-10-19T00:00:00.000Z'),
    })).toEqual({});
  });

  test('entity, project and team each accept a delivery-order word naming socket', () => {
    const w = world({ entity: 'acme-corp' });
    const requests = [
      { level: 'entity' as const, target: 'acme-corp' },
      { level: 'project' as const, target: 'acme' },
      { level: 'team' as const, target: w.root, teamRoot: w.root },
    ];
    for (const request of requests) {
      const plan = planPolicySet(w.home, { ...request, name: 'delivery-order', value: ['socket', 'drop'] });
      expect([request.level, plan.ok ? 'ok' : plan.why]).toEqual([request.level, 'ok']);
    }
  });
});

describe('native leaves the default order and returns when a word names it', () => {
  test('the default order never walks native: no frame, no dial, no native word in the history', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    // The default order is mcp-inbox, typed, drop: the native leg is not in it at all, so the
    // walk records no word about it and no frame is tried.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([MCP_SKIP]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
  });

  test('a declared word naming native walks it first, and the walk records what this sender cannot do', async () => {
    // The word drops the inbox leg and adds the native one: `native` is the one leg a declared
    // order may add, so the walk enters it before the drop file, which still takes the send.
    const w = world({ lead: '    delivery_order: [native, drop]\n' });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('drop');
    expect(entry.failed).toEqual([NATIVE_UNAVAILABLE]);
    expect(host.typed).toEqual([]);
    expect(existsSync(dropped(w.root, 'lead'))).toBe(true);
  });
});

describe('a seat that declares no word takes the one its shape implies', () => {
  test('a human seat walks the drop file alone', () => {
    const w = world({ lead: '    human: true\n' });
    expect(deliveryChainOf({ root: w.root, seat: 'lead', home: w.home, projectOfTeam: () => null }))
      .toEqual({ seat: ['drop'] });
  });

  test('a CLI whose launch installs no watcher never walks the drop leg', () => {
    const w = world();
    // muse carries neither a command hook nor an MCP inbox: nothing on the receiving side would
    // ever read a drop file, so the seat's order leaves that leg out.
    expect(deliveryChainOf({ root: w.root, seat: 'watcherless', home: w.home, projectOfTeam: () => null }))
      .toEqual({ seat: ['mcp-inbox', 'typed'] });
  });

  test('a Claude Code launch that sets its own settings installs no hook, so it watches nothing', () => {
    const w = world();
    expect(deliveryChainOf({ root: w.root, seat: 'own', home: w.home, projectOfTeam: () => null }))
      .toEqual({ seat: ['mcp-inbox', 'typed'] });
  });

  test('a Claude Code seat whose launch sets no settings watches its folder through the hook', () => {
    const w = world();
    // The lead's launch is plain `claude`: the run appends `--settings` and installs the hook,
    // so its shape puts no word and the default order stands.
    expect(deliveryChainOf({ root: w.root, seat: 'lead', home: w.home, projectOfTeam: () => null }))
      .toEqual({});
  });

  test('Codex ordering is decided by the send route, not the generic chain', () => {
    const w = world();
    expect(deliveryChainOf({ root: w.root, seat: 'native', home: w.home, projectOfTeam: () => null }))
      .toEqual({});
  });

  test('a word the file declares is the seat’s own, never replaced by the shape', () => {
    const w = world({ watchless: '    delivery_order: [drop, typed]\n' });
    // The declared word stands even where the shape would leave drop out: the file is the seat's
    // own word, and the shape answers only where it is silent.
    expect(deliveryChainOf({ root: w.root, seat: 'watcherless', home: w.home, projectOfTeam: () => null }))
      .toEqual({ seat: ['drop', 'typed'] });
  });
});

describe('the drop leg', () => {
  test('a seat that opts into drop gets the file and zero pane writes', async () => {
    const w = world();
    const host = walker(w, { seat: ['drop'] });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(io.err).toBe('');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(w.root),
      body: `${HEADER}hello`,
      id: expect.any(String),
      thread: expect.any(String),
      outcome: 'sent (unconfirmed)',
      ms: 0,
      via: 'drop',
    });
  });

  test('drop first in the order takes the send before the typed leg behind it', async () => {
    const w = world();
    const host = walker(w, { seat: ['drop', 'typed'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(existsSync(dropped(w.root, 'lead'))).toBe(true);
    expect(lastEntry(w.root, w.home).via).toBe('drop');
  });

  test('its JSON document names the drop channel', async () => {
    const w = world();
    const host = walker(w, { seat: ['drop'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--json'], io, host)).toBe(0);

    const doc = assertMatchesOutputSchema<{
      status: string;
      channel: string;
      action_summary: string;
      ids: { sent: string };
    }>(io.out, SEND_OUTPUT_SCHEMA);
    expect(doc.status).toBe('sent (unconfirmed)');
    expect(doc.channel).toBe('drop');
    expect(doc.action_summary).toBe('lead: sent (unconfirmed) (drop, 0 ms)');
    expect(recordBody(join(dropDir(w.root, 'lead'), doc.ids.sent))).toBe(`${HEADER}hello`);
  });

  test('its dry run names the drop file and no typing', async () => {
    const w = world();
    const host = walker(w, { seat: ['drop'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe(
      'team acme, session "acme"\nlead: dry-run: claude-code via a 0600 drop file with nothing typed into the pane; nothing was written\n',
    );
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
    expect(host.typed).toEqual([]);
  });
});

describe('a human seat is never typed into', () => {
  const HUMAN = '    human: true\n';
  const TYPED_SKIP = "typed: the pane is a human's, and nothing is typed into it";
  const NATIVE_SKIP_HUMAN = "native: the pane is a human's, and no frame is sent";
  const INBOX_SKIP_HUMAN = "mcp-inbox: the pane is a human's, and the drop leg is the only one walked";

  test('typed-only walks no typing leg: drop takes it and the reason is recorded', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [typed]\n` });
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      from_team: teamIdOf(w.root),
      body: `${HEADER}hello`,
      id: expect.any(String),
      thread: expect.any(String),
      outcome: 'sent (unconfirmed)',
      ms: 0,
      via: 'drop',
      failed: [TYPED_SKIP],
    });
    // A person reading the drop writes no receipt, so no marker waits for one.
    expect(readPending(dropDir(w.root, 'lead'))).toEqual([]);
  });

  test('a human’s word naming native and typed records both legs kept out, and drop takes it', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [native, typed]\n` });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    // The word is within the default — `native` is the one leg it may add — so the seat's order is
    // `native, typed`; the human walk keeps both legs out, one reason each, and the drop file takes
    // the send.
    expect(lastEntry(w.root, w.home).failed).toEqual([NATIVE_SKIP_HUMAN, TYPED_SKIP]);
  });

  test('a human seat that declares no order walks the drop file alone, with no failure', async () => {
    const w = world({ lead: HUMAN });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    // The seat's shape puts `['drop']` itself: no typing leg was declared and then kept out, so
    // there is nothing for the walk to record.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('drop');
    expect('failed' in entry).toBe(false);
  });

  test('an order led by the inbox leg still walks only the drop file', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [mcp-inbox, typed]\n` });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home).failed).toEqual([INBOX_SKIP_HUMAN, TYPED_SKIP]);
  });

  test('an order that names the drop leg among others walks it alone', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [native, typed, drop]\n` });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: sent (unconfirmed) (drop, 0 ms)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    // The word is within the default — `native` is the one leg it may add, and `typed` and `drop`
    // are legs of the order in force — so the seat's order stands as written; the human walk keeps
    // native and typed out, one reason each, and the drop leg takes the send.
    expect(lastEntry(w.root, w.home).failed).toEqual([NATIVE_SKIP_HUMAN, TYPED_SKIP]);
  });

  test('the dry run names only the drop leg, whatever the order holds', async () => {
    const w = world({ lead: HUMAN });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe(
      'team acme, session "acme"\nlead: dry-run: claude-code via a 0600 drop file with nothing typed into the pane; nothing was written\n',
    );
    expect(host.typed).toEqual([]);
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
  });

  test('the dry run names the drop file, never a typing channel', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [typed]\n` });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe(
      'team acme, session "acme"\nlead: dry-run: claude-code via a 0600 drop file with nothing typed into the pane; nothing was written\n',
    );
    expect(host.typed).toEqual([]);
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
  });

  test('a waited send to a human seat walks the drop leg alone, types nothing, and waits on the thread', async () => {
    const w = world({ lead: HUMAN });
    const host = { ...walker(w), waitMs: 0 };
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host)).toBe(1);

    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home)).toMatchObject({
      outcome: 'timeout',
      via: 'drop',
    });
  });
});

describe('the dry run names only the legs this build can walk', () => {
  test('a Claude Code seat names the inbox channel and the one leg behind it', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line, then a 0600 drop file, with nothing typed into the pane; nothing was written\n');
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
  });

  test('an order that holds the inbox leg alone names it and no fallback', async () => {
    const w = world();
    const host = walker(w, { seat: ['mcp-inbox'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via the seat\'s own MCP inbox; nothing was written\n');
  });

  test('a word naming only the native leg is honoured, and the dry run finds no channel this sender walks', async () => {
    // `native` is the one leg a word may add, so the order in force is that leg alone; the sender
    // is the owner, who makes no frame and no handoff, so nothing of the order is a channel this
    // run could take.
    const w = world();
    const host = walker(w, { seat: ['native'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via no leg of its delivery order this build can walk; nothing was written\n');
  });

  test('a word naming only the headless-resume leg is honoured, and the dry run finds no channel this build walks', async () => {
    // `headless-resume` is a leg a word may add; this build carries no headless runtime, so the
    // order in force is that leg alone and nothing of it is a channel this run could take.
    const w = world();
    const host = walker(w, { seat: ['headless-resume'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via no leg of its delivery order this build can walk; nothing was written\n');
  });

  test('a seat that watches nothing is named without the drop leg', async () => {
    // The muse seat installs no watcher: its shape leaves drop out of the order, so the dry run
    // names the inbox and the typed fallback behind it, and never the drop file.
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['watcherless', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nwatcherless: dry-run: muse via the seat\'s own MCP inbox, falling back to a 0600 drop file and one trigger line; nothing was written\n');
  });
});

describe('a waited send walks the delivery order and waits on the thread', () => {
  test('an order that leads with typed writes the record on the typed leg and waits on the thread', async () => {
    const w = world();
    const host = { ...walker(w, { seat: ['typed'] }), waitMs: 0 };
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: lead: timeout: sent, no reply on the thread within 1s; the thread stays open\n');
    expect(host.typed).toHaveLength(1);
    expect(recordBody(dropped(w.root, 'lead'))).toBe(`${HEADER}hello`);
  });

  test('its dry run names the walk and writes nothing', async () => {
    const w = world();
    const host = walker(w, { entity: ['typed', 'native'] });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via a 0600 drop file and one trigger line; nothing was written\n');
  });

  test('a dry run of a waited send to a native-CLI seat names the walk and writes nothing', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['native', 'hello', '--wait', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nnative: dry-run: codex via its native runtime queue, falling back to a 0600 drop file and one trigger line, then the seat\'s own MCP inbox, then a 0600 drop file, with nothing typed into the pane; nothing was written\n');
    expect(io.err).toBe('');
    expect(host.typed).toEqual([]);
    expect(existsSync(dropDir(w.root, 'native'))).toBe(false);
  });

  test('a word naming only the native leg ends unreachable when no socket frame is available', async () => {
    const w = world();
    const host = { ...walker(w, { seat: ['native'] }), waitMs: 0 };
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe(
      "team send: lead: unreachable: no leg of its delivery order took the send (native: unavailable; the native leg is the sending session's own SendMessage)\n",
    );
    expect(host.dials()).toBe(0);
    // The skipped native leg is still an attempt the walk records, so its signed copy is on disk
    // as the message's durable record even though no route took the send.
    expect(inboxDrop(dropDir(w.root, 'lead'))).toMatch(MESSAGE_ID);
  });
  test('a word naming only the headless-resume leg ends unreachable, typing nothing into the seat', async () => {
    const w = world();
    const host = { ...walker(w, { seat: ['headless-resume'] }), waitMs: 0 };
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe(
      'team send: lead: unreachable: no leg of its delivery order took the send (headless-resume: this build carries no headless resume runtime)\n',
    );
    expect(host.typed).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
  });
});

describe('the walk’s failures ride the daemon’s write', () => {
  test('a send served by the daemon records the failures the caller walked', async () => {
    const w = world();
    const host = walker(w, { seat: ['mcp-inbox', 'typed'] });
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = owner(w.root);
    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([MCP_SKIP]);
    expect(host.typed[0]?.pane).toBe('pane-lead');
    // The daemon serves the typed leg from the state store's own drops folder, not the checkout's
    // `.agents/send-drops` — the walk's failures still ride its history write above.
    const storeDrops = join(storePath('acme', w.root, w.home), 'drops', 'acme', 'lead');
    const storeDrop = join(storeDrops, readdirSync(storeDrops).sort()[0] as string);
    expect(readFileSync(storeDrop, 'utf8')).toBe(`${HEADER}hello`);
  });
});

/** The lead as `up` would register it, with the owner key installed: the seat a signed setting
 *  can live on. No team record is written, so the fixture keeps the pre-registry addressing. */
function registeredLead(w: { root: string; home: string }): string {
  installKey(w.home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  return registerAgent(w.home, {
    name: 'Lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(w.root), seat: 'lead', session: 'acme', pane: 'pane-lead', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  }).id;
}

/** One signed seat setting, written through the store's own plan and write. */
function signSeat(w: { home: string }, agentId: string, settings: { key: ConfigKey; value: ConfigValue }[]): void {
  const plan = planConfigSet(w.home, { level: 'seat', target: agentId, settings });
  if (!plan.ok) throw new Error(`the plan was refused: ${plan.why}`);
  const written = writeConfigSet(w.home, plan, { now: NOW });
  if (!written.ok) throw new Error(`the write was refused: ${written.why}`);
}

describe('a signed seat setting is what the next send walks', () => {
  test('a signed delivery_order stands in the file’s place', async () => {
    // The file gives the seat `drop`; the signed record gives it `typed`, and the signed word is
    // the seat's own.
    const w = world({ lead: '    delivery_order: [drop]\n' });
    const agentId = registeredLead(w);
    signSeat(w, agentId, [{ key: 'delivery_order', value: ['typed'] }]);
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect('failed' in entry).toBe(false);
    expect(host.typed[0]?.pane).toBe('pane-lead');
  });

  test('a signed human walks the drop file alone over the file’s order', async () => {
    // The team's order would type; the seat's signed record says its pane is a human's, and a
    // human's walk is the drop file alone, with every leg it spared recorded.
    const w = world({ top: 'delivery_order: [mcp-inbox, typed]\n' });
    const agentId = registeredLead(w);
    signSeat(w, agentId, [{ key: 'human', value: true }]);
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('drop');
    expect(entry.failed).toEqual([
      "mcp-inbox: the pane is a human's, and the drop leg is the only one walked",
      "typed: the pane is a human's, and nothing is typed into it",
    ]);
    expect(host.typed).toEqual([]);
  });

  test('a record that does not verify refuses the send before any leg walks', async () => {
    // A `human: true` the record disowns must not be read as absent: falling back to the file's
    // order would type into a pane the tampered record claimed was a human's, so nothing walks.
    const w = world({ lead: '    delivery_order: [drop]\n' });
    const agentId = registeredLead(w);
    signSeat(w, agentId, [{ key: 'human', value: true }]);
    const path = join(agentsDir(w.home), `${agentId}.yaml`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('value: true', 'value: false'));
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(2);
    expect(io.err).toContain(path);
    expect(io.err).toContain('signature verification failed');
    expect(host.typed).toEqual([]);
    expect(host.frames).toEqual([]);
  });
});
