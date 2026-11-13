// Independent scenes for the sender-after-restore fix: a registry record that declares a
// conversation is only that seat's sender while the live pane reports that same conversation.
// A pane id reused by another conversation — named or unnamed — never sends as the record. The
// fence bites only where a conversation is declared AND a live reader can report: a record with
// no conversation, or a world no reader answers, keeps its prior admission. Every refusal
// asserts nothing was written, typed, or renamed.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { placeCaller, type CallerSources } from '../src/caller.ts';
import { clientInboxFolder } from '../src/client/inbox.ts';
import { clientKeyDir, newClientKeyPair, writeClientGrant, writeClientKeyFiles } from '../src/client/records.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runRoute } from '../src/commands/route.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { setHerdrCapture, setHerdrRun } from '../src/herdr.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { historyPath } from '../src/send/history.ts';
import { routesPath } from '../src/send/routes.ts';
import { emptySession, LOG_FILE, updateState } from '../src/state.ts';
import { keyOf } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';

const MISMATCH =
  'the live conversation on pane %s does not match the registry\'s conversation for seat %s; this call is not proven as that seat; run team up or team restart %s';

const made: string[] = [];
const owned: string[] = [];
afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  const paths = owned.splice(0);
  discardFixtures(paths, { roots: paths.map((path) => dirname(path)) });
});

// ---------------------------------------------------------------------------
// The send, route and record admissions: one shared world, the lead's record
// declares a conversation, and the live reader answers through host.agents.
// ---------------------------------------------------------------------------

const SEND_NOW = new Date('2026-11-09T20:00:00.000Z');
const CONV_LEAD = 'conversation-lead-record';

function seatBlock(role: string, name: string, cli: string): string {
  return `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: ${cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${cli} --model test
`;
}

/** The acme world: lead's registry record DECLARES a conversation (the fix's subject), the state
 *  places both seats on the panes their records hold, and the fake host's live read is patchable.
 *  Everything else about the call stands as the record: same name, session, pane, running. */
function sendWorld(live: 'mismatch' | 'match' | 'unreachable' | 'absent' | 'no-report-on-record') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sender-restore-')));
  made.push(base);
  const home = join(base, 'h');
  const root = join(base, 'acme');
  const sockets = join(base, 'sockets');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ${lobbyDir(home)}
  - ${root}
workspace:
  mode: shared
seats:
${seatBlock('coordinator', 'lead', 'claude-code')}${seatBlock('implementer', 'helper', 'codex')}`);
  const id = teamIdOf(root);
  const declareConversation = live !== 'no-report-on-record';
  const record = (seat: string, role: string, cli: string, pane: string): Agent =>
    registerAgent(home, {
      name: seat,
      signing: { model: 'Test', version: '1', role },
      lab: 'test-lab',
      cli,
      launcher: null,
      launch: `${cli} --model test`,
      reach: {
        team: id, seat, session: 'acme', pane, address: null,
        ...(declareConversation && seat === 'lead' ? { agent_session: CONV_LEAD } : {}),
      },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'up',
    });
  const lead = record('lead', 'coordinator', 'claude-code', 'lead-pane');
  const helper = record('helper', 'implementer', 'codex', 'worker-pane');
  upsertTeam(home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root,
    lobby: lobbyDir(home),
    roster: [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: helper.id, seat: 'helper', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
  });
  for (const [seat, pane] of [['lead', 'lead-pane'], ['helper', 'worker-pane']] as const) {
    updateState(join(root, '.agents'), (state) => {
      const seats = state.sessions.acme?.seats ?? {};
      state.sessions.acme = { seats: { ...seats, [seat]: { stage: 'launched', pane, workspace: 'ws-acme' } }, worktrees: {} };
    });
  }
  const frames: string[] = [];
  const typed: string[] = [];
  const asked: string[] = [];
  const host: SendHost = {
    agents: (session) => {
      asked.push(session);
      if (live === 'unreachable') return null;
      if (live === 'absent') return [];
      // The pane is named as the seat — the host put the name back — but the conversation it
      // reports is another seat's unless the scene says it matches.
      const reported = live === 'match' ? CONV_LEAD : 'conversation-borrowed-by-another-seat';
      return [{ name: 'lead', pane: 'lead-pane', cli: 'claude', session: reported }];
    },
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: sockets,
    deliver: async (_socketPath: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
    native: {
      typeText: (_pane: string, text: string) => {
        typed.push(text);
        return false;
      },
      pressEnter: () => false,
      status: () => null,
      wait: async () => {},
    },
    now: () => SEND_NOW,
    home,
  };
  return { base, home, root, host, frames, typed, asked };
}

/** Every byte under the session's drop folder, so a positive can prove the message landed and a
 *  refusal can prove nothing did. */
function dropBytes(root: string): string {
  const dir = join(root, '.agents', 'send-drops');
  if (!existsSync(dir)) return '';
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(readFileSync(full, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}

describe('a record that declares a conversation sends only while the pane reports it', () => {
  test('send: a named pane reporting another seat\'s conversation is refused, and nothing is written or typed', async () => {
    const w = sendWorld('mismatch');
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' });

    const code = await runSend(['helper', 'hello'], io, w.host);

    expect(code).toBe(1);
    expect(io.err).toBe(
      `team send: refused: ${MISMATCH.replace('%s', 'lead-pane').replaceAll('%s', 'lead')}\n`,
    );
    expect(io.out).toBe('');
    // The live read ran, once, for the record's own session — and nothing else happened.
    expect(w.asked).toEqual(['acme']);
    expect(w.frames).toEqual([]);
    expect(w.typed).toEqual([]);
    expect(dropBytes(w.root)).toBe('');
    expect(JSON.stringify(io.out + io.err)).not.toContain('hello');
  });

  test('route: the mismatching conversation refuses, and no address is answered', async () => {
    const w = sendWorld('mismatch');
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' });

    const code = await runRoute(['helper'], io, w.host);

    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toContain(MISMATCH.replace('%s', 'lead-pane').replaceAll('%s', 'lead'));
    expect(existsSync(routesPath('acme', w.root, w.home))).toBe(false);
  });

  test('send --record: the mismatching conversation refuses, and no history is written', async () => {
    const w = sendWorld('mismatch');
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' });

    const code = await runSend(['--record', 'helper', '--channel', 'native', '--ms', '5'], io, w.host);

    expect(code).toBe(1);
    expect(io.err).toContain(MISMATCH.replace('%s', 'lead-pane').replaceAll('%s', 'lead'));
    expect(w.typed).toEqual([]);
    expect(existsSync(historyPath('acme', w.root, w.home))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The reply arms. Ordinary replies route through admissionOf with the live
// reader; the client-thread publication writer has its own copy of the check.
// ---------------------------------------------------------------------------

const REPLY_NOW = new Date('2026-11-09T21:00:00.000Z');
const REPLY_SENT = '5d5c4b3a-2928-4a4b-8c8d-1f2e3d4e5f6a';
const REPLY_ID = '6e6d5c4b-3a39-4a4b-8c8d-2f3e4d5e6f7a';
const CONV_ORCH = 'conversation-orchestrator-record';

/** The reply world: lead's record declares a conversation, the state places it, and a planted
 *  record waits in lead's own folder for the answer. */
function replyWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sender-reply-')));
  made.push(base);
  const home = join(base, 'home');
  const root = join(base, 'acme');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execSync('git init -q -b main', { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1
project: acme
coordinator: lead
operator: lead
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  const id = teamIdOf(root);
  const lead = registerAgent(home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'lead', session: 'acme', pane: 'lead-pane', address: null, agent_session: CONV_ORCH },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  const worker = registerAgent(home, {
    name: 'worker',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'worker', session: 'acme', pane: 'worker-pane', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(home, id, {
    project: 'acme',
    entity: 'acme',
    session: 'acme',
    root,
    lobby: join(base, 'lobby'),
    roster: [
      { agent: lead.id, seat: 'lead', role: 'coordinator', leads: true },
      { agent: worker.id, seat: 'worker', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { lead: { stage: 'ready' as const, pane: 'lead-pane' } } } as never;
  });
  plantRecord(
    home, root, 'acme', 'lead', REPLY_SENT,
    "from the file's seat worker (no registry record yet) — admitted by: a seat to its own team's orchestrator\n\nquestion",
    { at: REPLY_NOW.toISOString(), from: 'worker' },
  );
  return { base, home, root };
}

describe('the reply arms carry the same fence', () => {
  test('an ordinary reply from a mismatching conversation is refused and nothing is written', async () => {
    const w = replyWorld();
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' });
    const live = {
      agents: () => [{ name: 'lead', pane: 'lead-pane', cli: 'claude', session: 'conversation-borrowed-by-another-seat' }],
    } as unknown as SendHost;

    const code = await runReply([REPLY_SENT, 'the answer'], io, { home: w.home, now: () => REPLY_NOW, newId: () => REPLY_ID, send: live });

    expect(code).toBe(1);
    expect(io.out + io.err).toContain(MISMATCH.replace('%s', 'lead-pane').replaceAll('%s', 'lead'));
    expect(JSON.stringify(io.out + io.err)).not.toContain('the answer');
    expect(existsSync(join(recordDir(w.root, 'acme', 'worker'), REPLY_ID))).toBe(false);
    // The answered record waits exactly as it was: no receipt beside it, no reply citing it.
    const beside = readdirSync(join(recordDir(w.root, 'acme', 'lead'))).filter((name) => name.startsWith(REPLY_SENT));
    expect(beside).toEqual([REPLY_SENT]);
  });

  test('the same ordinary reply with no live reader keeps its prior admission', async () => {
    const w = replyWorld();
    const io = testIo(w.root, { kind: 'seat', name: 'lead', pane: 'lead-pane', session: 'acme' });

    const code = await runReply([REPLY_SENT, 'the answer'], io, { home: w.home, now: () => REPLY_NOW, newId: () => REPLY_ID });

    expect(code).toBe(0);
    expect(existsSync(join(recordDir(w.root, 'acme', 'worker'), REPLY_ID))).toBe(true);
  });
});

// The client-thread writer: an external client's thread answered by the recipient seat.
const CLIENT_NOW = new Date('2026-11-09T22:00:00Z');

const CLIENT_TEAM = `format: 1
project: acme-entity
entity: acme-entity
coordinator: orchestrator
operator: orchestrator
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: orchestrator
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
    leads: true
`;

let clientIds = 0;
const clientId = () => `${String(++clientIds).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** The client world of client-reply.test.ts, with the orchestrator's record now DECLARING a
 *  conversation: the grant carries the inbox op, the client's send is planted, and the seat's
 *  answer is what the scene exercises. */
function clientWorld() {
  const base = fixtureBase('.sender-client-');
  owned.push(base);
  const root = join(base, 'acme-entity');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), CLIENT_TEAM);
  const ownerKey = keyOf(home);
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(join(home, '.config', 'team', 'entities.yaml'), 'acme-entity:\n  clients:\n    acme-bot:\n      seats: [orchestrator]\n');
  const teamId = teamIdOf(root);
  const orch = registerAgent(home, {
    name: 'orchestrator',
    signing: { model: 'Test', version: '1', role: 'orchestrator' },
    lab: 'test',
    cli: 'claude-code',
    launcher: null,
    launch: 'true',
    reach: { team: teamId, seat: 'orchestrator', session: 'acme', pane: 'fixture:lead', address: null, agent_session: CONV_ORCH },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'test',
  });
  upsertTeam(home, teamId, {
    project: 'acme-entity', entity: 'acme-entity', session: 'acme', root, lobby: join(base, 'lobby'),
    roster: [{ agent: orch.id, seat: 'orchestrator', role: 'orchestrator', leads: true }],
    lifecycle: 'running',
  });
  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = { seats: { orchestrator: { stage: 'ready' as const, pane: 'fixture:lead' } } } as never;
  });
  const pair = newClientKeyPair();
  const keyDir = clientKeyDir(home, 'acme-bot');
  const keys = writeClientKeyFiles(keyDir, pair);
  if (!keys.ok) throw new Error(keys.why);
  const grant = writeClientGrant(home, { clientId: 'acme-bot', entity: 'acme-entity', publicKey: pair.publicKey, keyId: pair.keyId, keyDir, inbox: true }, { now: CLIENT_NOW, key: ownerKey });
  if (!grant.ok) throw new Error(grant.why);
  return { base, root, home, grantPath: grant.path, keyPath: join(keyDir, 'client.key') };
}

async function clientSend(w: { root: string; home: string; grantPath: string; keyPath: string }, text: string) {
  const io = testIo(w.root, { kind: 'owner' });
  const id = clientId();
  const host = { home: w.home, now: () => CLIENT_NOW, sendId: () => id } as unknown as SendHost;
  const code = await runSend(['--client', w.grantPath, '--key', w.keyPath, 'orchestrator@acme-entity', text], io, host);
  if (code !== 0) throw new Error(`client send failed: ${io.out}${io.err}`);
  return id;
}

describe('a seat answering an external client thread', () => {
  test('an actual reported conversation mismatch refuses, and the answer is never published', async () => {
    const w = clientWorld();
    const thread = await clientSend(w, 'Reviewer, are you there?');
    const io = testIo(w.root, { kind: 'seat', name: 'orchestrator', pane: 'fixture:lead', session: 'acme' });
    const live = {
      agents: () => [{ name: 'orchestrator', pane: 'fixture:lead', cli: 'claude', session: 'conversation-borrowed-by-another-seat' }],
    } as unknown as SendHost;

    const code = await runReply([thread, 'must not reach the client'], io, {
      home: w.home, now: () => new Date(CLIENT_NOW.getTime() + 60_000), newId: clientId, send: live,
    });

    expect(code).toBe(1);
    expect(io.out + io.err).toContain(MISMATCH.replace('%s', 'fixture:lead').replaceAll('%s', 'orchestrator'));
    expect(io.out + io.err).toContain('nothing was written');
    const inbox = clientInboxFolder(w.root, 'acme', 'acme-bot');
    const published = existsSync(inbox) ? readdirSync(inbox).filter((name) => !name.startsWith('.')) : [];
    expect(published).toEqual([]);
    expect(io.out).not.toContain('must not reach the client');
  });

  test('the same answer with no live reader is admitted as before', async () => {
    const w = clientWorld();
    const thread = await clientSend(w, 'Reviewer, are you there?');
    const io = testIo(w.root, { kind: 'seat', name: 'orchestrator', pane: 'fixture:lead', session: 'acme' });
    let replyId = '';
    const code = await runReply([thread, 'Loud and clear.'], io, {
      home: w.home, now: () => new Date(CLIENT_NOW.getTime() + 60_000), newId: () => (replyId = clientId()),
    });

    expect(code).toBe(0);
    expect(replyId).not.toBe('');
    expect(readdirSync(clientInboxFolder(w.root, 'acme', 'acme-bot'))).toContain(replyId);
  });
});

// ---------------------------------------------------------------------------
// The unnamed restored pane: the host dropped the name, the record holds the
// pane, and only the reported conversation can say whose pane it now is.
// ---------------------------------------------------------------------------

const SESSION = 'crate';
const PANE = 'pane-pebble';
const SHELL = 70;
const CLI = 80;
const CONV_PEBBLE = 'conversation-pebble';

function crate(conversation?: string): { base: string; root: string; home: string; dir: string } {
  const base = fixtureBase('.sender-unnamed-');
  owned.push(base);
  const root = join(base, 'crate');
  const home = join(base, 'home');
  const dir = join(root, '.agents');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  const lobby = lobbyDir(home);
  mkdirSync(lobby, { recursive: true });
  writeFileSync(join(dir, 'team.yaml'), `format: 1
project: crate
coordinator: pebble
operator: pebble
session: crate
workspace:
  mode: shared
trust:
  - ${JSON.stringify(lobby)}
  - ${JSON.stringify(root)}
seats:
  - role: coordinator
    name: pebble
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
`);
  const id = teamIdOf(root);
  const agent = registerAgent(home, {
    name: 'Pebble',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'pebble', session: SESSION, pane: PANE, address: null, ...(conversation === undefined ? {} : { agent_session: conversation }) },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  upsertTeam(home, id, {
    project: 'crate', entity: 'box', session: SESSION, root, lobby,
    roster: [{ agent: agent.id, seat: 'pebble', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  updateState(dir, (state) => {
    const session = state.sessions[SESSION] ?? (state.sessions[SESSION] = emptySession());
    session.seats.pebble = { stage: 'ready', pane: PANE };
  });
  return { base, root, home, dir };
}

function unnamedSources(home: string, conversation?: string): CallerSources {
  return {
    ancestors: () => [
      { pid: CLI, name: 'claude' },
      { pid: SHELL, name: 'zsh' },
      { pid: 50, name: 'herdr' },
      { pid: 1, name: 'launch' },
    ],
    agents: () => [
      { ...(conversation === undefined ? {} : { session: conversation }), name: null, agent: null, pane: PANE, workspace: 'ws-crate', status: 'idle', cwd: null },
    ],
    paneRootPid: (asked) => (asked === PANE ? SHELL : null),
    env: { HERDR_PANE_ID: PANE },
    stdinIsTTY: true,
    home,
    paneProcesses: () => ({ shell: SHELL, foreground: [CLI] }),
    foreground: () => ['claude'],
    seatAtPane: () => null,
  };
}

/** Every herdr call this scene can make lands in one list; a refusal that renamed the pane would
 *  show here. The rename script answers a rename by naming the pane on the next list read. */
function herdrScript(renames: string[]): void {
  let named = false;
  setHerdrRun((args) => {
    if (args[0] === 'agent' && args[1] === 'list') {
      return { agents: [{ name: named ? 'pebble' : '', pane_id: PANE, workspace_id: 'ws-crate', agent: 'claude', agent_status: 'idle', agent_session: CONV_PEBBLE }] };
    }
    return { agents: [] };
  });
  setHerdrCapture((args) => {
    if (args[0] === 'agent' && args[1] === 'rename') {
      renames.push(args.slice(2).join(' '));
      named = true;
    }
    return JSON.stringify({ result: true });
  });
}

function logText(dir: string): string {
  try {
    return readFileSync(join(dir, LOG_FILE), 'utf8');
  } catch {
    return '';
  }
}

describe('an unnamed pane the record holds is placed only by its conversation', () => {
  test('a reused pane id reporting another conversation stays unplaced, and no name is re-applied', () => {
    const made = crate(CONV_PEBBLE);
    const renames: string[] = [];
    herdrScript(renames);
    const placed = placeCaller(unnamedSources(made.home, 'conversation-borrowed-by-another-seat'), SESSION);
    expect(placed.kind).toBe('unplaced');
    expect(renames).toEqual([]);
    expect(logText(made.dir)).not.toContain('re-applied');
  });

  test('an unnamed pane with no reported conversation is not placed', () => {
    // The restore window's own case: the host reports nothing for the pane, so nothing can say
    // the pane is still the seat's — even though the record itself declares a conversation.
    const made = crate(CONV_PEBBLE);
    const renames: string[] = [];
    herdrScript(renames);
    const placed = placeCaller(unnamedSources(made.home, undefined), SESSION);
    expect(placed.kind).toBe('unplaced');
    expect(renames).toEqual([]);
    expect(logText(made.dir)).not.toContain('re-applied');
  });

  test('a record with no conversation of its own does not place an unnamed pane either', () => {
    // The fence does not fall back to the old shell-anchor reading when neither side declares.
    const made = crate(undefined);
    const renames: string[] = [];
    herdrScript(renames);
    const placed = placeCaller(unnamedSources(made.home, undefined), SESSION);
    expect(placed.kind).toBe('unplaced');
    expect(renames).toEqual([]);
  });

  test('the pane reporting the record\'s own conversation is placed and named again', () => {
    const made = crate(CONV_PEBBLE);
    const renames: string[] = [];
    herdrScript(renames);
    const placed = placeCaller(unnamedSources(made.home, CONV_PEBBLE), SESSION);
    expect(placed).toEqual({ kind: 'seat', name: 'pebble', pane: PANE, session: SESSION });
    expect(renames).toEqual([`${PANE} pebble`]);
    expect(logText(made.dir)).toContain(`re-applied the herdr name on pane ${PANE}`);
  });
});
