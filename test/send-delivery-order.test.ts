// The delivery-order walk: the receiving seat's own chain — entity, project, team, seat — decides
// the order a plain send walks (native, mcp-inbox, typed, drop when nothing declares one); a level
// may drop legs or reorder the ones it keeps, and may never add one nor empty it — an empty word is
// set aside; a leg that definitely cannot take the send hands it on and is recorded as a failure
// on the history line; and the legs this build does not carry — mcp-inbox always, native while
// its frame path is a socket write this build does not make — are recorded `unavailable` in the
// walk's own words. A waited send is refused unless the native leg leads the order: the frame the
// reply listener stands beside is that leg. The drop leg writes the typed leg's own file and types
// nothing: a scene here proves the pane sees no keystroke at all.
//
// Both ways a chain reaches the walk are here: handed in on the host, and — the production
// reading — left out, so the team file's own `delivery_order` and its seats' are what the walk
// resolves (`src/send/delivery.ts`), with the registry project's word when a test hands in a
// registry.
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
import type { TeamFile } from '../src/file/types.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { SEND_OUTPUT_SCHEMA } from '../src/output/index.ts';
import type { ProjectRecord } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { startSendDaemon, type DaemonHost, type SendDaemonHandle } from '../src/send/daemon.ts';
import { deliveryChainOf } from '../src/send/delivery.ts';
import { readHistory } from '../src/send/history.ts';
import { triggerLine } from '../src/send/native.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import type { DeliveryLeg, SettingLevel } from '../src/settings/inherit.ts';
import { storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';
import { assertMatchesOutputSchema } from './helpers/output.ts';

const NOW = new Date('2026-10-17T06:00:00.000Z');
const RULE = '─'.repeat(30);
const HEADER = 'from the owner — admitted by: the owner\n\n';

/** What the walk records for the two legs this build cannot take, exactly as send.ts words it. */
const NATIVE_SKIP = 'native: unavailable; the frame path is a socket write this build does not make';
const MCP_SKIP = 'mcp-inbox: unavailable; this build carries no mcp-inbox leg';

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
 *  `extra.lead` a line inside the lead's seat entry — the two places the delivery order is
 *  written, so a scene can declare one without a second fixture. */
function teamYaml(root: string, lobby: string, extra: { top?: string; lead?: string } = {}): string {
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
${extra.top ?? ''}`;
}

function world(extra: { top?: string; lead?: string } = {}): { root: string; dir: string; sockets: string; home: string; team: TeamFile } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-walk-')));
  const root = join(base, 'acme');
  const dir = join(root, '.agents');
  const sockets = join(base, 'sockets');
  const home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(root, lobbyDir(home), extra));
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
function walker(w: { sockets: string; home: string }, delivery?: Delivery): Walker {
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
  test('a plain send to a Claude Code seat walks to the typed leg and records both skips', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: delivered\n');
    expect(host.dials()).toBe(0);
    expect(host.frames).toEqual([]);
    const trigger = triggerLine(dropped(w.root, 'lead'));
    if (trigger === null) throw new Error('the drop path did not fit a trigger line');
    expect(host.typed).toEqual([{ pane: 'pane-lead', text: trigger }]);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: `${HEADER}hello`,
      id: expect.any(String),
      outcome: 'delivered',
      ms: 0,
      via: 'typed',
      failed: [NATIVE_SKIP, MCP_SKIP],
    });
  });

  test('a level that drops the native leg leaves only the skips still walked', async () => {
    const w = world();
    const host = walker(w, { seat: ['mcp-inbox', 'typed'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
  });

  test('an order whose legs this build carries leaves no failure behind', async () => {
    const w = world();
    const host = walker(w, { seat: ['typed'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(Object.keys(entry).sort()).toEqual(['body', 'from', 'id', 'ms', 'outcome', 'to', 'ts', 'via']);
  });

  test('a codex seat has no native leg to walk, so only the mcp-inbox skip is recorded', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['native', 'hello'], io, host)).toBe(0);

    expect(lastEntry(w.root, w.home).failed).toEqual([MCP_SKIP]);
    expect(host.typed[0]?.pane).toBe('pane-native');
  });

  test('an added leg is set aside and the walk in force stands', async () => {
    const w = world();
    const host = walker(w, { team: ['native', 'mcp-inbox', 'typed'], seat: ['native', 'typed', 'telepathy' as DeliveryLeg] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    // The seat's word names a leg the order in force does not have: it is no word at all.
    expect(lastEntry(w.root, w.home).failed).toEqual([NATIVE_SKIP, MCP_SKIP]);
  });

  test('an empty order is set aside: the default walk still takes the send', async () => {
    // An order of no legs would walk nowhere and fail every send. The empty word is no drop: it
    // is set aside like one naming a leg the order does not have, and the default order walks
    // and records both skips — before the guard this resolved to `[]` and the send was
    // unreachable.
    const w = world();
    const host = walker(w, { team: [] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: delivered\n');
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([NATIVE_SKIP, MCP_SKIP]);
  });
});

describe('the chain is read from the files when the host hands none in', () => {
  test('a team file declaring typed-only makes the walk skip native, and the history shows it', async () => {
    const w = world({ top: 'delivery_order: [typed]\n' });
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: delivered\n');
    // The order in force holds the one leg, so the send goes by it and neither skip a default
    // walk records is walked: the history line has no `failed` at all.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
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

  test('a seat word that would add a leg is set aside by the walk, over the project’s word', async () => {
    const w = world({ lead: '    delivery_order: [native, typed]\n' });
    const host = walker(w);
    host.projects = projectSources(projectRecord(['typed']));
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    // Honouring the seat's word would put the native leg back in and record its skip; it is not
    // in the order in force, so the word is no word and the project's typed-only order stands.
    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect('failed' in entry).toBe(false);
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
});

describe('the drop leg', () => {
  test('a seat that opts into drop gets the file and zero pane writes', async () => {
    const w = world();
    const host = walker(w, { seat: ['drop'] });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: delivered (dropped)\n');
    expect(io.err).toBe('');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(readFileSync(dropped(w.root, 'lead'), 'utf8')).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: `${HEADER}hello`,
      id: expect.any(String),
      outcome: 'delivered',
      ms: 0,
      via: 'drop',
    });
  });

  test('drop first in the order takes the send before the typed leg behind it', async () => {
    const w = world();
    const host = walker(w, { seat: ['drop', 'typed'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: delivered (dropped)\n');
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
    expect(doc.status).toBe('delivered');
    expect(doc.channel).toBe('drop');
    expect(doc.action_summary).toBe('lead: delivered (dropped)');
    expect(readFileSync(join(dropDir(w.root, 'lead'), doc.ids.sent), 'utf8')).toBe(`${HEADER}hello`);
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

  test('typed-only walks no typing leg: drop takes it and the reason is recorded', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [typed]\n` });
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: delivered (dropped)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(readFileSync(dropped(w.root, 'lead'), 'utf8')).toBe(`${HEADER}hello`);
    expect(lastEntry(w.root, w.home)).toEqual({
      ts: NOW.toISOString(),
      from: 'owner',
      to: 'lead',
      body: `${HEADER}hello`,
      id: expect.any(String),
      outcome: 'delivered',
      ms: 0,
      via: 'drop',
      failed: [TYPED_SKIP],
    });
  });

  test('native first falls through to drop: no frame, no trigger, no keystroke', async () => {
    const w = world({ lead: `${HUMAN}    delivery_order: [native, typed]\n` });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: delivered (dropped)\n');
    expect(host.typed).toEqual([]);
    expect(host.enters).toEqual([]);
    expect(host.frames).toEqual([]);
    expect(host.dials()).toBe(0);
    expect(lastEntry(w.root, w.home).failed).toEqual([NATIVE_SKIP_HUMAN, TYPED_SKIP]);
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

  test('a waited send is refused: the wait rides the native leg a human never walks', async () => {
    const w = world({ lead: HUMAN });
    const host = walker(w);
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--wait'], io, host)).toBe(1);

    expect(io.err).toContain("lead: the pane is a human's; the native leg is never walked for it, and --wait rides that leg; nothing was sent");
    expect(host.typed).toEqual([]);
    expect(host.frames).toEqual([]);
  });
});

describe('the dry run names only the legs this build can walk', () => {
  test('a Claude Code seat prints the typed channel: neither skip is a channel a run would take', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via a 0600 drop file and one trigger line; nothing was written\n');
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
  });

  test('an order that holds no walkable leg prints that, not a channel', async () => {
    // Non-empty, so the word stands: both legs it names are ones this build cannot walk.
    const w = world();
    const host = walker(w, { seat: ['native', 'mcp-inbox'] });
    const io = owner(w.root);

    expect(await runSend(['lead', 'hello', '--dry-run'], io, host)).toBe(0);

    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code via no leg of its delivery order this build can walk; nothing was written\n');
  });
});

describe('a waited send needs the native leg to lead the order', () => {
  test('an order that leads elsewhere refuses the wait, naming the order', async () => {
    const w = world();
    const host = walker(w, { seat: ['typed'] });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: refused: lead: --wait needs the native leg first, and its delivery order is typed; nothing was sent\n');
    expect(host.typed).toEqual([]);
    expect(existsSync(dropDir(w.root, 'lead'))).toBe(false);
  });

  test('its dry run prints the same refusal as a dry-run line', async () => {
    const w = world();
    const host = walker(w, { entity: ['typed', 'native'] });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--dry-run'], io, host);

    expect(code).toBe(0);
    expect(io.out).toBe('team acme, session "acme"\nlead: dry-run: claude-code --wait needs the native leg first, and its delivery order is typed, native; nothing was sent\n');
  });

  test('a dry run of a waited send to a native-CLI seat reports that seat’s refusal, exit 1', async () => {
    const w = world();
    const host = walker(w);
    const io = owner(w.root);

    // The seat runs codex: no run of this build could wait on it, dry or not, so the dry run
    // reports the refusal the real run would print rather than naming a channel it cannot walk.
    const code = await runSend(['native', 'hello', '--wait', '--dry-run'], io, host);

    expect(code).toBe(1);
    expect(io.err).toBe('team send: refused: native runs codex: this build confirms that a native CLI submitted and does not carry its reply; nothing was sent\n');
    expect(io.out).toBe('');
    expect(host.typed).toEqual([]);
    expect(existsSync(dropDir(w.root, 'native'))).toBe(false);
  });

  test('an order that leads with the native leg passes the order check and hits the build’s own refusal', async () => {
    const w = world();
    const host = walker(w, { seat: ['native'] });
    const io = owner(w.root);

    const code = await runSend(['lead', 'hello', '--wait', '--timeout', '1'], io, host);

    expect(code).toBe(1);
    expect(io.err).toContain('--wait needs the native leg (team route + your own SendMessage), which this build does not carry');
    expect(host.dials()).toBe(0);
  });
});

describe('the walk’s failures ride the daemon’s write', () => {
  test('a send served by the daemon records the failures the caller walked', async () => {
    const w = world();
    const host = walker(w, { seat: ['native', 'typed'] });
    const started = await startSendDaemon({ root: w.root, dir: w.dir, team: w.team, host });
    if (started.kind !== 'serving') throw new Error(started.kind);
    handles.push(started.handle);

    const io = owner(w.root);
    expect(await runSend(['lead', 'hello'], io, host)).toBe(0);

    const entry = lastEntry(w.root, w.home);
    expect(entry.via).toBe('typed');
    expect(entry.failed).toEqual([NATIVE_SKIP]);
    expect(host.typed[0]?.pane).toBe('pane-lead');
    // The daemon serves the typed leg from the state store's own drops folder, not the checkout's
    // `.agents/send-drops` — the walk's failures still ride its history write above.
    const storeDrops = join(storePath('acme', w.root, w.home), 'drops', 'acme', 'lead');
    const storeDrop = join(storeDrops, readdirSync(storeDrops).sort()[0] as string);
    expect(readFileSync(storeDrop, 'utf8')).toBe(`${HEADER}hello`);
  });
});
