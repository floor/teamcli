// The delivery classes: each shipped profile's measured word, the launch refinement that turns
// it into what a seat actually has, and the plain words a console prints. The refinement is
// pinned case by case because dispatch and `up` now refuse or warn on it: a seat read as
// wakeable when it is not would spend an attempt on a message nothing delivers.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declaredDeliveryClass,
  deliveryWords,
  effectiveDeliveryClass,
  seatDeliveryClass,
  wakeableWhileIdle,
  type DeliveryFacts,
} from '../src/launch/delivery-class.ts';
import { DELIVERY_CLASSES, profileFor } from '../src/profiles/profile.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { declaredInboundOf, heldSocketPath, recordHeldSocket } from '../src/send/inbound.ts';

const FACTS: DeliveryFacts = {
  declared: 'push',
  watcher: 'hook',
  channel: false,
  socket: false,
  endpoint: false,
};

const CLASS_OF = (over: Partial<DeliveryFacts>): string =>
  effectiveDeliveryClass({ ...FACTS, ...over });

const BINDING = 'prs_0123456789ab';

describe('the shipped profiles', () => {
  test('every CLI declares one measured class, and the table is the measurement', () => {
    const measured: Record<string, string> = {
      'claude-code': 'push',
      codex: 'between-turns',
      cursor: 'pull-on-turn',
      gemini: 'pull-on-turn',
      grok: 'pull-on-turn',
      antigravity: 'pull-on-turn',
      muse: 'none',
      jules: 'none',
    };
    for (const [cli, cls] of Object.entries(measured)) {
      const profile = profileFor(cli);
      expect(profile).not.toBeNull();
      expect(`${cli} ${profile!.delivery}`).toBe(`${cli} ${cls}`);
      expect((DELIVERY_CLASSES as readonly string[]).includes(profile!.delivery)).toBe(true);
    }
  });

  test('a CLI with no shipped profile declares none', () => {
    expect(declaredDeliveryClass('no-such-cli')).toBe('none');
  });
});

describe('the launch refines the declared class', () => {
  test('an event adapter makes the seat push, whichever one the launch installed', () => {
    expect(CLASS_OF({ channel: true })).toBe('push');
    expect(CLASS_OF({ socket: true })).toBe('push');
    expect(CLASS_OF({ channel: true, watcher: 'none' })).toBe('push');
  });

  test('a push seat whose launch turned no adapter on falls to its watcher', () => {
    expect(CLASS_OF({})).toBe('pull-on-turn');
    expect(CLASS_OF({ watcher: 'none' })).toBe('none');
  });

  test('a runtime queue between turns needs its managed endpoint', () => {
    expect(CLASS_OF({ declared: 'between-turns', watcher: 'inbox', endpoint: true })).toBe('between-turns');
    expect(CLASS_OF({ declared: 'between-turns', watcher: 'inbox' })).toBe('pull-on-turn');
    expect(CLASS_OF({ declared: 'between-turns', watcher: 'none' })).toBe('none');
  });

  test('an inbox read on a turn is pull-only, and nothing at all is none', () => {
    expect(CLASS_OF({ declared: 'pull-on-turn', watcher: 'inbox' })).toBe('pull-on-turn');
    expect(CLASS_OF({ declared: 'pull-on-turn', watcher: 'none' })).toBe('none');
    expect(CLASS_OF({ declared: 'none', watcher: 'none' })).toBe('none');
  });

  test('a person’s pane is never woken, whatever its launch carries', () => {
    expect(CLASS_OF({ human: true, channel: true })).toBe('none');
    expect(CLASS_OF({ human: true, endpoint: true })).toBe('none');
  });

  test('only push and between-turns reach an idle seat', () => {
    expect(wakeableWhileIdle('push')).toBe(true);
    expect(wakeableWhileIdle('between-turns')).toBe(true);
    expect(wakeableWhileIdle('pull-on-turn')).toBe(false);
    expect(wakeableWhileIdle('none')).toBe(false);
  });
});

describe('the plain words', () => {
  test('each class says what happens next, never a bare unconfirmed', () => {
    expect(deliveryWords('push', 'helper')).toBe('woken through its event adapter');
    expect(deliveryWords('between-turns', 'helper')).toBe('woken through its runtime queue');
    expect(deliveryWords('pull-on-turn', 'helper')).toBe('queued; helper reads it at its next turn, and nothing here gives it one (pull-only)');
    expect(deliveryWords('none', 'helper')).toBe('queued; nothing wakes helper while it is idle; a person or a restart must give it a turn');
    // A person's pane is never typed into; a profile that declares the typed wake says the one
    // way an idle seat can still be reached.
    expect(deliveryWords('none', 'helper', { human: true })).toBe('queued; helper has no way to be woken while idle');
    expect(deliveryWords('none', 'helper', { typedWake: true })).toBe('queued; nothing wakes helper while it is idle except a send-time typed wake into an empty composer; a person or a restart must give it a turn');
    // The watch's typed retry is a wake of its own name: a profile that turns it on says so, and
    // one that turns it off keeps the send-time sentence exactly.
    expect(deliveryWords('none', 'helper', { typedWake: true, watchWake: true })).toBe('queued; nothing wakes helper while it is idle except a send-time typed wake and the watch\'s typed retry once a message passes its unread window, into an empty composer; a person or a restart must give it a turn');
    expect(deliveryWords('none', 'helper', { typedWake: true, watchWake: false })).toBe('queued; nothing wakes helper while it is idle except a send-time typed wake into an empty composer; a person or a restart must give it a turn');
    // A watch retry without the typed wake it retries is not a route, and is never said.
    expect(deliveryWords('none', 'helper', { watchWake: true })).toBe('queued; nothing wakes helper while it is idle; a person or a restart must give it a turn');
  });

  test('a wake this run made says what it saw, and one it never reached says that instead', () => {
    const pull = 'helper reads it at its next turn, and nothing here gives it one (pull-only)';
    expect(deliveryWords('pull-on-turn', 'helper', { wake: { attempted: true, reason: 'the second read showed working, not an empty idle prompt; nothing was typed' } }))
      .toBe(`queued; the typed wake failed (the second read showed working, not an empty idle prompt; nothing was typed); ${pull}`);
    expect(deliveryWords('pull-on-turn', 'helper', { wake: { attempted: false, reason: 'the session lists more than one agent with this name' } }))
      .toBe(`queued; the typed wake did not run (the session lists more than one agent with this name); ${pull}`);
    // No attempt at all keeps the sentence it always had: nothing claims a wake the run did not make.
    expect(deliveryWords('pull-on-turn', 'helper')).toBe(`queued; ${pull}`);
  });
});

describe('a seat read from its records', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'delivery-class-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (input: {
    seat?: string;
    declared?: { cli: string; launch: string; human?: true; watchWake?: boolean; inbound?: 'accept' | 'hold' | 'refuse' };
    state?: Parameters<typeof seatDeliveryClass>[0]['state'];
    home?: string;
    processes?: Parameters<typeof seatDeliveryClass>[0]['processes'];
    sockets?: string | readonly string[];
  }) => seatDeliveryClass({
    dir,
    root: dir,
    session: 'acme',
    seat: input.seat ?? 'helper',
    ...(input.declared === undefined ? {} : { declared: input.declared }),
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.home === undefined ? {} : { home: input.home }),
    ...(input.processes === undefined ? {} : { processes: input.processes }),
    ...(input.sockets === undefined ? {} : { sockets: input.sockets }),
  });

  /** The launch a socket seat leaves behind: generated settings that declare accept, a registry
   *  record that names a socket address, and the socket file itself. The settings are written
   *  first and the socket after, so the socket does not predate its declaration. A `pid` names
   *  the socket the way a session names it, so a caller's pane processes can be read against it;
   *  `session` names the record's own session, for a record that belongs to another one;
   *  `address` overrides the address the record names, and null records none. */
  function socketSeat(seat = 'helper', shape: { pid?: number; session?: string; address?: string | null } = {}): { home: string; socket: string } {
    const home = join(dir, 'home');
    mkdirSync(join(dir, 'hooks', 'acme'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'acme', `${seat}.json`), '{"crossSessionInbound":"accept"}\n');
    const socket = join(dir, shape.pid === undefined ? `${seat}.sock` : `${String(shape.pid)}.sock`);
    writeFileSync(socket, '');
    registerAgent(home, {
      name: seat,
      signing: { model: 'Test', version: '1', role: 'builder' },
      lab: 'test-lab',
      cli: 'claude-code',
      launcher: null,
      launch: 'claude',
      reach: { team: teamIdOf(dir), seat, session: shape.session ?? 'acme', pane: 'fixture-pane-9', address: shape.address === undefined ? socket : shape.address },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    return { home, socket };
  }

  test('a claude seat with its hook and no adapter is pull-on-turn, and says so', () => {
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(`${read_.class} ${read_.evidence.watcher} ${read_.evidence.watcherFrom}`)
      .toBe('pull-on-turn hook recorded');
    expect(read_.words).toBe('queued; helper reads it at its next turn, and nothing here gives it one (pull-only)');
    expect(read_.evidence.declared).toBe('push');
  });

  test('the development channel on the line makes the recorded seat push', () => {
    const read_ = read({
      declared: {
        cli: 'claude-code',
        launch: 'claude --dangerously-load-development-channels server:team-inbox',
      },
      state: {
        cli: 'claude-code',
        watcher: 'hook',
        launch_line: 'claude --dangerously-load-development-channels server:team-inbox',
      },
    });
    expect(read_.class).toBe('push');
    expect(read_.evidence.channel).toBe(true);
    expect(read_.words).toBe('woken through its event adapter');
  });

  test('an accepted cross-session socket with a recorded, standing address makes the seat push without any channel', () => {
    const { home } = socketSeat();
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home,
    });
    expect(read_.evidence.socket).toBe(true);
    expect(read_.class).toBe('push');
  });

  test('a socket the launch accepts but whose recorded address is gone is no evidence: pull-on-turn', () => {
    const { home, socket } = socketSeat();
    rmSync(socket, { force: true });
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home,
    });
    expect(read_.evidence.socket).toBe(false);
    expect(read_.class).toBe('pull-on-turn');
    expect(wakeableWhileIdle(read_.class)).toBe(false);
  });

  test('a recorded socket is no evidence once the pane’s processes no longer carry it', () => {
    // The socket is named by the pid that listened on it, and that pid is the pane's own process:
    // the address choice a send makes dials it, so the class counts it.
    const pid = 812345;
    const { home } = socketSeat('helper', { pid });
    const declared = { cli: 'claude-code', launch: 'claude' } as const;
    const state = { cli: 'claude-code', watcher: 'hook' } as const;
    const inHand = { declared, state, home, sockets: [dir] };
    const owned = read({ ...inHand, processes: { shell: pid + 1, foreground: [pid] } });
    expect(owned.evidence.socket).toBe(true);
    expect(owned.class).toBe('push');
    // A relaunch replaced the process: the old file still stands, but the pane carries another
    // pid and no socket of its own, so the walk would not dial and the class must not promise it.
    const replaced = read({ ...inHand, processes: { shell: pid + 1, foreground: [pid + 2] } });
    expect(replaced.evidence.socket).toBe(false);
    expect(replaced.class).toBe('pull-on-turn');
    // A caller that could not read the pane keeps the conservative rule: the recorded address
    // that still stands is the only thing the run has, exactly as a send reads a pane it cannot see.
    const blind = read({ ...inHand });
    expect(blind.evidence.socket).toBe(true);
    expect(blind.class).toBe('push');
  });

  test('a record that names another session is no socket for this one', () => {
    // The registry's record belongs to the session it was written for: another session's address
    // is not this seat's route, whatever stands at the path.
    const { home } = socketSeat('helper', { session: 'other' });
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home,
    });
    expect(read_.evidence.socket).toBe(false);
    expect(read_.class).toBe('pull-on-turn');
  });

  test('the team file’s own inbound word keeps the socket out however the launch declares it', () => {
    const { home } = socketSeat();
    for (const word of ['hold', 'refuse'] as const) {
      const read_ = read({
        declared: { cli: 'claude-code', launch: 'claude', inbound: word },
        state: { cli: 'claude-code', watcher: 'hook' },
        home,
      });
      expect(read_.evidence.socket).toBe(false);
      expect(read_.class).toBe('pull-on-turn');
    }
    const accepted = read({
      declared: { cli: 'claude-code', launch: 'claude', inbound: 'accept' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home,
    });
    expect(accepted.evidence.socket).toBe(true);
    expect(accepted.class).toBe('push');
  });

  test('an accepted declaration with no recorded address and no pane read proves no socket', () => {
    socketSeat();
    const noRecord = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(noRecord.evidence.socket).toBe(false);
    expect(noRecord.class).toBe('pull-on-turn');
    // A caller that cannot name the registry home reads no record either: never a guess.
    const noHome = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home: undefined,
    });
    expect(noHome.evidence.socket).toBe(false);
    expect(noHome.class).toBe('pull-on-turn');
  });

  test('a pane socket the record never named is still a route, when the caller read the pane', () => {
    // The registry may name no address — the record has none, or there is no record at all — and
    // the pane's own foreground process carries the socket anyway. The send's choice discovers it
    // from the processes alone, so the class must count it: dispatch and daemon next skip only
    // what no route can wake.
    const pid = 812346;
    const declared = { cli: 'claude-code', launch: 'claude' } as const;
    const state = { cli: 'claude-code', watcher: 'hook' } as const;
    const processes = { shell: pid + 1, foreground: [pid] };
    mkdirSync(join(dir, 'hooks', 'acme'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'acme', 'helper.json'), '{"crossSessionInbound":"accept"}\n');
    writeFileSync(join(dir, `${String(pid)}.sock`), '');
    // No registry home at all: the launch's declaration is the only word, and the pane carries
    // the socket the walk would dial.
    const noRecord = read({ declared, state, processes, sockets: [dir] });
    expect(noRecord.evidence.socket).toBe(true);
    expect(noRecord.class).toBe('push');
    // A record that names no address reads the same: it proves no route, and the pane does.
    const { home } = socketSeat('helper', { pid, address: null });
    const namedNone = read({ declared, state, home, processes, sockets: [dir] });
    expect(namedNone.evidence.socket).toBe(true);
    expect(namedNone.class).toBe('push');
    // Without a pane read nothing is discovered: the declaration alone stays no evidence.
    const blind = read({ declared, state, home, sockets: [dir] });
    expect(blind.evidence.socket).toBe(false);
    expect(blind.class).toBe('pull-on-turn');
  });

  test('a held socket is not evidence, and the seat stays pull-on-turn', () => {
    mkdirSync(join(dir, 'hooks', 'acme'), { recursive: true });
    writeFileSync(join(dir, 'hooks', 'acme', 'helper.json'), '{"crossSessionInbound":"hold"}\n');
    const read_ = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(read_.evidence.socket).toBe(false);
    expect(read_.class).toBe('pull-on-turn');
  });

  test('the box’s held-frame mark is no evidence either, until its declaration is re-confirmed', () => {
    // The send walked this seat's socket, the receiver's box held the frame, and the mark under
    // `send-held/` says so. The address still stands and the settings still accept, but the class
    // a dispatch reads must agree with the walk that would not dial: the seat is pull-on-turn.
    const { home } = socketSeat();
    const settings = join(dir, 'hooks', 'acme', 'helper.json');
    const declaration = declaredInboundOf({ dir, root: dir, session: 'acme', seat: 'helper', launch: 'claude' });
    recordHeldSocket(heldSocketPath(dir, 'acme', 'helper'), declaration, new Date());
    const held = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home,
    });
    expect(held.evidence.socket).toBe(false);
    expect(held.class).toBe('pull-on-turn');
    expect(wakeableWhileIdle(held.class)).toBe(false);

    // The declaration is re-confirmed by a restarted launch: the settings file is rewritten, and
    // the session's fresh socket is newer than it. The mark no longer stands, and the class is
    // push again — the same reading the send's walk makes.
    const rewrote = new Date(Math.max(Date.now(), (declaration.declaredAt ?? 0) + 2000));
    writeFileSync(settings, '{"crossSessionInbound":"accept"}\n');
    utimesSync(settings, rewrote, rewrote);
    const socket = join(dir, 'helper.sock');
    const fresh = new Date(rewrote.getTime() + 1000);
    utimesSync(socket, fresh, fresh);
    const confirmed = read({
      declared: { cli: 'claude-code', launch: 'claude' },
      state: { cli: 'claude-code', watcher: 'hook' },
      home,
    });
    expect(confirmed.evidence.socket).toBe(true);
    expect(confirmed.class).toBe('push');
  });

  test('a codex seat reads between turns only while its endpoint and its conversation are bound', () => {
    const endpoint = {
      url: `unix://${join(dir, 'codex.sock')}`,
      binding: BINDING,
      pid: 4321,
      started_at: '2026-10-01T00:00:00Z',
    };
    const launched = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: {
        cli: 'codex', watcher: 'inbox', agent_session: 'ses_thread',
        presence_binding: BINDING, codex_endpoint: endpoint,
      },
    });
    expect(launched.evidence.endpoint).toBe(true);
    expect(launched.class).toBe('between-turns');
    expect(launched.words).toBe('woken through its runtime queue');
    // The endpoint is recorded and bound, but the queue is addressed by a conversation and this
    // state names none: no pointer can be handed over, and the seat is read at its next turn.
    const noThread = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: { cli: 'codex', watcher: 'inbox', presence_binding: BINDING, codex_endpoint: endpoint },
    });
    expect(noThread.evidence.endpoint).toBe(false);
    expect(noThread.evidence.conversation).toBe(false);
    expect(noThread.class).toBe('pull-on-turn');
    expect(noThread.words).toBe('queued; helper reads it at its next turn, and nothing here gives it one (pull-only)');
    const rebound = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: {
        cli: 'codex', watcher: 'inbox', agent_session: 'ses_thread',
        presence_binding: 'prs_ba9876543210', codex_endpoint: endpoint,
      },
    });
    expect(rebound.evidence.endpoint).toBe(false);
    expect(rebound.class).toBe('pull-on-turn');
  });

  test('a codex seat whose records name different conversations is read at its next turn', () => {
    const home = join(dir, 'home');
    const endpoint = {
      url: `unix://${join(dir, 'codex.sock')}`,
      binding: BINDING,
      pid: 4321,
      started_at: '2026-10-01T00:00:00Z',
    };
    registerAgent(home, {
      name: 'helper',
      signing: { model: 'GPT Sol', version: '6.1', role: 'builder' },
      lab: 'test-lab',
      cli: 'codex',
      launcher: null,
      launch: 'codex',
      reach: { team: teamIdOf(dir), seat: 'helper', session: 'acme', pane: 'fixture-pane-9', address: null, agent_session: 'ses_record' },
      seat_handle: 'seat_0123456789ab',
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'team up',
    });
    const disagreeing = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: {
        cli: 'codex', watcher: 'inbox', id: 'seat_0123456789ab', agent_session: 'ses_state',
        presence_binding: BINDING, codex_endpoint: endpoint,
      },
      home,
    });
    // The queue would be handed one thread; the two records name different ones, so the push
    // adapter refuses them and the class must not claim the wake either.
    expect(disagreeing.evidence.endpoint).toBe(false);
    expect(disagreeing.evidence.conversation).toBe(false);
    expect(disagreeing.class).toBe('pull-on-turn');
    const agreeing = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: {
        cli: 'codex', watcher: 'inbox', id: 'seat_0123456789ab', agent_session: 'ses_record',
        presence_binding: BINDING, codex_endpoint: endpoint,
      },
      home,
    });
    expect(agreeing.evidence.endpoint).toBe(true);
    expect(agreeing.class).toBe('between-turns');
  });

  test('a codex seat with no endpoint falls to its inbox: pull-on-turn, never between-turns', () => {
    const read_ = read({
      declared: { cli: 'codex', launch: 'codex' },
      state: { cli: 'codex', watcher: 'inbox' },
    });
    expect(read_.evidence.endpoint).toBe(false);
    expect(read_.class).toBe('pull-on-turn');
  });

  test('a launch line with no recorded watcher derives it, and a CLI with no inbox derives none', () => {
    const derived = read({
      declared: { cli: 'codex', launch: 'codex' },
    });
    expect(`${derived.evidence.watcherFrom} ${derived.evidence.watcher}`).toBe('derived inbox');
    const nothing = read({
      declared: { cli: 'muse', launch: 'muse --yolo' },
    });
    expect(`${nothing.evidence.watcherFrom} ${nothing.evidence.watcher}`).toBe('derived none');
    expect(nothing.class).toBe('none');
  });

  test('a CLI with no inbox or adapter is none, and a person’s pane is none', () => {
    const muse = read({
      declared: { cli: 'muse', launch: 'muse --yolo' },
      state: { cli: 'muse', watcher: 'none' },
    });
    expect(muse.class).toBe('none');
    // Muse declares the typed wake, and its profile turns the watch's retry on with it.
    expect(muse.evidence.typedWake).toBe(true);
    expect(muse.evidence.watchWake).toBe(true);
    expect(muse.words).toBe('queued; nothing wakes helper while it is idle except a send-time typed wake and the watch\'s typed retry once a message passes its unread window, into an empty composer; a person or a restart must give it a turn');
    // The seat's own word wins over its profile's: `watch_wake: off` keeps the send-time sentence.
    const off = read({
      declared: { cli: 'muse', launch: 'muse --yolo', watchWake: false },
      state: { cli: 'muse', watcher: 'none' },
    });
    expect(off.evidence.watchWake).toBe(false);
    expect(off.words).toBe('queued; nothing wakes helper while it is idle except a send-time typed wake into an empty composer; a person or a restart must give it a turn');
    const human = read({
      declared: { cli: 'claude-code', launch: 'claude', human: true },
      state: { cli: 'claude-code', watcher: 'hook' },
    });
    expect(human.class).toBe('none');
    expect(human.evidence.human).toBe(true);
  });
});
