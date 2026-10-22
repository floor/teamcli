// Scenes for the socket read receipt: a temporary team whose lead declares
// `crossSessionInbound: accept`, a fake socket folder, a pane book, and the watch's own scene.
// The send host and the pane are fakes; no live session, real socket or owner home is touched.
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SendHost } from '../../src/commands/send.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { TeamFile } from '../../src/file/types.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { cliHookSettingsPath } from '../../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../../src/lobby/gate.ts';
import { listUnread, type InboxMessage } from '../../src/mcp/inbox.ts';
import { registerAgent, type Agent } from '../../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../../src/registry/teams.ts';
import type { NativePane } from '../../src/send/native.ts';
import { receiptFile, signedReceiptOf, statusOf, verifyReceipt } from '../../src/send/record.ts';
import { messageKeyState } from '../../src/store/keys.ts';
import { updateState } from '../../src/state.ts';
import type { Live } from '../../src/status/compare.ts';
import type { RetryScene, RetrySources } from '../../src/watch/retry.ts';
import { claudeBox, testIo, type TestIo } from '../helpers.ts';
import { fake, NOW, world, type Fake, type World } from '../send-native-fixtures.ts';

export { NOW, world, type World };

/** The sentence a Claude Code session shows when a cross-session frame was held at its box. */
export const HELD_SCREEN = 'Held message from another session\nPress enter to view';

export type Book = {
  screen: string | null;
  status: string;
  typed: string[];
  enters: number;
};

/** One pane, read by both the send's held-dialog probe and the watch's unread pass. Typing
 *  follows the box: the line lands in the composer, Enter sends it and leaves an empty box. */
export function book(screen: string | null = claudeBox(''), status = 'idle'): Book {
  return { screen, status, typed: [], enters: 0 };
}

/** The pane the send reads: only the held-dialog probe is part of a socket send. */
export function nativeOf(one: Book): NativePane {
  return {
    typeText: (_session, _pane, text) => {
      one.typed.push(text);
      one.screen = claudeBox(text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      one.status = 'working';
      one.screen = claudeBox('');
      return true;
    },
    status: () => one.status,
    paneText: () => one.screen,
    wait: async () => {},
  };
}

/** The watch's own sources, narrowed to the pane calls a retry makes. */
export function sourcesOf(one: Book): RetrySources {
  return {
    screen: () => one.screen,
    status: () => one.status,
    typeText: (_pane, text) => {
      one.typed.push(text);
      const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(text);
      one.screen = claudeBox(pasted ? pasted[1] ?? '' : text);
      return true;
    },
    pressEnter: () => {
      one.enters += 1;
      one.status = 'working';
      one.screen = claudeBox('');
      return true;
    },
    sleep: async () => {},
  };
}

/** The team's entity and the entity's own lobby in its trust list: a team that names an entity
 *  starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must trust.
 *  An owner-origin frame also needs the entity's reply target: `floor` ships one. */
export function declareEntity(made: World, entity = 'floor'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** Writes the lead's launch declaration at the settings path the launch reads, then the socket
 *  its pane exposes: the socket is newer than the declaration, so the session is live under it. */
export function acceptSocket(made: World, seat = 'lead', session = 'acme'): void {
  const path = cliHookSettingsPath(made.dir, session, seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  // The declaration predates the socket by a minute: the session was started after it.
  const declared = new Date(Date.now() - 60_000);
  utimesSync(path, declared, declared);
}

/** The lead's folder in the transport tree. */
export function dropsOf(made: World, seat = 'lead', session = 'acme'): string {
  return join(made.dir, 'send-drops', session, seat);
}

/** The message ids written in a drop folder: marker names carry a dot, records do not. */
export function recordIds(folder: string): string[] {
  return readdirSync(folder).filter((name) => !name.includes('.')).sort();
}

/** The one record a scene sent: its id, its signed body, and the bytes on disk. */
export function recordOf(folder: string): { id: string; path: string; body: string; raw: string } {
  const ids = recordIds(folder);
  if (ids.length !== 1) throw new Error(`the folder holds ${String(ids.length)} records, not one`);
  const id = ids[0] as string;
  const path = join(folder, id);
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as { payload: { body: string } };
  return { id, path, body: parsed.payload.body, raw };
}

/** The frame a socket attempt dialed: the harness's fake hands over the exact string. */
export function frameOf(frames: readonly string[]): { content: string; id: string } {
  const [only] = frames;
  if (only === undefined) throw new Error('no socket frame was dialed');
  const parsed = JSON.parse(only) as { msg_id: string; message: { content: string } };
  return { content: parsed.message.content, id: parsed.msg_id };
}

/** The raw `read` receipt beside a record, its mode, and its parsed payload: `null` when the
 *  receipt was not written at all. */
export function readReceipt(
  folder: string,
  id: string,
): { path: string; mode: number; payload: Record<string, unknown>; raw: string } | null {
  const path = receiptFile(folder, id, 'read');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as { payload: Record<string, unknown> };
  return { path, mode: statSync(path).mode & 0o777, payload: parsed.payload, raw };
}

/** Whether the record's `read` receipt is a signed payload this home's message key verifies. */
export function receiptVerifies(folder: string, id: string, home: string): boolean {
  const held = readReceipt(folder, id);
  if (held === null) return false;
  const signed = signedReceiptOf(JSON.parse(held.raw) as unknown);
  const key = messageKeyState(home);
  if (signed === null || key.kind !== 'key') return false;
  return verifyReceipt(signed, key.key);
}

/** The status the record's own receipts derive. */
export function statusAt(made: World, seat: string, id: string): string {
  const key = messageKeyState(made.home);
  if (key.kind !== 'key') throw new Error('the message key is missing');
  return statusOf(dropsOf(made, seat), id, { to: seat, root: made.root, session: 'acme' }, key.key);
}

/** The reader's own unread list: the gate both the typed wake and the ring read. */
export function unreadAt(made: World, seat = 'lead'): InboxMessage[] {
  return listUnread(dropsOf(made, seat), { to: seat, root: made.root, session: 'acme' }, made.home);
}

/** The team file, read as the commands read it. */
export function teamOf(made: World): TeamFile {
  const read = validateTeamFile(readFileSync(join(made.dir, 'team.yaml'), 'utf8'));
  if (!read.ok) throw new Error(JSON.stringify(read.errors));
  return read.team;
}

/** One live seat on its pane; an unattended claude on another workspace keeps the list shaped
 *  like a real reading. */
export function liveWith(seat: string, pane: string): Live {
  const agents: HerdrAgent[] = [
    { name: seat, agent: 'claude', pane, workspace: 'first', status: 'idle', cwd: null },
    { name: null, agent: 'claude', pane: 'other:pane', workspace: 'other', status: 'working', cwd: null },
  ];
  return { running: true, agents, workspaces: [], screens: {} };
}

/** The watch's unread scene for one pane book. */
export function sceneOf(
  made: World,
  one: Book,
  now: Date,
  options: { seat?: string; pane?: string } = {},
): RetryScene {
  const seat = options.seat ?? 'lead';
  return {
    dir: made.dir,
    session: 'acme',
    root: made.root,
    home: made.home,
    team: teamOf(made),
    live: liveWith(seat, options.pane ?? 'w1:p1'),
    ownPane: null,
    sources: sourcesOf(one),
    now,
    say: () => {},
  };
}

/** Registers helper in the registry, projects it onto the team roster with `nickname` (no
 *  nickname when null), and places it on `w2:p1`: the identity a seat send is bound to. */
export function registerHelper(made: World, nickname: string | null): Agent {
  const team = teamIdOf(made.root);
  const helper = registerAgent(made.home, {
    name: 'helper',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team, seat: 'helper', session: 'acme', pane: 'w2:p1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, team, {
    project: 'acme',
    entity: null,
    session: 'acme',
    root: made.root,
    lobby: lobbyDir(made.home),
    roster: [
      { agent: helper.id, seat: 'helper', role: 'implementer', ...(nickname === null ? {} : { nickname }) },
    ],
    lifecycle: 'running',
  });
  updateState(join(made.root, '.agents'), (state) => {
    const seats = state.sessions.acme?.seats ?? {};
    state.sessions.acme = {
      seats: { ...seats, helper: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' } },
      worktrees: state.sessions.acme?.worktrees ?? {},
    };
  });
  return helper;
}

/** The helper's own io: a seat placed on the pane the registry and the state record. */
export function helperIo(made: World): TestIo {
  return testIo(made.root, { kind: 'seat', name: 'helper', pane: 'w2:p1', session: 'acme' });
}

/** A host whose agent list carries both seats a header scene names. */
export function hostOf(made: World, one: Book): Fake {
  return fake(made, {
    agents: () => [
      { name: 'lead', pane: 'w1:p1' },
      { name: 'helper', pane: 'w2:p1' },
    ],
    native: nativeOf(one),
  });
}

export type { Fake, SendHost };
