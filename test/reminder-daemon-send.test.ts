// The machine daemon's reminder identity: the state record and single-instance lock prove this
// process is the daemon, the daemon principal carries the recipients one due instant addresses,
// and admission refuses every address outside that list, every rooted elsewhere, every human
// seat and the owner. Nothing here builds a daemon state record for a process that is not this
// one — the verifier's own proof is that the record names this process — and the transport is
// the fixture's fake socket and scripted pane, never a live session or CLI home.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { admissionOf, runSend, type DaemonRecipient, type DaemonSendPrincipal } from '../src/commands/send.ts';
import { daemonLockPath, daemonStatePath } from '../src/daemon/paths.ts';
import { writeDaemonState, type DaemonRootState, type DaemonState } from '../src/daemon/state.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { MESSAGE_ID } from '../src/mcp/inbox.ts';
import { DAEMON_BEAT_MS, verifyDaemonAuthority, type DaemonIdentity } from '../src/reminder/authority.ts';
import { sendDaemonDirect } from '../src/reminder/direct-send.ts';
import { dropDir, fake, NOW, owner, scripted, world, type World } from './send-native-fixtures.ts';

const AT = new Date('2026-11-02T18:00:00.000Z');
const BODY = 'Please update the Linear activity before the next cycle.';
const SESSION = 'acme';
const PANE = 'w1:p1';
const daemonCaller: Caller = { kind: 'daemon' };

const homes: string[] = [];
const made: World[] = [];
afterEach(() => {
  for (const base of homes.splice(0)) rmSync(base, { recursive: true, force: true });
  for (const one of made.splice(0)) one.cleanup();
});

/** A machine folder for one authority scene: the home the daemon's record and lock live in. */
function machineHome(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reminder-authority-')));
  homes.push(base);
  return join(base, 'home');
}

/** The daemon's state record, written the way the daemon writes it. Every field is the real
 *  shape; a scene overrides the one fact it is about. */
function daemonRecord(home: string, over: Partial<DaemonState> = {}): DaemonState {
  const state: DaemonState = {
    format: 1,
    pid: process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : -1,
    since: '2026-11-02T17:00:00.000Z',
    startedBy: 'test',
    version: 'test',
    heartbeatAt: AT.toISOString(),
    socket: join(home, '.config', 'team', 'daemon.sock'),
    features: { broker: 'absent' },
    stuck: [],
    roots: [],
    ...over,
  };
  writeDaemonState(home, state);
  return state;
}

/** The daemon's single-instance lock: one line, the holder's pid. */
function daemonLock(home: string, pid: number = process.pid): void {
  mkdirSync(dirname(daemonLockPath(home)), { recursive: true });
  writeFileSync(daemonLockPath(home), `${String(pid)}\n`);
}

function hostRoot(root: string): DaemonRootState {
  return { root, team: SESSION, send: 'serving', bus: 'serving', why: null };
}

describe('the daemon authority', () => {
  test('a fresh record and the lock naming this process: the daemon stands, with its roots', () => {
    const home = machineHome();
    daemonRecord(home, { roots: [hostRoot('/work/acme')] });
    daemonLock(home);
    const verdict = verifyDaemonAuthority({ home, now: AT });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.roots).toEqual(['/work/acme']);
    expect(verdict.identity).toEqual({ pid: process.pid, since: '2026-11-02T17:00:00.000Z', socket: join(home, '.config', 'team', 'daemon.sock') });
  });

  test('a missing record never proves the daemon', () => {
    const verdict = verifyDaemonAuthority({ home: machineHome(), now: AT });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('the daemon state record is missing');
  });

  test('a record that is not JSON is refused with the reader\'s own reason', () => {
    const home = machineHome();
    mkdirSync(dirname(daemonStatePath(home)), { recursive: true });
    writeFileSync(daemonStatePath(home), 'not json');
    const verdict = verifyDaemonAuthority({ home, now: AT });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('not readable JSON');
  });

  test('a record naming another process is not this process, whatever it claims', () => {
    const home = machineHome();
    daemonRecord(home, { pid: process.pid + 1 });
    daemonLock(home, process.pid + 1);
    const verdict = verifyDaemonAuthority({ home, now: AT });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain(`names process ${String(process.pid + 1)}, and this process is ${String(process.pid)}`);
  });

  test('a record naming another user\'s daemon is refused before any transport', () => {
    const home = machineHome();
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    daemonRecord(home, { uid: uid + 1 });
    daemonLock(home);
    const verdict = verifyDaemonAuthority({ home, now: AT });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain("names another user's daemon");
  });

  test('a heartbeat older than three beats is stale; exactly three beats still stands', () => {
    const home = machineHome();
    daemonRecord(home, { heartbeatAt: new Date(AT.getTime() - DAEMON_BEAT_MS * 3).toISOString() });
    daemonLock(home);
    expect(verifyDaemonAuthority({ home, now: AT }).ok).toBe(true);

    daemonRecord(home, { heartbeatAt: new Date(AT.getTime() - DAEMON_BEAT_MS * 3 - 1).toISOString() });
    const stale = verifyDaemonAuthority({ home, now: AT });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.why).toContain('heartbeat is stale');
  });

  test('the single-instance lock must name the record\'s process, and an absent lock names none', () => {
    const home = machineHome();
    daemonRecord(home);
    const missing = verifyDaemonAuthority({ home, now: AT });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.why).toContain('lock names no process');

    daemonLock(home, process.pid + 1);
    const other = verifyDaemonAuthority({ home, now: AT });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.why).toContain(`lock names process ${String(process.pid + 1)}`);
  });

  test('a replaced daemon never inherits the identity an earlier send was established on', () => {
    const home = machineHome();
    daemonRecord(home);
    daemonLock(home);
    const captured: DaemonIdentity = { pid: process.pid, since: '2026-11-02T16:00:00.000Z', socket: join(home, 'old.sock') };
    const verdict = verifyDaemonAuthority({ home, now: AT, captured });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('a replaced daemon never inherits an earlier send');
  });
});

/** The receiving seat's declaration that it accepts a cross-session frame, and the socket its
 *  pane exposes, written so the declaration predates the socket. */
function receives(one: World): void {
  const path = cliHookSettingsPath(one.dir, SESSION, 'lead');
  if (path === null) throw new Error('the fixture declares no settings path for lead');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ crossSessionInbound: 'accept' }));
  writeFileSync(join(one.sockets, '222.sock'), '');
  const at = Date.now() - 60_000;
  utimesSync(path, new Date(at), new Date(at));
}

/** The living daemon the fixture's host stands on: its record hosts the world's checkout, its
 *  heartbeat is the host's own clock, and the lock names this process. */
function daemonOf(one: World): void {
  daemonRecord(one.home, { heartbeatAt: NOW.toISOString(), roots: [hostRoot(one.root)] });
  daemonLock(one.home);
}

function recipientsOf(one: World, seat = 'lead'): DaemonRecipient[] {
  return [{ root: one.root, session: SESSION, seat }];
}

function staged(one: World, seat = 'lead'): string[] {
  try {
    return readdirSync(dropDir(one.dir, seat)).filter((name) => MESSAGE_ID.test(name));
  } catch {
    return [];
  }
}

/** A reminder send with a hand-made principal: the admission scenes below read the rules, not
 *  the verifier, which the authority scenes above own. */
function principalOf(one: World, over: Partial<DaemonSendPrincipal> = {}, seat = 'lead'): DaemonSendPrincipal {
  return {
    reminder: 'linear-activity',
    due: '2026-11-02T19:00',
    recipients: recipientsOf(one, seat),
    roots: [one.root],
    recheck: () => ({ ok: true }),
    ...over,
  };
}

describe('a reminder send carries the daemon\'s own identity', () => {
  test('delivers over the socket as the daemon, never as the owner or a seat', async () => {
    const one = world(null);
    made.push(one);
    receives(one);
    daemonOf(one);
    const frames: string[] = [];
    const host = fake(one, {
      native: scripted(['idle'], null),
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendDaemonDirect(
      { reminder: 'linear-activity', due: '2026-11-02T19:00', recipients: recipientsOf(one) },
      { root: one.root, seat: 'lead', body: BODY },
      host,
    );

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.staged).toBe(true);
    expect(frames).toHaveLength(1);
    const ids = staged(one);
    expect(ids).toHaveLength(1);
    expect(result.id).toBe(ids[0] as string);
    const record = readFileSync(join(dropDir(one.dir, 'lead'), ids[0] as string), 'utf8');
    expect(record).toContain('"from": "daemon"');
    expect(record).toContain('"from_id": null');
    expect(record).toContain("from the daemon — admitted by: the daemon's reminder authority");
    expect(record).not.toContain('from the owner');
  });

  test('a second attempt keeps its message id and adds no second record', async () => {
    const one = world(null);
    made.push(one);
    receives(one);
    daemonOf(one);
    const frames: string[] = [];
    const host = fake(one, {
      native: scripted(['idle'], null),
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });
    const context = { reminder: 'linear-activity', due: '2026-11-02T19:00', recipients: recipientsOf(one) };

    const first = await sendDaemonDirect(context, { root: one.root, seat: 'lead', body: BODY }, host);
    expect(first.ok).toBe(true);
    expect(first.staged).toBe(true);
    const stagedAfterFirst = staged(one);
    expect(stagedAfterFirst).toEqual([first.id as string]);

    // The retry a later beat makes reuses the recorded id: the same message, one record, and
    // the receiver judges it by that one id.
    const second = await sendDaemonDirect(context, { root: one.root, seat: 'lead', body: BODY, id: first.id as string }, host);
    expect(second.ok).toBe(true);
    expect(second.id).toBe(first.id as string);
    expect(staged(one)).toEqual(stagedAfterFirst);
  });

  test('a record that is missing refuses before anything is staged or dialled', async () => {
    const one = world(null);
    made.push(one);
    receives(one);
    const frames: string[] = [];
    const host = fake(one, {
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendDaemonDirect(
      { reminder: 'linear-activity', due: '2026-11-02T19:00', recipients: recipientsOf(one) },
      { root: one.root, seat: 'lead', body: BODY },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.id).toBeNull();
    expect(result.staged).toBe(false);
    expect(result.text).toContain('the daemon state record is missing');
    expect(staged(one)).toEqual([]);
    expect(frames).toEqual([]);
  });

  test('a seat the due instant does not address is refused with nothing sent', async () => {
    const one = world(null);
    made.push(one);
    receives(one);
    daemonOf(one);
    const frames: string[] = [];
    const host = fake(one, {
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendDaemonDirect(
      { reminder: 'linear-activity', due: '2026-11-02T19:00', recipients: recipientsOf(one, 'helper') },
      { root: one.root, seat: 'lead', body: BODY },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.staged).toBe(false);
    expect(result.text).toContain('the reminder\'s due instant does not address this seat');
    expect(staged(one)).toEqual([]);
    expect(frames).toEqual([]);
  });

  test('a human seat is refused: the daemon addresses seats, never a person\'s pane', async () => {
    const one = world(null);
    made.push(one);
    receives(one);
    const path = join(one.dir, 'team.yaml');
    const text = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      text.replace(
        '    name: lead\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n',
        '    name: lead\n    cli: claude-code\n    vendor: test\n    model: Test\n    version: "1"\n    launch: claude\n    human: true\n',
      ),
    );
    daemonOf(one);
    const frames: string[] = [];
    const host = fake(one, {
      deliver: async (_socket, frame) => {
        frames.push(frame);
        return { ok: true };
      },
    });

    const result = await sendDaemonDirect(
      { reminder: 'linear-activity', due: '2026-11-02T19:00', recipients: recipientsOf(one) },
      { root: one.root, seat: 'lead', body: BODY },
      host,
    );

    expect(result.ok).toBe(false);
    expect(result.text).toContain("the pane is a person's, and the daemon addresses seats only");
    expect(staged(one)).toEqual([]);
    expect(frames).toEqual([]);
  });

  test('the recheck runs before every leg: a daemon that stopped sends no further leg', async () => {
    // Two legs this build walks: the socket dial fails at once (no listener answers the fixture
    // socket), so the walk reaches the drop leg, and the refusal lands before that leg begins.
    // An `mcp-inbox` word is no leg in this build, so an order naming it would leave one leg.
    const one = world(['socket', 'drop']);
    made.push(one);
    let checks = 0;
    const base = principalOf(one, {
      recheck: () => {
        checks += 1;
        return checks === 1 ? { ok: true } : { ok: false, why: 'the daemon state record is gone' };
      },
    });
    const io = owner(one.root);
    const host = fake(one, { daemon: base, native: scripted(['idle'], null) });

    const code = await runSend(['lead', BODY], io, host);

    expect(code).toBe(1);
    expect(`${io.err}${io.out}`).toContain("the daemon's identity no longer stands");
    expect(checks).toBeGreaterThanOrEqual(2);
    // The first leg ran and wrote nothing that could reach the seat; the second never began.
    expect(staged(one)).toEqual([]);
    expect(existsSync(dropDir(one.dir, 'lead'))).toBe(false);
  });

  test('a recheck that throws is a refusal, never consent', async () => {
    const one = world(['mcp-inbox', 'drop']);
    made.push(one);
    daemonOf(one);
    const base = principalOf(one, {
      recheck: () => {
        throw new Error('the record could not be read');
      },
    });
    const io = owner(one.root);
    const code = await runSend(['lead', BODY], io, fake(one, { daemon: base }));

    expect(code).toBe(1);
    expect(`${io.err}${io.out}`).toContain('the record could not be read');
    expect(staged(one)).toEqual([]);
  });
});

describe('the daemon admission, rule by rule', () => {
  function teamOf(one: World) {
    const loaded = validateTeamFile(readFileSync(join(one.dir, 'team.yaml'), 'utf8'));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    return loaded.team;
  }

  function admit(one: World, seatName: string, daemon: { principal: DaemonSendPrincipal; root: string } | undefined) {
    return admissionOf(daemonCaller, teamOf(one), null, seatName, one.home, 'team-id', () => AT, { session: SESSION }, undefined, undefined, daemon);
  }

  test('a run with no daemon principal is refused: nothing stands behind it', () => {
    const one = world(null);
    made.push(one);
    expect(admit(one, 'lead', undefined)).toEqual({ ok: false, why: 'the daemon sends only through its own internal entry; no principal stands behind this run' });
  });

  test('a checkout the daemon did not host is another team, even under the same session name', () => {
    const one = world(null);
    made.push(one);
    const base = principalOf(one, { roots: [join(one.root, 'elsewhere')] });
    const verdict = admit(one, 'lead', { principal: base, root: one.root });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.why).toContain('this run loaded a checkout it did not');
  });

  test('the owner is never addressed, and an undeclared seat never either', () => {
    const one = world(null);
    made.push(one);
    const ownerVerdict = admit(one, 'owner', { principal: principalOf(one, {}, 'owner'), root: one.root });
    expect(ownerVerdict).toEqual({ ok: false, why: 'owner: the daemon addresses a declared seat of a team it hosts, never the owner' });

    const ghost = principalOf(one, { recipients: recipientsOf(one, 'ghost') }, 'ghost');
    const ghostVerdict = admit(one, 'ghost', { principal: ghost, root: one.root });
    expect(ghostVerdict.ok).toBe(false);
    if (ghostVerdict.ok) return;
    expect(ghostVerdict.why).toContain('it is not a declared seat');
  });

  test('a declared, hosted, addressed seat is admitted by the daemon\'s own rule', () => {
    const one = world(null);
    made.push(one);
    expect(admit(one, 'lead', { principal: principalOf(one), root: one.root })).toEqual({
      ok: true,
      rule: "the daemon's reminder authority",
      sender: 'daemon',
    });
  });
});
