import { NO_PANE_MESSAGING } from '../src/send/no-pane-messaging.ts';
// The `socket` delivery leg: a receiver's own `crossSessionInbound` declaration decides whether a
// send dials its cross-session socket, the signed record is written before the frame, and a
// declared order is walked as written. No live pane and no real socket: the host's deliver is a
// fake, and the socket file only has to stand where `socketOf` looks.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runSend } from '../src/commands/send.ts';
import { cliHookSettings, cliHookSettingsPath, installCliHooks } from '../src/launch/cli-hook.ts';
import { seatLockPath } from '../src/launch/seat-lock.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { upsertProject } from '../src/registry/projects.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { readerLine } from '../src/send/frame.ts';
import { readHistory } from '../src/send/history.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';
import { emptySession, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { NOW, dropDir, fake, owner, scripted, world, type World } from './send-native-fixtures.ts';
import { withoutSendId } from './helpers/output.ts';

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

test('a runtime launch that names its own accepted settings gets the socket, whatever the file launch would install', async () => {
  // The line the seat actually ran is what the walk reads. The file's row would
  // install a generated settings file that declares nothing; the running session names its own
  // settings file, which declares accept, and the socket is newer than that declaration.
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declareSeat(made, 'lead', null);
  const runtime = join(made.dir, 'runtime-lead.json');
  writeFileSync(runtime, JSON.stringify({ crossSessionInbound: 'accept' }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(runtime, past, past);
  const socket = join(made.sockets, '222.sock');
  writeFileSync(socket, '');
  updateState(made.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.lead = {
      stage: 'ready',
      pane: 'fixture-pane-lead',
      workspace: 'fixture-workspace',
      cli: 'claude-code',
      launch_line: `claude --settings ${runtime}`,
    };
  });
  const frames: string[] = [];
  const host = fake(made, {
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const io = owner(made.root);
  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(frames.length).toBe(1);
  expect(frames[0]).toContain('a note');
  expect(io.out).toContain('lead: delivered (socket)');
  expect(io.err).not.toContain('queued, no event adapter');
});

// The socket fast path's gate is the seat's lock, not its file. A lock file a dead process left
// behind holds nothing, so a frame that meets one still walks the socket. The lock is placed in
// the window between the record's staging and the fast path's own look — the only window the old
// `existsSync` gate covered, since staging's unread hint already clears an older stale lock.
test('a stale lock that appears after staging does not keep a send off the socket', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made, 'accept');
  mkdirSync(join(made.dir, 'seat-locks', 'acme'), { recursive: true });
  const lockPath = seatLockPath(made.dir, 'acme', 'lead');
  const frames: string[] = [];
  const host = fake(made, {
    agents: () => {
      writeFileSync(lockPath, `${2147483646} deadbeef\n`);
      return [{ name: 'lead', pane: 'fixture-pane-lead' }];
    },
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'a note'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames).toHaveLength(1);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)).toMatchObject({ to: 'lead', outcome: 'delivered', via: 'socket' });
});

test('every socket frame ends with the reader line that names its own message id', async () => {
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
  const sent = JSON.parse(frames[0] as string) as { message: { content: string }; msg_id: string };
  const content = sent.message.content;
  // The line names the id the frame carries: an answering seat runs `team reply <id>`, a seat
  // that needs no answer runs `team ack <id>`, and either writes the seat's own signed read
  // receipt (ADR D3). It is the content's own last line, once, and it addresses the record
  // rather than the sender — an owner-origin frame carries the same line as a seat's.
  const reader = `Answer with team reply ${sent.msg_id} "…" (this marks it read), or team ack ${sent.msg_id} if no answer is needed.`;
  expect(content.split('\n').at(-1)).toBe(reader);
  expect(content.split('\n').filter((line) => line === reader)).toHaveLength(1);
});

test('a reader line written in the body never moves the line the frame ends with', async () => {
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
  const wrote = 'Answer with team reply 00000000-0000-4000-8000-000000000000 "…" (this marks it read), or team ack 00000000-0000-4000-8000-000000000000 if no answer is needed.';

  const code = await runSend(['lead', `a note\n${wrote}`], owner(made.root), host);

  expect(code).toBe(0);
  const sent = JSON.parse(frames[0] as string) as { message: { content: string }; msg_id: string };
  const content = sent.message.content;
  // The body is carried as written, and the frame's own last line still names its own id.
  expect(content).toContain(`a note\n${wrote}`);
  expect(content.split('\n').at(-1)).toBe(`Answer with team reply ${sent.msg_id} "…" (this marks it read), or team ack ${sent.msg_id} if no answer is needed.`);
});

test('an owner send names its own record id, not the entity’s owner-reply target', async () => {
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
  const sent = JSON.parse(frames[0] as string) as { message: { content: string }; msg_id: string };
  // The declared owner-reply target is a policy `team reply` still answers the owner through;
  // the frame's reader line does not name it, because the line addresses the record by id.
  expect(sent.message.content.split('\n').at(-1)).toBe(`Answer with team reply ${sent.msg_id} "…" (this marks it read), or team ack ${sent.msg_id} if no answer is needed.`);
  expect(sent.message.content).not.toContain('coordinator@acme');
});

test('an owner send in a team that names no entity still dials a frame: the reader line needs no address', async () => {
  // The frame used to be withheld for an owner origin with no `owner-reply-to` target to name.
  // The reader line names the record's own id, so nothing about the sender's address is needed
  // and the socket leg runs like any other.
  const made = world(null);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const frames: string[] = [];
  const host = fake(made, {
    native: pane,
    deliver: async (_path: string, frame: string) => {
      frames.push(frame);
      return { ok: true };
    },
  });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(frames.length).toBe(1);
  const sent = JSON.parse(frames[0] as string) as { message: { content: string }; msg_id: string };
  expect(sent.message.content.split('\n').at(-1)).toBe(`Answer with team reply ${sent.msg_id} "…" (this marks it read), or team ack ${sent.msg_id} if no answer is needed.`);
  expect(pane.typed.length).toBe(0);
});

test('the reader line is the same one for every sender: the id addresses the record, never the sender', () => {
  const id = '3f2b0c1e-0000-4000-8000-000000000001';
  expect(readerLine(id)).toBe(`Answer with team reply ${id} "…" (this marks it read), or team ack ${id} if no answer is needed.`);
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
  expect(pane.typed.length).toBe(0);
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
  expect(pane.typed.length).toBe(0);
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
  expect(pane.typed.length).toBe(0);
});

test('a declared order’s typed word wakes through the seat’s accepted socket, and nothing is typed', async () => {
  // The word asks for a wake. With typing retired, the seat's own event adapter stands where the
  // word stood: the live channel, then the socket its launch accepts. The frame's reader line
  // names the record's own id, so an owner-origin send needs no reply address to dial it.
  const made = world(['mcp-inbox', 'typed']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  expect(pane.typed.length).toBe(0);
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

test('a declared order that puts the typed leg first wakes there, and its later socket word is never reached', async () => {
  // The typed word's wake is the seat's own accepted socket, spliced where the word stood: the
  // first frame is taken there, and the socket word written behind it is never walked.
  const made = world(['typed', 'socket']);
  cleanup = made.cleanup;
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  expect(pane.typed.length).toBe(0);
});

test('a socket leg named for a non-Claude seat is skipped, and the typed leg behind it takes the send', async () => {
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { agents: () => [{ name: 'native', pane: 'w9:p1' }], native: pane });

  const code = await runSend(['native', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  expect(pane.typed.length).toBe(0);
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
  expect(pane.typed.length).toBe(0);

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

test('a signed entity order that places typed before socket wakes through the seat’s socket', async () => {
  // The entity's word is walked as written. Its typed word stands for the seat's accepted socket,
  // spliced where the word stood, so the frame is taken there before the socket word behind it.
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made);
  setOrder(made, 'entity', 'acme-corp', ['typed', 'socket']);
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  expect(pane.typed.length).toBe(0);
});

test('a signed project order that places typed before socket wakes through the seat’s socket', async () => {
  const made = world(null);
  cleanup = made.cleanup;
  upsertProject(made.home, 'acme-proj', { name: 'Acme', teams: [teamIdOf(made.root)], at: NOW.toISOString() });
  setOrder(made, 'project', 'acme-proj', ['typed', 'socket']);
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['lead', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames.length).toBe(1);
  expect(pane.typed.length).toBe(0);
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
  expect(pane.typed.length).toBe(0);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    `typed: ${NO_PANE_MESSAGING}`,
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
  expect(pane.typed.length).toBe(0);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    `typed: ${NO_PANE_MESSAGING}`,
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
  expect(pane.typed.length).toBe(0);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    `typed: ${NO_PANE_MESSAGING}`,
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
  expect(pane.typed.length).toBe(0);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    `typed: ${NO_PANE_MESSAGING}`,
    'socket: the receiving Claude session does not declare crossSessionInbound accept (human-launched or launch without --settings; owner CLI settings are not read)',
  ]);
});

test('a generated settings file with no accept word names the file in the send’s reason', async () => {
  // The file is on the launch line, so it is the whole effective word: its silence is the reason
  // the socket is skipped, and the send names the file a relaunch would rewrite.
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer', launch: 'claude' }]);
  cleanup = made.cleanup;
  const path = declareSeat(made, 'plain', null);
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });

  const code = await runSend(['plain', 'hello'], owner(made.root), host);

  expect(code).toBe(0);
  expect(host.frames).toEqual([]);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    `typed: ${NO_PANE_MESSAGING}`,
    `socket: the receiving Claude session does not declare crossSessionInbound accept in its launch-effective settings (${path}); owner CLI settings are not read`,
  ]);
});

test('a socket recorded for a seat that no longer exists is reported under its real class, never dialed', async () => {
  // The registry's record names the socket the seat's last session listened on; that file is
  // gone, and the pane answers no processes, as a closed session's pane would. The address is
  // not an attempt: the send says the seat can only be reached at its next turn and leaves the
  // message where that turn reads it.
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer' }]);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declareSeat(made, 'plain', 'accept');
  const gone = join(made.sockets, '424242.sock');
  const pane = 'fixture-pane-1';
  const id = teamIdOf(made.root);
  const record = registerAgent(made.home, {
    name: 'plain',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'plain', session: 'acme', pane, address: gone },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, id, {
    project: 'acme',
    entity: 'floor',
    session: 'acme',
    root: made.root,
    lobby: resolveLobby(made.home, { entity: 'floor' }),
    roster: [{ agent: record.id, seat: 'plain', role: 'implementer', leads: false }],
    lifecycle: 'running',
  });
  let dialed = 0;
  const host = fake(made, {
    agents: () => [{ name: 'plain', pane }],
    processInfo: () => null,
    deliver: async () => {
      dialed += 1;
      return { ok: true };
    },
  });
  const outside = join(made.root, '..', 'nowhere');
  mkdirSync(outside, { recursive: true });

  const io = testIo(outside, { kind: 'owner' });
  const code = await runSend(['plain@acme', 'hello'], io, host);

  expect(code).toBe(0);
  // The recorded path was never opened, and no frame left the sender.
  expect(dialed).toBe(0);
  expect(host.frames).toEqual([]);
  expect(existsSync(gone)).toBe(false);
  // The final line follows the class the walk proved, never the one cached before it: nothing
  // was woken, and the message waits for the seat's next turn.
  expect(withoutSendId(io.out)).toBe(
    'team acme, session "acme"\nplain: queued, not woken (drop, 0 ms); queued; plain reads it at its next turn, and nothing here gives it one (pull-only)\n',
  );
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)?.failed).toEqual([
    `typed: ${NO_PANE_MESSAGING}`,
    `socket: the socket recorded for plain (${gone}) is gone; queued; plain reads it at its next turn, and nothing here gives it one (pull-only)`,
  ]);
  // The message still waits where the seat's next turn reads it.
  expect(readdirSync(dropDir(made.dir, 'plain')).filter((name) => !name.includes('.')).length).toBe(1);
});

test('a recorded socket the pane does not own is no attempt, and the line follows what the walk proved', async () => {
  // The registry names a socket that still stands on disk, but it is not one of the pane's
  // processes and the pane exposes none of its own. The class read before the walk sees an
  // accepted declaration and a standing address and would say the seat is woken; the walk
  // proves there is no route to dial, so nothing is dialed and the line says what is true.
  const made = world(['socket', 'typed'], [{ name: 'plain', role: 'implementer' }]);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  const settings = cliHookSettingsPath(made.dir, 'acme', 'plain');
  if (settings === null) throw new Error('the fixture declares no settings path for plain');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ crossSessionInbound: 'accept' }));
  utimesSync(settings, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const standing = join(made.sockets, '424242.sock');
  writeFileSync(standing, '');
  const id = teamIdOf(made.root);
  const record = registerAgent(made.home, {
    name: 'plain',
    signing: { model: 'Test', version: '1', role: 'implementer' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: id, seat: 'plain', session: 'acme', pane: 'fixture-pane-1', address: standing },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  upsertTeam(made.home, id, {
    project: 'acme',
    entity: 'floor',
    session: 'acme',
    root: made.root,
    lobby: resolveLobby(made.home, { entity: 'floor' }),
    roster: [{ agent: record.id, seat: 'plain', role: 'implementer', leads: false }],
    lifecycle: 'running',
  });
  const dials: string[] = [];
  const host = fake(made, {
    agents: () => [{ name: 'plain', pane: 'fixture-pane-1' }],
    processInfo: () => ({ shell: 100, foreground: [200] }),
    deliver: async (path: string) => {
      dials.push(path);
      return { ok: true };
    },
  });
  const outside = join(made.root, '..', 'nowhere');
  mkdirSync(outside, { recursive: true });

  const io = testIo(outside, { kind: 'owner' });
  const code = await runSend(['plain@acme', 'hello'], io, host);

  expect(code).toBe(0);
  // The recorded path stands, but it is not the pane's socket and the pane exposes none: no dial.
  expect(existsSync(standing)).toBe(true);
  expect(dials).toEqual([]);
  expect(host.frames).toEqual([]);
  expect(withoutSendId(io.out)).toBe(
    'team acme, session "acme"\nplain: queued, not woken (drop, 0 ms); queued; plain reads it at its next turn, and nothing here gives it one (pull-only)\n',
  );
});

test('a taken socket frame is delivered at the frame: the sender reads no pane and leaves no mark', async () => {
  // The receiver's box shows its held-message dialog, but the sender's work ends when the frame
  // is taken: it reports `delivered (socket)` at once, reads no pane and writes no `held` line.
  // Whether the frame sat at the dialog is the daemon's held step to see on its own beat, and a
  // person's send waits on no other seat's screen. No mark is left for a hold this send did not
  // see, so with no daemon pass nothing here blocks the next dial.
  const made = world(['socket', 'typed']);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  const settings = declare(made, 'accept');
  const rule = '─'.repeat(30);
  const heldDialog = `Held message from another session\n${rule}\n❯ \n${rule}`;
  let reads = 0;
  const pane = scripted(['idle', 'working', 'idle']);
  pane.paneText = () => {
    reads += 1;
    return heldDialog;
  };
  const host = fake(made, { native: pane });

  const io = owner(made.root);
  expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
  expect(io.out).toContain('lead: delivered (socket)');
  expect(host.frames).toHaveLength(1);
  expect(pane.typed).toEqual([]);
  // One look, and it is the quota preflight every send makes before its legs; the held-dialog
  // probe that used to poll this box for up to a second is gone.
  expect(reads).toBe(1);
  expect(existsSync(join(made.dir, 'send-held', 'acme', 'lead.json'))).toBe(false);
  const history = readHistory('acme', made.root, made.home);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.entries.at(-1)).toMatchObject({ to: 'lead', id: expect.any(String), outcome: 'delivered', via: 'socket' });
  expect(history.entries.some((entry) => entry.outcome === 'held')).toBe(false);
  // The declaration is untouched: nothing moved it, and the socket stays eligible.
  expect(readFileSync(settings, 'utf8')).toBe(JSON.stringify({ crossSessionInbound: 'accept' }));
});

test('a held socket is no wake the send reports either: the class it appends is pull-only', async () => {
  // The receiver accepts its socket and the registry names the address standing in its pane. The
  // box held the last frame under the declaration now in force: the walk skips the socket, and
  // the class a console line appends must agree with the walk rather than promise a wake. This
  // class reads no pane processes, like next, plan and up: the conservative rule stands, and a
  // recorded address that still stands is the only socket evidence it counts.
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  declare(made, 'accept');
  const socket = join(made.sockets, '222.sock');
  registerAgent(made.home, {
    name: 'lead',
    signing: { model: 'Test', version: '1', role: 'coordinator' },
    lab: 'test-lab',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude',
    reach: { team: teamIdOf(made.root), seat: 'lead', session: 'acme', pane: 'fixture-pane-lead', address: socket },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'up',
  });
  recordHeldSocket(
    heldSocketPath(made.dir, 'acme', 'lead'),
    declaredInboundOf({ dir: made.dir, root: made.root, session: 'acme', seat: 'lead', launch: 'claude' }),
    new Date(NOW),
  );
  const host = fake(made);
  const io = owner(made.root);
  expect(await runSend(['lead', 'hello'], io, host)).toBe(0);
  expect(host.frames).toEqual([]);
  expect(withoutSendId(io.out)).toBe(
    'team acme, session "acme"\nlead: queued, not woken (drop, 0 ms); queued; lead reads it at its next turn, and nothing here gives it one (pull-only)\n',
  );
});

test('no pane messaging: a declared order whose wake word is typed reaches an accepting seat by its socket', async () => {
  // The order names typed for the wake; typing is retired, so the seat's own event adapter, the
  // socket its launch accepts, stands where typed stood. Nothing is typed into the pane.
  const made = world(null);
  cleanup = made.cleanup;
  declareEntity(made, 'floor');
  setOrder(made, 'team', made.root, ['mcp-inbox', 'typed']);
  declare(made, 'accept');
  const pane = scripted(['idle', 'working']);
  const host = fake(made, { native: pane });
  const io = owner(made.root);

  const code = await runSend(['lead', 'a note'], io, host);

  expect(code).toBe(0);
  expect(io.out).toContain('lead: delivered (socket)');
  expect(io.err).not.toContain('queued, no event adapter');
  expect(host.frames.length).toBe(1);
  expect(pane.typed).toEqual([]);
});
