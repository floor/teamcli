import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readEvents } from '../src/bus/log.ts';
import { serveChoresChild } from '../src/daemon/chores/child.ts';
import { choresPolicyFor } from '../src/daemon/chores/policy.ts';
import { parseChoresFrame, readChildMessage, type ChoresChildMessage } from '../src/daemon/chores/protocol.ts';
import { sweepFallbackEscalations, sweepFallbackEscalationsSliced } from '../src/daemon/fallback-sweep.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { TeamFile } from '../src/file/types.ts';
import { DAEMON_CHORES_DEFAULTS, POLICY_CATALOGUE, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { dropRetirementSteps, retireDropsSliced } from '../src/send/drop-retention.ts';
import {
  type CanonicalRecipient,
  deferredNotePathOf,
  drainDeferredNotesSteps,
  type EscalationContext,
  type FallbackContext,
  markerPathOf,
  noteTransport,
  planRetirementSteps,
  type TransportFact,
} from '../src/send/fallback-events.ts';
import { RECORD_KIND } from '../src/send/record.ts';
import { MESSAGE_DOMAIN, messageKeyOf, signDomain } from '../src/store/keys.ts';

const AT = '2026-10-20T10:00:00.000Z';
const DUE = '2026-10-20T10:06:00.000Z';
const DIGEST = 'c'.repeat(64);
const CALLER = { kind: 'seat', name: 'crew-lead', pane: 'fixture-pane-1', session: 'acme-dev' } as const;

const TEAM_YAML = `format: 1
project: acme
coordinator: crew-lead
operator: dev-1
session: acme-dev
workspace:
  mode: shared
seats:
  - role: coordinator
    name: crew-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "4.6"
    launch: claude
    leads: true
  - role: worker
    name: dev-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "4.6"
    launch: claude
`;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorld() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-ll1-yielding-')));
  dirs.push(base);
  const home = join(base, 'home');
  const root = join(base, 'repo');
  const entityRoot = join(base, 'entity-repo');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(entityRoot, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    entity: 'acme-org',
    session: 'acme-dev',
    root,
    roster: [{ agent: 'agt_crewlead0000', seat: 'crew-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  upsertTeam(home, teamIdOf(entityRoot), {
    project: 'acme-org',
    entity: 'acme-org',
    session: 'acme-hq',
    root: entityRoot,
    roster: [{ agent: 'agt_entitylead00', seat: 'entity-lead', role: 'coordinator', leads: true }],
    lifecycle: 'running',
  });
  const validated = validateTeamFile(TEAM_YAML);
  if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
  const team: TeamFile = validated.team;
  const recipient: CanonicalRecipient = {
    team: 'acme',
    seat: 'dev-1',
    toId: null,
    session: 'acme-dev',
    root,
  };
  const ctx: FallbackContext = {
    caller: CALLER,
    team,
    root,
    home,
    now: () => new Date(AT),
  };
  return { base, home, root, entityRoot, team, recipient, ctx: ctx as EscalationContext & FallbackContext };
}

function stageVerifiedDropRecord(
  home: string,
  recipient: CanonicalRecipient,
  messageId: string,
  from = 'owner',
  at = AT,
): { path: string; digest: string } {
  const key = messageKeyOf(home);
  const dir = join(recipient.root, '.agents', 'send-drops', recipient.session, recipient.seat);
  mkdirSync(dir, { recursive: true });
  const payload = {
    kind: RECORD_KIND,
    id: messageId,
    from,
    from_id: null,
    to: recipient.seat,
    to_id: null,
    root: recipient.root,
    session: recipient.session,
    at,
    rule: 'all',
    thread: messageId,
    body: `body for ${messageId}`,
  };
  const signature = signDomain(MESSAGE_DOMAIN, payload, key);
  const text = `${JSON.stringify({ payload, signature })}\n`;
  const path = join(dir, messageId);
  writeFileSync(path, text);
  const digest = createHash('sha256').update(text).digest('hex');
  return { path, digest };
}

function writeDeferredNoteFile(
  recipient: CanonicalRecipient,
  messageId: string,
  fact: TransportFact,
  sender = 'seat:crew-lead[fixture-pane-1]',
  index = 0,
): string {
  const factId = String(index).padStart(16, '0');
  const path = deferredNotePathOf(recipient, messageId, factId);
  mkdirSync(join(recipient.root, '.agents', 'send-drops', recipient.session, recipient.seat), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ format: 1, sender, fact })}\n`);
  return path;
}

function factFor(
  recipient: CanonicalRecipient,
  messageId: string,
  over: Partial<TransportFact> = {},
): TransportFact {
  return {
    messageId,
    recipient,
    recordDigest: DIGEST,
    route: 'socket',
    outcome: 'unreachable',
    reason: 'the socket did not answer',
    at: AT,
    ms: 100,
    liveRoutesRemain: false,
    ...over,
  };
}

describe('LL1: chores-child steps that never hold the loop', () => {
  test('default daemon.chores-slice-ms is cut to tens of ms and accepted by the policy catalogue', () => {
    expect(DAEMON_CHORES_DEFAULTS.sliceMs).toBeGreaterThanOrEqual(10);
    expect(DAEMON_CHORES_DEFAULTS.sliceMs).toBeLessThan(100);
    expect(POLICY_CATALOGUE['daemon.chores-slice-ms'].defaultValue).toBe(DAEMON_CHORES_DEFAULTS.sliceMs);

    const world = makeWorld();
    const resolved = choresPolicyFor(world.team, world.root, world.home, new Date(AT));
    expect(resolved.sliceMs).toBe(DAEMON_CHORES_DEFAULTS.sliceMs);

    const wrote20 = writePolicySet(
      world.home,
      { level: 'team', target: world.root, teamRoot: world.root, name: 'daemon.chores-slice-ms', value: 20 },
      { now: new Date(AT) },
    );
    expect(wrote20.ok).toBe(true);
    expect(choresPolicyFor(world.team, world.root, world.home, new Date(AT)).sliceMs).toBe(20);
  });

  test('drainDeferredNotesSteps and planRetirementSteps yield in bounded chunks inside store directory walks', async () => {
    const world = makeWorld();
    const seatDir = join(world.root, '.agents', 'send-drops', world.recipient.session, world.recipient.seat);
    mkdirSync(seatDir, { recursive: true });

    // Populate 600 non-note drop files so the directory walk itself crosses multiple chunks.
    for (let i = 0; i < 600; i += 1) {
      writeFileSync(join(seatDir, `drop-${String(i).padStart(4, '0')}.json`), '{"x":1}\n');
    }
    // Add 10 valid deferred notes with staged verified drop records.
    for (let i = 0; i < 10; i += 1) {
      const id = `note-msg-${String(i).padStart(3, '0')}`;
      const staged = stageVerifiedDropRecord(world.home, world.recipient, id);
      writeDeferredNoteFile(
        world.recipient,
        id,
        factFor(world.recipient, id, {
          recordDigest: staged.digest,
          outcome: 'delivered',
          route: 'native',
          reason: undefined,
        }),
        'owner',
        i,
      );
    }
    // Add 150 delivered markers so markersUnderSteps and planRetirementSteps also walk multiple chunks.
    for (let i = 0; i < 150; i += 1) {
      const id = `del-msg-${String(i).padStart(3, '0')}`;
      const noted = noteTransport(
        world.ctx,
        factFor(world.recipient, id, { outcome: 'delivered', route: 'native', reason: undefined }),
      );
      if (!noted.ok) throw new Error(noted.reason);
    }

    // 1. Verify drainDeferredNotesSteps yields multiple times during the directory scan & note drain:
    const noteGen = drainDeferredNotesSteps(world.ctx, { at: new Date(DUE), lockWaitMs: 0 });
    let noteYields = 0;
    let noteStep = noteGen.next();
    while (!noteStep.done) {
      noteYields += 1;
      noteStep = noteGen.next();
    }
    // 760 files in seatDir (> 64 per chunk) + 10 notes drained => must yield at least 15 times inside the drain.
    expect(noteYields).toBeGreaterThanOrEqual(15);
    expect(noteStep.value.drained).toHaveLength(10);

    // 2. Verify planRetirementSteps yields multiple times during markersUnderSteps and candidate planning:
    const planGen = planRetirementSteps(world.ctx, { at: new Date(DUE) });
    let planYields = 0;
    let planStep = planGen.next();
    while (!planStep.done) {
      planYields += 1;
      planStep = planGen.next();
    }
    expect(planYields).toBeGreaterThanOrEqual(10);
    expect(planStep.value.candidates).toHaveLength(160);

    // 3. Verify sweepFallbackEscalationsSliced checks the slice budget inside the directory/note walk
    // and can stop mid-walk before reaching escalation or finishing retirement planning:
    let sliceYields = 0;
    let stopMidWalk = false;
    let fakeClock = 0;
    const partial = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      sliceClock: () => {
        fakeClock += 10;
        return fakeClock;
      },
      slices: {
        sliceMs: 20,
        stopping: () => stopMidWalk,
        yield: async () => {
          sliceYields += 1;
          if (sliceYields >= 3) {
            stopMidWalk = true;
            return false;
          }
          return true;
        },
      },
    });
    expect(sliceYields).toBe(3);
    expect(partial.roots).toEqual([]);
  });

  test('retireDropsSliced yields in bounded chunks during directory reads and non-candidate file scans', async () => {
    const world = makeWorld();
    messageKeyOf(world.home);
    const seatDir = join(world.root, '.agents', 'send-drops', world.recipient.session, world.recipient.seat);
    mkdirSync(seatDir, { recursive: true });

    // Write 400 valid sidecar files (.pending) so readdirSync/opendirSync and the second loop scan 400 entries.
    for (let i = 0; i < 400; i += 1) {
      const id = `msg${String(i).padStart(4, '0')}`;
      writeFileSync(join(seatDir, `${id}.pending`), '');
    }

    let fakeClock = 0;
    let yields = 0;
    const report = await retireDropsSliced({
      root: world.root,
      home: world.home,
      team: world.team,
      at: new Date(DUE),
      sliceClock: () => {
        fakeClock += 20;
        return fakeClock;
      },
      slices: {
        sliceMs: 20,
        stopping: () => false,
        yield: async () => {
          yields += 1;
          return true;
        },
      },
    });
    expect(report.refused).toBeNull();
    // 400 files: chunked directory scan (~6 yields) + 400 file checks + chunked candidate loop (~6 yields) > 410 yields.
    expect(yields).toBeGreaterThanOrEqual(410);
  });

  test('parity: sliced sweep and drop retirement match one-shot results for notes, escalations, retirements, and drops', async () => {
    const world = makeWorld();
    messageKeyOf(world.home);
    const seatDir = join(world.root, '.agents', 'send-drops', world.recipient.session, world.recipient.seat);
    mkdirSync(seatDir, { recursive: true });

    // 1. 5 deferred notes (3 delivered, 2 exhausted due for escalation in the same pass):
    for (let i = 0; i < 3; i += 1) {
      const id = `note-del-${String(i)}`;
      const staged = stageVerifiedDropRecord(world.home, world.recipient, id);
      writeDeferredNoteFile(
        world.recipient,
        id,
        factFor(world.recipient, id, {
          recordDigest: staged.digest,
          outcome: 'delivered',
          route: 'native',
          reason: undefined,
        }),
        'owner',
        i,
      );
    }
    for (let i = 0; i < 2; i += 1) {
      const id = `note-due-${String(i)}`;
      const staged = stageVerifiedDropRecord(world.home, world.recipient, id);
      writeDeferredNoteFile(
        world.recipient,
        id,
        factFor(world.recipient, id, { recordDigest: staged.digest, at: AT }),
        'owner',
        i + 10,
      );
    }
    // 1 unreadable deferred note:
    writeFileSync(deferredNotePathOf(world.recipient, 'bad-note', '0000000000000099'), '{not-json');

    // 2. Direct markers: 3 due for escalation, 4 delivered, 1 unreadable:
    for (let i = 0; i < 3; i += 1) {
      const id = `direct-due-${String(i)}`;
      const noted = noteTransport(world.ctx, factFor(world.recipient, id, { at: AT }));
      if (!noted.ok) throw new Error(noted.reason);
    }
    for (let i = 0; i < 4; i += 1) {
      const id = `direct-del-${String(i)}`;
      const noted = noteTransport(
        world.ctx,
        factFor(world.recipient, id, { outcome: 'delivered', route: 'native', reason: undefined }),
      );
      if (!noted.ok) throw new Error(noted.reason);
    }
    const corruptMarker = markerPathOf(world.recipient, 'corrupt-marker');
    writeFileSync(corruptMarker, '{corrupt');

    // Snapshot world for one-shot vs sliced comparison:
    const snapBase = realpathSync(mkdtempSync(join(tmpdir(), 'team-ll1-snap-')));
    dirs.push(snapBase);
    const saved = join(snapBase, 'saved');
    cpSync(world.base, saved, { recursive: true, preserveTimestamps: true });

    const retireOpts = { limit: 64, lockWaitMs: 0, youngMs: 1_000 };
    const oneShot = sweepFallbackEscalations({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      retire: retireOpts,
    });
    const dropGen = dropRetirementSteps({
      root: world.root,
      home: world.home,
      team: world.team,
      at: new Date(DUE),
    });
    let dropStep = dropGen.next();
    while (!dropStep.done) dropStep = dropGen.next();
    const oneShotDrops = dropStep.value;

    const oneShotEvents = readEvents('acme', world.root, world.home);
    expect(oneShotEvents.ok).toBe(true);

    // Restore exact snapshot:
    rmSync(world.base, { recursive: true, force: true });
    cpSync(saved, world.base, { recursive: true, preserveTimestamps: true });

    let fakeClock = 0;
    let sweepYields = 0;
    const sliced = await sweepFallbackEscalationsSliced({
      home: world.home,
      roots: [{ root: world.root, team: world.team }],
      now: () => new Date(DUE),
      retire: retireOpts,
      sliceClock: () => {
        fakeClock += 20;
        return fakeClock;
      },
      slices: {
        sliceMs: 20,
        stopping: () => false,
        yield: async () => {
          sweepYields += 1;
          return true;
        },
      },
    });
    let dropYields = 0;
    const slicedDrops = await retireDropsSliced({
      root: world.root,
      home: world.home,
      team: world.team,
      at: new Date(DUE),
      sliceClock: () => {
        fakeClock += 20;
        return fakeClock;
      },
      slices: {
        sliceMs: 20,
        stopping: () => false,
        yield: async () => {
          dropYields += 1;
          return true;
        },
      },
    });

    expect(sweepYields).toBeGreaterThan(10);
    expect(dropYields).toBeGreaterThan(5);
    expect(sliced).toEqual(oneShot);
    expect(slicedDrops).toEqual(oneShotDrops);

    // 5 due episodes escalated (2 from drained deferred notes + 3 direct):
    expect(sliced.roots[0]!.notes!.drained).toHaveLength(5);
    expect(sliced.roots[0]!.notes!.unreadable).toHaveLength(1);
    expect(sliced.roots[0]!.report!.escalated).toHaveLength(5);
    // All 12 finished episodes (5 escalated + 7 delivered) retired:
    expect(sliced.roots[0]!.retirement!.retired).toHaveLength(12);

    const events = readEvents('acme', world.root, world.home);
    expect(events.ok).toBe(true);
    if (events.ok && oneShotEvents.ok) {
      expect(events.events).toEqual(oneShotEvents.events);
      expect(events.events).toHaveLength(10);
    }
  });

  test('the chores child heartbeat never waits behind a step while sweeping a populated store', async () => {
    const world = makeWorld();
    const seatDir = join(world.root, '.agents', 'send-drops', world.recipient.session, world.recipient.seat);
    mkdirSync(seatDir, { recursive: true });
    for (let i = 0; i < 2000; i += 1) {
      writeFileSync(join(seatDir, `drop-${String(i).padStart(4, '0')}.json`), '{"x":1}\n');
    }
    for (let i = 0; i < 200; i += 1) {
      const id = `m-${String(i).padStart(4, '0')}`;
      const noted = noteTransport(
        world.ctx,
        factFor(world.recipient, id, { outcome: 'delivered', route: 'native', reason: undefined }),
      );
      if (!noted.ok) throw new Error(noted.reason);
    }

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames: { atMs: number; message: ChoresChildMessage }[] = [];
    let buf = '';
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        const parsed = parseChoresFrame(line);
        const message = parsed === null ? null : readChildMessage(parsed);
        if (message !== null) frames.push({ atMs: performance.now(), message });
      }
    });

    const childPromise = serveChoresChild({
      config: {
        version: 1,
        home: world.home,
        beatMs: 30,
        sliceMs: DAEMON_CHORES_DEFAULTS.sliceMs,
        since: AT,
        routes: [{ root: world.root, team: 'acme', session: 'acme-dev', teamFile: world.team }],
      },
      stdin,
      stdout,
    });

    try {
      // Trigger initial escalation pass and then housekeeping retirement pass:
      stdin.write(`${JSON.stringify({ type: 'tick', id: 't1', at: AT })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const housekeepingAt = new Date(Date.parse(AT) + 35_000).toISOString();
      stdin.write(`${JSON.stringify({ type: 'tick', id: 't2', at: housekeepingAt })}\n`);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const passes = frames.filter((f) => f.message.type === 'pass');
        if (passes.length >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } finally {
      stdin.end();
    }
    expect(await childPromise).toBe(0);

    const beats = frames.filter((f) => f.message.type === 'heartbeat');
    expect(beats.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < beats.length; i += 1) {
      const gapMs = beats[i]!.atMs - beats[i - 1]!.atMs;
      // With 30 ms beatMs and tens-of-ms slice budget, no heartbeat waits hundreds of ms behind a step.
      expect(gapMs).toBeLessThan(150);
    }
  });
});
