// OD50 brief transport: how a general seat brief travels. The scenes cover the entity → project
// → team reading of the enforced `brief-transport` policy, the `message` walk a launch runs over
// the record and claim it already wrote (through the send command's own legs), and the `memory`
// refusal that writes nothing on either side. A human seat exercises the drop leg and a live
// inbox listener exercises the mcp-inbox leg, so no scene reaches herdr.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativePane } from '../src/send/native.ts';
import { historyPath, readHistory } from '../src/send/history.ts';
import { listenerPath, writeListener } from '../src/mcp/inbox.ts';
import {
  MEMORY_TRANSPORT_UNSUPPORTED,
  currentBriefClaim,
  deliverBriefForAttribution,
  generalBriefBody,
  generalBriefId,
  recoverBrief,
  walkBriefDeliveries,
  type CurrentBriefClaim,
} from '../src/launch/general-brief.ts';
import { mintBriefEpoch, mintBriefIncarnation } from '../src/launch/brief-id.ts';
import { briefTransportOf } from '../src/policy/brief-transport.ts';
import { POLICY_CATALOGUE } from '../src/policy/types.ts';
import { writePolicySet } from '../src/policy/sources.ts';
import { emptySession, readState } from '../src/state.ts';
import type { SendHost } from '../src/commands/send.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const NOW_ISO = NOW.toISOString();
const SESSION = 'acme';
const PROJECT = 'acme';
const SEAT = 'worker';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = { base: string; root: string; dir: string; home: string; sockets: string };

function teamYaml(human: boolean): string {
  return `format: 1
project: ${PROJECT}
coordinator: ${SEAT}
operator: ${SEAT}
session: ${SESSION}
workspace:
  mode: shared
seats:
  - role: coordinator
    name: ${SEAT}
    cli: codex
    vendor: test
    model: Test
    version: "1"
    launch: codex
${human ? '    human: true\n' : ''}`;
}

function world(input: { human?: boolean } = {}): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'brief-transport-')));
  made.push(base);
  const root = join(base, PROJECT);
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(sockets, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), teamYaml(input.human === true));
  return { base, root, dir, home, sockets };
}

function setTransport(w: World, value: 'file' | 'message' | 'memory'): void {
  const wrote = writePolicySet(
    w.home,
    { level: 'team', target: w.root, teamRoot: w.root, name: 'brief-transport', value },
    { now: NOW },
  );
  if (!wrote.ok) throw new Error(wrote.why);
}

function fake(w: World): SendHost {
  const native: NativePane = {
    typeText: () => {
      throw new Error('no scene types into a pane');
    },
    pressEnter: () => {
      throw new Error('no scene types into a pane');
    },
    status: () => 'idle',
    wait: async () => {},
  };
  return {
    agents: () => [],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home: w.home,
    inboxGraceMs: 0,
  };
}

/** Delivers the general brief once, the way a launch does, and returns the sync report. */
function deliver(w: World, input: { human?: boolean; cli?: string } = {}) {
  return deliverBriefForAttribution({
    dir: w.dir,
    root: w.root,
    session: SESSION,
    home: w.home,
    now: NOW,
    team: { seats: [{ name: SEAT, ...(input.human === true ? { human: true } : {}), ...(input.cli === undefined ? {} : { cli: input.cli }) }] },
    state: readState(w.dir).sessions[SESSION] ?? emptySession(),
    attributed: [SEAT],
  });
}

function dropDir(w: World): string {
  return join(w.dir, 'send-drops', SESSION, SEAT);
}

function claimOf(w: World): CurrentBriefClaim | null {
  return currentBriefClaim(readState(w.dir).sessions[SESSION]?.briefs?.[SEAT]);
}

describe('the brief-transport reading', () => {
  test('the catalogue entry: entity, project and team; file by default; message tightens, memory is its own word', () => {
    const entry = POLICY_CATALOGUE['brief-transport'];
    expect(entry.levels).toEqual(['entity', 'project', 'team']);
    expect(entry.defaultValue).toBe('file');
    expect(entry.kind).toBe('enforced');
    expect(entry.parseValue('file')).toBe('file');
    expect(entry.parseValue('message')).toBe('message');
    expect(entry.parseValue('memory')).toBe('memory');
    expect(entry.parseValue('socket')).toBeNull();
    // `message` is within `file`; `memory` is comparable only to itself.
    expect(entry.isWithin?.('message', 'file')).toBe(true);
    expect(entry.isWithin?.('file', 'message')).toBe(false);
    expect(entry.isWithin?.('file', 'file')).toBe(true);
    expect(entry.isWithin?.('memory', 'memory')).toBe(true);
    expect(entry.isWithin?.('message', 'memory')).toBe(false);
    expect(entry.isWithin?.('memory', 'file')).toBe(false);
  });

  test('no policy reads as file at the default', () => {
    const w = world();
    expect(briefTransportOf({ home: w.home, root: w.root, now: NOW })).toEqual({ transport: 'file', level: 'default' });
  });

  test('the team level names message, and memory is its own reading', () => {
    const w = world();
    setTransport(w, 'message');
    expect(briefTransportOf({ home: w.home, root: w.root, now: NOW })).toEqual({ transport: 'message', level: 'team' });
    setTransport(w, 'memory');
    expect(briefTransportOf({ home: w.home, root: w.root, now: NOW })).toEqual({ transport: 'memory', level: 'team' });
  });

  test('a chain that does not verify falls back to file and says why', () => {
    const w = world();
    setTransport(w, 'message');
    const path = join(w.dir, 'team.yaml');
    // A policy entry whose signature is not the owner's: the reader must not guess at a word
    // the chain cannot verify, so the launch keeps today's `file` and reports the refusal.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/signature: .*/u, 'signature: AAAA'));
    const reading = briefTransportOf({ home: w.home, root: w.root, now: NOW });
    expect(reading.transport).toBe('file');
    expect(reading.level).toBe('default');
    expect(reading.why).toBeString();
  });
});

describe('the message walk', () => {
  test('the seat\'s own mcp-inbox leg takes the brief and the history records it', async () => {
    const w = world();
    setTransport(w, 'message');
    const report = deliver(w, { cli: 'codex' });
    const delivery = report.deliveries[0];
    if (delivery === undefined || !delivery.ok) throw new Error(JSON.stringify(report));
    expect(report.walks).toHaveLength(1);
    expect(report.walks?.[0]?.payload.id).toBe(delivery.id);
    expect(claimOf(w)).toMatchObject({ id: delivery.id, stage: 'ready' });

    // The listener the seat's own server leaves, live: the inbox leg is the one that takes it.
    writeListener(dropDir(w), {
      v: 1,
      seat: SEAT,
      session: SESSION,
      root: w.root,
      cli: 'codex',
      pid: process.pid,
      ts: NOW_ISO,
    });

    await walkBriefDeliveries(report, { dir: w.dir, home: w.home, sendHost: fake(w) });

    expect(delivery.message).toMatchObject({ via: 'mcp-inbox', walked: true, exit: 0 });
    expect(readdirSync(dropDir(w))).toContain(delivery.id);
    const history = readHistory(PROJECT, w.root, w.home);
    expect(history.ok).toBe(true);
    if (history.ok) {
      const last = history.entries.at(-1);
      expect(last).toMatchObject({ to: SEAT, id: delivery.id, via: 'mcp-inbox', outcome: 'sent (unconfirmed)' });
    }
  });

  test('a human seat is walked by the drop leg alone, and writes no receipt marker', async () => {
    const w = world({ human: true });
    setTransport(w, 'message');
    const report = deliver(w, { human: true });
    const delivery = report.deliveries[0];
    if (delivery === undefined || !delivery.ok) throw new Error(JSON.stringify(report));

    await walkBriefDeliveries(report, { dir: w.dir, home: w.home, sendHost: fake(w) });

    expect(delivery.message).toMatchObject({ via: 'drop', walked: true, exit: 0 });
    const names = readdirSync(dropDir(w));
    expect(names).toContain(delivery.id);
    // A human reads the drop and writes no receipt, so the drop leg leaves no pending marker.
    expect(names.filter((name) => name.includes('pending'))).toEqual([]);
    const history = readHistory(PROJECT, w.root, w.home);
    if (history.ok) expect(history.entries.at(-1)).toMatchObject({ via: 'drop', id: delivery.id });
  });

  test('file transport plans no walk and leaves the delivery untouched', () => {
    const w = world();
    const report = deliver(w);
    const delivery = report.deliveries[0];
    if (delivery === undefined || !delivery.ok) throw new Error(JSON.stringify(report));
    expect(report.walks).toBeUndefined();
    expect(delivery.message).toBeUndefined();
    expect(existsSync(join(dropDir(w), delivery.id))).toBe(true);
  });
});

describe('memory writes nothing', () => {
  test('attribution refuses every seat before a claim, a record or a state line', () => {
    const w = world();
    setTransport(w, 'memory');
    const report = deliver(w);
    expect(report.deliveries).toEqual([{ seat: SEAT, ok: false, reason: MEMORY_TRANSPORT_UNSUPPORTED }]);
    expect(report.walks).toBeUndefined();
    expect(existsSync(join(w.dir, 'send-drops'))).toBe(false);
    expect(existsSync(join(w.dir, 'team.state.json'))).toBe(false);
    expect(readState(w.dir).sessions[SESSION]).toBeUndefined();
  });

  test('the recovery writer refuses too and consumes no attempt', () => {
    const w = world();
    setTransport(w, 'memory');
    const claim: CurrentBriefClaim = {
      id: generalBriefId(mintBriefIncarnation(), generalBriefBody()),
      at: NOW_ISO,
      incarnation: mintBriefIncarnation(),
      epoch: mintBriefEpoch(),
      sha256: 'a'.repeat(64),
      attempt: 0,
      stage: 'claimed',
      superseded: [],
    };
    const recovered = recoverBrief({ dir: w.dir, root: w.root, session: SESSION, seat: SEAT, home: w.home, claim });
    expect(recovered).toEqual({ seat: SEAT, ok: false, reason: MEMORY_TRANSPORT_UNSUPPORTED });
    expect(existsSync(join(w.dir, 'team.state.json'))).toBe(false);
    expect(existsSync(join(w.dir, 'send-drops'))).toBe(false);
  });
});
