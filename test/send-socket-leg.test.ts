// The `socket` delivery leg: a receiver's own `crossSessionInbound` declaration decides whether a
// send dials its cross-session socket, the signed record is written before the frame, and a
// declared order is walked as written. No live pane and no real socket: the host's deliver is a
// fake, and the socket file only has to stand where `socketOf` looks.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettings, cliHookSettingsPath, installCliHooks } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { replyLine } from '../src/send/frame.ts';
import { readHistory } from '../src/send/history.ts';
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
function declareSeat(made: World, seat: string, policy: string | null, fresh = true): string {
  const path = cliHookSettingsPath(made.dir, 'acme', seat);
  if (path === null) throw new Error(`the fixture declares no settings path for ${seat}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: policy }));
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  const settingsAt = fresh ? Date.now() - 60_000 : Date.now() + 60_000;
  utimesSync(path, new Date(settingsAt), new Date(settingsAt));
  return path;
}

function declare(made: World, policy: string | null, fresh = true): string {
  return declareSeat(made, 'lead', policy, fresh);
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

/** A signed entity-level `owner-reply-to` policy, as the owner writes it. */
function setOwnerReply(made: World, entity: string, value: string): void {
  const written = writePolicySet(
    made.home,
    { level: 'entity', target: entity, name: 'owner-reply-to', value },
    { now: NOW },
  );
  if (!written.ok) throw new Error(written.why);
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
  declareEntity(made, 'floor');
  declare(made, 'accept');
  const drops = dropDir(made.dir, 'lead');
  const frames: string[] = [];
  let atDial: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      atDial = readdirSync(drops).filter((name) => !name.includes('.'));
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
  // The record alone: the fallback episode's marker beside it is a sidecar, never a message.
  expect(readdirSync(drops).filter((name) => !name.includes('.')).length).toBe(1);
});

test('every socket frame ends with the reply address of the sender its signed record carries', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
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
  const sent = JSON.parse(frames[0] as string) as { message: { content: string } };
  const content = sent.message.content;
  // The owner is not a seat `team send` reaches: the line names the entity's owner-reply
  // target, the floor's shipped `orchestrator@floor`. It is the content's own last line, once.
  const reply = 'Reply with: team send orchestrator@floor "…"';
  expect(content.split('\n').at(-1)).toBe(reply);
  expect(content.split('\n').filter((line) => line === reply)).toHaveLength(1);
});

test('a reply line written in the body never moves the address the frame ends with', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made, 'accept');
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });
  const wrote = 'Reply with: team send impostor@elsewhere "…"';

  const code = await runSend(['lead', `a note\n${wrote}`], owner(made.root), host);

  expect(code).toBe(0);
  const sent = JSON.parse(frames[0] as string) as { message: { content: string } };
  const content = sent.message.content;
  // The body is carried as written, and the frame's own last line is still the owner's target.
  expect(content).toContain(`a note\n${wrote}`);
  expect(content.split('\n').at(-1)).toBe('Reply with: team send orchestrator@floor "…"');
});

test('an owner send names the entity’s signed owner-reply target, not a guessed seat', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'acme-corp');
  setOwnerReply(made, 'acme-corp', 'coordinator@acme');
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
  const sent = JSON.parse(frames[0] as string) as { message: { content: string } };
  expect(sent.message.content.split('\n').at(-1)).toBe('Reply with: team send coordinator@acme "…"');
});

test('an owner send in a team that names no entity dials no frame: no owner reply address exists', async () => {
  // `team send owner@acme` is not an address that resolves, and an entity-less team declares no
  // target to name instead. The frame is not dialed; the typed trigger behind it takes the send.
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
});

test('the reply line names the sending team, never the team the frame is delivered into', () => {
  const made = world(null);
  cleanup = made.cleanup;
  const sending = teamIdOf(made.root);
  // Two records in one registry: the sending team under its own name, and a receiving team named
  // for the fixture's own project. The line takes the sending id's record and nothing else.
  upsertTeam(made.home, sending, { project: 'outpost', session: 'acme', root: made.root });
  upsertTeam(made.home, 'aaaaaaaaaaaa', { project: 'acme', session: 'acme-web', root: join(made.root, 'other') });

  expect(replyLine(made.home, 'lead', sending)).toBe('Reply with: team send lead@outpost "…"');
  // A registry that cannot answer is no name: the team's id still addresses it.
  expect(replyLine(join(made.root, 'no-registry'), 'lead', sending)).toBe(`Reply with: team send lead@${sending} "…"`);
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
  declareEntity(made, 'floor');
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
  declareEntity(made, 'floor');
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
  declareEntity(made, 'floor');
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
  declareEntity(made, 'floor');
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

test('the install writes the wrapper word into the same file the launch appends', () => {
  const wrap = wrapper('accept');
  const made = world(null, [], { lead: wrap.launch });
  cleanup = () => {
    made.cleanup();
    wrap.cleanup();
  };

  const landed = installCliHooks(made.dir, 'acme', [
    { name: 'lead', cli: 'claude-code', launch: wrap.launch },
  ]);

  expect(landed.lead).toBeDefined();
  const parsed = JSON.parse(readFileSync(landed.lead ?? '', 'utf8')) as Record<string, unknown>;
  expect(parsed.hooks).toBeDefined();
  expect(parsed.crossSessionInbound).toBe('accept');
});

test('a launch line with its own --settings keeps its word, and a stale generated file is not read', () => {
  const launch = `claude --settings '{"crossSessionInbound":"hold"}'`;
  const made = world(null, [], { lead: launch });
  cleanup = made.cleanup;
  // A leftover generated file from an earlier install says accept; it is not on this line, so it
  // is not the session's settings and must not decide the dial.
  generated(made, JSON.stringify({ crossSessionInbound: 'accept' }));

  const found = declaredInboundOf({ dir: made.dir, root: made.root, session: 'acme', seat: 'lead', launch });

  expect(found.policy).toBe('hold');
  expect(found.source).toBe(made.root);
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
  declareEntity(made, 'floor');
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

test('a seat this build launched is dialed though its team file declares no inbound word', async () => {
  // The launch is the authorization: the generated settings file is on the launch line, and its
  // `accept` is what a seat TeamCLI launched attests. No per-seat team-file word is needed.
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer' }]);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declareSeat(made, 'plain', 'accept');
  const pane = scripted(['idle', 'working']);
  const frames: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'plain', pane: 'w2:p1' }],
    native: pane,
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['plain', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
  expect(frames[0]).toContain('hello');
  expect(pane.typed).toEqual([]);
  expect(host.frames).toEqual([]);
});

test('an explicit team-file hold keeps the socket out though the launch accepts', async () => {
  // The documented opt-out is written on the seat, and it wins over the launch's own accept.
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer' }]);
  cleanup = made.cleanup;
  const file = join(made.dir, 'team.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('    name: plain\n', '    name: plain\n    inbound: hold\n'));
  declareSeat(made, 'plain', 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'plain', pane: 'w2:p1' }], native: pane });

  const code = await runSend(['plain', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    "socket: the receiving seat's team file declares inbound hold",
  ]);
});

test('an explicit team-file refuse keeps the socket out though the launch accepts', async () => {
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer' }]);
  cleanup = made.cleanup;
  const file = join(made.dir, 'team.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('    name: plain\n', '    name: plain\n    inbound: refuse\n'));
  declareSeat(made, 'plain', 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'plain', pane: 'w2:p1' }], native: pane });

  const code = await runSend(['plain', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    "socket: the receiving seat's team file declares inbound refuse",
  ]);
});

test('a launch this build did not write still needs the team file’s accept word', async () => {
  // The default rests on the generated file being on the line: a launch line with its own
  // --settings was not attested by this build, so its accept alone authorizes nothing.
  const made = world(
    ['socket', 'typed'],
    [{ name: 'plain', role: 'implementer', launch: `claude --settings '{"crossSessionInbound":"accept"}'` }],
  );
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'plain', pane: 'w2:p1' }], native: pane });

  const code = await runSend(['plain', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    "socket: the receiving seat's team file does not declare inbound accept",
  ]);
});

test('a launch with no accept word is never dialed, whatever the team file omits', async () => {
  // The launch word is mandatory: with no generated file and no settings flag, the team file
  // writing nothing leaves the walk on the default order.
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer' }]);
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'plain', pane: 'w2:p1' }], native: pane });

  const code = await runSend(['plain', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(1);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    'socket: the receiving Claude session does not declare crossSessionInbound accept',
  ]);
});

test('a held frame is marked once, and the socket stays out until the declaration is re-confirmed', async () => {
  // The receiver's box holds the frame at its dialog. The walk records `held (socket)` once, in
  // the history and in a mark under the receiving team's state folder, and falls through to the
  // typed route with the same record and message id. The next send does not dial again: the
  // declaration the hold sat under has not moved. Rewriting it re-confirms the word, and the
  // socket is dialed again.
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  const settings = declare(made, 'accept');
  const rule = '─'.repeat(30);
  const emptyBox = `${rule}\n❯ \n${rule}`;
  const heldDialog = `Held message from another session\n${rule}\n❯ \n${rule}`;
  let frameLanded = false;
  let dialogShown = false;
  const pane = scripted(['idle', 'working', 'idle', 'working', 'idle']);
  pane.paneText = () => {
    if (frameLanded && !dialogShown) {
      dialogShown = true;
      return heldDialog;
    }
    return emptyBox;
  };
  const dials: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_path: string, frame: string) => {
      dials.push(frame);
      frameLanded = true;
      return { ok: true };
    },
  });

  // First send: one dial, held once, the typed route takes it.
  expect(await runSend(['lead', 'hello'], owner(made.root), host)).toBe(0);
  expect(dials).toHaveLength(1);
  expect(pane.typed).toHaveLength(1);
  const markPath = join(made.dir, 'send-held', 'acme', 'lead.json');
  const mark = JSON.parse(readFileSync(markPath, 'utf8')) as { at: string; declaredAt: number | null; source: string | null };
  expect(mark.source).toBe(settings);
  expect(typeof mark.declaredAt).toBe('number');
  expect(Number.isNaN(Date.parse(mark.at))).toBe(false);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.outcome).toBe('sent (unconfirmed)');
  expect(history.entries.at(-1)?.failed?.[0]).toContain('Held message from another session');

  // Second send under the same declaration: the socket is not dialed, and the walk says why.
  expect(await runSend(['lead', 'again'], owner(made.root), host)).toBe(0);
  expect(dials).toHaveLength(1);
  expect(pane.typed).toHaveLength(2);
  const second = readHistory('acme', made.root, made.home);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.entries.at(-1)?.failed?.[0]).toContain('held at its box');

  // The declaration is re-confirmed: the file is rewritten at a new time and the restarted host
  // exposes a fresh socket. The socket is dialed again, and this frame is taken.
  const reworded = new Date(Math.max(Date.now(), (mark.declaredAt ?? 0) + 1000));
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  utimesSync(settings, reworded, reworded);
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  utimesSync(socket, reworded, reworded);
  expect(await runSend(['lead', 'third'], owner(made.root), host)).toBe(0);
  expect(dials).toHaveLength(2);
  expect(pane.typed).toHaveLength(2);
});
