// The `socket` delivery leg: a receiver's own `crossSessionInbound` declaration decides whether a
// send dials its cross-session socket, the signed record is written before the frame, and a
// declared order is walked as written. No live pane and no real socket: the host's deliver is a
// fake, and the socket file only has to stand where `socketOf` looks.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettings, cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { declaredInboundOf } from '../src/send/inbound.ts';
import { testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

/** The receiving seat's declaration at the launch's own settings path, and the socket its pane
 *  exposes. With `fresh`, the declaration's file predates the socket: the session was started
 *  after the launcher declared the policy. */
function declare(made: World, policy: string | null, fresh = true): string {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  const settingsAt = fresh ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(path, new Date(settingsAt), new Date(settingsAt));
  return path;
}

/** The team file with an entity, and the entity's own lobby in its trust list: a team that names
 *  an entity starts in `<home>/.config/team/lobbies/<slug>`, and that is the lobby the file must
 *  trust. */
function declareEntity(made: World, entity = 'acme-corp'): void {
  const path = join(made.dir, 'team.yaml');
  const lobby = resolveLobby(made.home, { entity });
  mkdirSync(lobby, { recursive: true });
  const text = readFileSync(path, 'utf8').replace(lobbyDir(made.home), lobby);
  writeFileSync(path, `${text}entity: ${entity}\n`);
}

/** A signed `delivery-order` policy at one level, as the owner writes it. */
function setOrder(made: World, level: 'entity' | 'project' | 'team', target: string, value: readonly string[]): void {
  const written = writePolicySet(
    made.home,
    {
      level,
      target,
      ...(level === 'team' ? { teamRoot: made.root } : {}),
      name: 'delivery-order',
      value: [...value],
    },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
}

test('an accepting Claude seat with no declared order walks the socket first, after the signed record', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  let atDial: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      atDial = readdirSync(drops);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(frames.length).toBe(1);
  expect(frames[0]).toContain('a note');
  // The durable signed copy was in the receiver's folder before the frame left: the record's
  // file is named by the message id, and it is the only file there.
  expect(atDial.length).toBe(1);
  expect(readdirSync(drops).length).toBe(1);
});

/** The socket the fake pane exposes; the deliver fake only records it. */
function socketFor(made: World): string {
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  return socket;
}

/** The generated per-seat settings file this build writes for the lead's launch. */
function generated(made: World, text: string, fresh = true): string {
  const path = cliHookSettingsPath(made.dir, 'acme', 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  const at = fresh ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(path, new Date(at), new Date(at));
  return path;
}

/** A launcher script outside the team root that execs the CLI with the given inline word, and
 *  the launch line that names it. Its mtime is backdated so a socket written after it is fresh. */
function wrapper(word: string): { launch: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'team-send-wrap-'));
  const path = join(base, 'launcher.sh');
  writeFileSync(path, `#!/bin/sh\nexec claude --settings '{"crossSessionInbound":"${word}"}' "$@"\n`);
  const past = new Date(Date.now() - 60_000);
  utimesSync(path, past, past);
  return { launch: `zsh ${path}`, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('a plain-text owner send reports delivered (socket), never read', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, fake(made));

  expect(code).toBe(0);
  expect(io.out).toContain('lead: delivered (socket)');
  expect(io.out).not.toContain('read');
});

test('a receiver declaring hold is skipped and the typed trigger takes the send', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'hold');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a receiver declaring nothing is skipped and the typed trigger takes the send', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, null);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a session started before its accept declaration is skipped, and the trigger takes the send', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept', false);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a declared order that omits socket never dials, even for an accepting receiver', async () => {
  const made = world(['mcp-inbox', 'typed']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a declared order may place socket first, and it is walked there', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
});

test('a declared order that puts the typed leg first takes the send there, and the socket is not dialed', async () => {
  const made = world(['typed', 'socket']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a socket leg named for a non-Claude seat is skipped, and the typed leg behind it takes the send', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'native', pane: 'w9:p1' }], native: pane });

  const code = await runSend(['native', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a wrapper accept overridden by the appended hooks file does not dial: the effective word is unset', async () => {
  // The installed failure this pins: the launch appends the generated hooks file after the
  // wrapper's own --settings, the CLI keeps the last one, and that file declares no
  // crossSessionInbound. The session is unset, so the frame would be held; the walk must not
  // read the wrapper's earlier accept through the effective file.
  const wrap = wrapper('accept');
  const made = world(null, [], { lead: wrap.launch });
  cleanup = () => {
    made.cleanup();
    wrap.cleanup();
  };
  socketFor(made);
  const settings = generated(made, JSON.stringify({ hooks: { UserPromptSubmit: [] } }));
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);

  const found = declaredInboundOf({
    dir: made.dir,
    root: made.root,
    session: 'acme',
    seat: 'lead',
    launch: wrap.launch,
  });
  expect(found.policy).toBeNull();
  expect(found.source).toBe(settings);
});

test('a wrapper accept with no generated settings file on the line is the effective word and dials', async () => {
  const wrap = wrapper('accept');
  const made = world(null, [], { lead: wrap.launch });
  cleanup = () => {
    made.cleanup();
    wrap.cleanup();
  };
  socketFor(made);
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
});

test('the merged generated file carries the wrapper word, and the walk dials on it', async () => {
  const wrap = wrapper('accept');
  const made = world(null, [], { lead: wrap.launch });
  cleanup = () => {
    made.cleanup();
    wrap.cleanup();
  };
  socketFor(made);
  // Exactly what installCliHooks writes for an accepting launch: hooks + the merged word.
  const statePath = join(made.dir, 'seat-state', 'acme', 'lead.json');
  generated(made, cliHookSettings(statePath, { seat: 'lead', session: 'acme' }, undefined, 'accept'));
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
  const parsed = JSON.parse(cliHookSettings(statePath, undefined, undefined, 'accept')) as Record<string, unknown>;
  expect(parsed.hooks).toBeDefined();
  expect(parsed.crossSessionInbound).toBe('accept');
  const plain = JSON.parse(cliHookSettings(statePath)) as Record<string, unknown>;
  expect('crossSessionInbound' in plain).toBe(false);
});

test('a signed entity order that places typed before socket keeps the socket out', async () => {
  // Without the entity's word the accepting receiver would take the implied socket prepend. The
  // entity declares the order instead, and it is walked as written: typed first, no dial.
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  setOrder(made, 'entity', 'acme-corp', ['typed', 'socket']);
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a signed project order that places typed before socket keeps the socket out', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  upsertProject(made.home, 'acme-proj', { name: 'Acme', teams: [teamIdOf(made.root)], at: NOW.toISOString() });
  setOrder(made, 'project', 'acme-proj', ['typed', 'socket']);
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('a signed team order shadows the file’s word, and its socket dials for an accepting receiver', async () => {
  // The file's legacy word would type and never dial; the signed word is the team's own and
  // puts the socket first.
  const made = world(['mcp-inbox', 'typed']);
  cleanup = made.cleanup;
  setOrder(made, 'team', made.root, ['socket', 'typed']);
  declare(made, 'accept');
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
});
