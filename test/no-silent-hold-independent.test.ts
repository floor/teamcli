import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { busSocket } from '../src/bus/server.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import {
  createPresenceHeld,
  HELD_FIRST_LOOK_MS,
} from '../src/daemon/presence/held.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, lobbyTrustEntry, resolveLobby } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  clearPreflightReports,
  heldSendNotes,
  reportHeldSend,
} from '../src/send/held-reports.ts';
import { appendHistory } from '../src/send/history.ts';
import {
  declaredInboundOf,
  heldSocketPath,
  readHeldSocket,
  socketHeldReason,
} from '../src/send/inbound.ts';
import type { NativePane } from '../src/send/native.ts';
import {
  ensureRecord,
  isRead,
  RECORD_KIND,
  signReceiptPayload,
  signRecord,
  writeReceipt,
  type RecordPayload,
} from '../src/send/record.ts';
import { emptySession, updateState } from '../src/state.ts';
import { keyOf, messageKeyOf, signDomain } from '../src/store/keys.ts';
import { discardFixtures } from './fixture-cleanup.ts';
import { gitEnv, recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const FUTURE = '2027-06-01T00:00:00.000Z';
const GRANT_DOMAIN = 'team-send-grant-v1\n';

const MODEL_DRIFT_SCREEN =
  '❯ \n────────────────────────────────────────\n  main · …/fixture · Opus 4.6 · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n';

const HELD_DIALOG_SCREEN = [
  '╭──────────────────────────────────────────────────╮',
  '│ Held message from another session                │',
  '│ ❯ 1. Accept message                              │',
  '│   2. Reject                                      │',
  '╰──────────────────────────────────────────────────╯',
].join('\n');

const createdBases: string[] = [];

afterEach(() => {
  discardFixtures(createdBases.splice(0), { quiet: true });
});

type SeatSpec = {
  name: string;
  role: string;
  cli: string;
  launch: string;
  inbound?: 'accept' | 'hold' | 'refuse';
};

function renderTeamYaml(input: {
  project: string;
  entity: string;
  session: string;
  coordinator: string;
  root: string;
  lobby: string;
  seats: SeatSpec[];
  deliveryOrder?: string;
}): string {
  const seats = input.seats
    .map(
      (s) => `  - role: ${s.role}
    name: ${s.name}
    cli: ${s.cli}
    vendor: test
    model: Test
    version: "1"
    launch: ${s.launch}${s.inbound ? `\n    inbound: ${s.inbound}` : ''}`,
    )
    .join('\n');
  return `format: 1
project: ${input.project}
entity: ${input.entity}
coordinator: ${input.coordinator}
operator: ${input.coordinator}
session: ${input.session}
workspace:
  mode: shared
trust:
  - ${input.lobby}
  - ${input.root}
seats:
${seats}
delivery_order: ${input.deliveryOrder ?? '[typed, drop]'}
`;
}

function agentIdOf(seat: string): string {
  return `agt_${createHash('sha256').update(seat).digest('hex').slice(0, 12)}`;
}

function registerSyntheticSeat(
  home: string,
  seat: string,
  role: string,
  pane: string,
  where: {
    team: string;
    session: string;
    model?: string;
    version?: string;
    cli?: string;
    launch?: string;
    address?: string | null;
  },
): string {
  const id = agentIdOf(`${where.session}:${seat}`);
  const file = join(home, '.config', 'team', 'agents', `${id}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${id}"`,
      `name: "${seat}"`,
      'signing:',
      `  model: "${where.model ?? 'Test'}"`,
      `  version: "${where.version ?? '1'}"`,
      `  role: "${role}"`,
      'lab: "test"',
      `cli: "${where.cli ?? 'claude-code'}"`,
      'launcher: null',
      `launch: "${where.launch ?? 'claude'}"`,
      'reach:',
      `  team: "${where.team}"`,
      `  seat: "${seat}"`,
      `  session: "${where.session}"`,
      `  pane: "${pane}"`,
      `  address: ${where.address ? `"${where.address}"` : 'null'}`,
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-16T12:00:00.000Z"',
      '  updated_at: "2026-10-16T12:00:00.000Z"',
      '',
    ].join('\n'),
  );
  return id;
}

function recordSessionSeats(
  dir: string,
  session: string,
  seats: Record<string, string>,
): void {
  updateState(dir, (state) => {
    const entry = (state.sessions[session] ??= emptySession());
    for (const [seat, pane] of Object.entries(seats)) {
      entry.seats[seat] = { stage: 'launched', pane, workspace: `ws-${seat}` };
    }
  });
}

function signSendGrant(
  home: string,
  stem: string,
  pair: { from: string; to: string; expires: string },
): void {
  const folder = join(home, '.config', 'team', 'grants');
  mkdirSync(folder, { recursive: true });
  const key = keyOf(home);
  const payload = {
    name: stem,
    send: { from: pair.from, to: pair.to },
    expires: pair.expires,
  };
  const signature = signDomain(GRANT_DOMAIN, payload, key);
  writeFileSync(
    join(folder, `${stem}.json`),
    `${JSON.stringify({ send: payload.send, expires: pair.expires, signature }, null, 2)}\n`,
  );
}

function dropIds(dir: string, session: string, seat: string): string[] {
  const folder = join(dir, 'send-drops', session, seat);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter(
      (name) =>
        !name.startsWith('.') &&
        !name.endsWith('.pending') &&
        !name.endsWith('.fallback.json') &&
        !name.endsWith('.meta.json') &&
        !name.endsWith('.json') &&
        !name.endsWith('.draft'),
    )
    .sort();
}

function dropBodies(dir: string, session: string, seat: string): string[] {
  const folder = join(dir, 'send-drops', session, seat);
  return dropIds(dir, session, seat).map((id) => recordBody(join(folder, id)));
}

type SyntheticWorld = {
  base: string;
  home: string;
  sockets: string;
  alphaRoot: string;
  alphaDir: string;
  betaRoot: string;
  betaDir: string;
};

function makeSyntheticWorld(deliveryOrder = '[typed, drop]'): SyntheticWorld {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'no-silent-hold-ind-')));
  createdBases.push(base);
  const home = join(base, 'home');
  const sockets = join(base, 'sockets');
  mkdirSync(lobbyDir(home), { recursive: true });
  mkdirSync(sockets, { recursive: true });
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'team', 'settings.yaml'),
    'team-config.source: file\n',
  );

  const entityLobby = lobbyTrustEntry(home, { entity: 'acme-entity' });

  const alphaRoot = join(base, 'alpha');
  const alphaDir = join(alphaRoot, '.agents');
  mkdirSync(alphaDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: alphaRoot, stdio: 'ignore', env: gitEnv() });
  writeFileSync(
    join(alphaDir, 'team.yaml'),
    renderTeamYaml({
      project: 'alpha',
      entity: 'acme-entity',
      session: 'alpha-ses',
      coordinator: 'lead-a',
      root: alphaRoot,
      lobby: entityLobby,
      deliveryOrder,
      seats: [
        { name: 'lead-a', role: 'coordinator', cli: 'claude-code', launch: 'claude', inbound: 'accept' },
        { name: 'seat-a', role: 'implementer', cli: 'claude-code', launch: 'claude', inbound: 'accept' },
        { name: 'seat-peer', role: 'implementer', cli: 'claude-code', launch: 'claude', inbound: 'accept' },
      ],
    }),
  );
  // Include lobbyDir(home) in trust as well so file-mode trust validation passes
  const alphaYaml = readFileSync(join(alphaDir, 'team.yaml'), 'utf8').replace(
    'trust:\n',
    `trust:\n  - ${lobbyDir(home)}\n`,
  );
  writeFileSync(join(alphaDir, 'team.yaml'), alphaYaml);

  const betaRoot = join(base, 'beta');
  const betaDir = join(betaRoot, '.agents');
  mkdirSync(betaDir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: betaRoot, stdio: 'ignore', env: gitEnv() });
  writeFileSync(
    join(betaDir, 'team.yaml'),
    renderTeamYaml({
      project: 'beta',
      entity: 'acme-entity',
      session: 'beta-ses',
      coordinator: 'lead-b',
      root: betaRoot,
      lobby: entityLobby,
      deliveryOrder,
      seats: [
        { name: 'lead-b', role: 'coordinator', cli: 'codex', launch: 'codex -m test' },
        { name: 'seat-b', role: 'implementer', cli: 'claude-code', launch: 'claude' },
      ],
    }),
  );
  const betaYaml = readFileSync(join(betaDir, 'team.yaml'), 'utf8').replace(
    'trust:\n',
    `trust:\n  - ${lobbyDir(home)}\n`,
  );
  writeFileSync(join(betaDir, 'team.yaml'), betaYaml);

  const alphaTeamId = teamIdOf(alphaRoot);
  const betaTeamId = teamIdOf(betaRoot);

  const leadA = registerSyntheticSeat(home, 'lead-a', 'coordinator', 'pane-lead-a', {
    team: alphaTeamId,
    session: 'alpha-ses',
  });
  const seatA = registerSyntheticSeat(home, 'seat-a', 'implementer', 'pane-seat-a', {
    team: alphaTeamId,
    session: 'alpha-ses',
  });
  const seatPeer = registerSyntheticSeat(home, 'seat-peer', 'implementer', 'pane-seat-peer', {
    team: alphaTeamId,
    session: 'alpha-ses',
  });
  const leadB = registerSyntheticSeat(home, 'lead-b', 'coordinator', 'pane-lead-b', {
    team: betaTeamId,
    session: 'beta-ses',
    cli: 'codex',
    launch: 'codex -m test',
  });
  const seatB = registerSyntheticSeat(home, 'seat-b', 'implementer', 'pane-seat-b', {
    team: betaTeamId,
    session: 'beta-ses',
  });

  upsertTeam(home, alphaTeamId, {
    project: 'alpha',
    entity: 'acme-entity',
    session: 'alpha-ses',
    root: alphaRoot,
    lobby: resolveLobby(home, { entity: 'acme-entity' }),
    lifecycle: 'running',
    by: 'test',
    roster: [
      { agent: leadA, seat: 'lead-a', role: 'coordinator', leads: true },
      { agent: seatA, seat: 'seat-a', role: 'implementer' },
      { agent: seatPeer, seat: 'seat-peer', role: 'implementer' },
    ],
  });
  upsertTeam(home, betaTeamId, {
    project: 'beta',
    entity: 'acme-entity',
    session: 'beta-ses',
    root: betaRoot,
    lobby: resolveLobby(home, { entity: 'acme-entity' }),
    lifecycle: 'running',
    by: 'test',
    roster: [
      { agent: leadB, seat: 'lead-b', role: 'coordinator', leads: true },
      { agent: seatB, seat: 'seat-b', role: 'implementer' },
    ],
  });

  recordSessionSeats(alphaDir, 'alpha-ses', {
    'lead-a': 'pane-lead-a',
    'seat-a': 'pane-seat-a',
    'seat-peer': 'pane-seat-peer',
  });
  recordSessionSeats(betaDir, 'beta-ses', {
    'lead-b': 'pane-lead-b',
    'seat-b': 'pane-seat-b',
  });

  return { base, home, sockets, alphaRoot, alphaDir, betaRoot, betaDir };
}

function makeFakeHost(
  w: SyntheticWorld,
  overrides: {
    paneText?: (session: string, pane: string) => string | null;
    status?: (pane: string) => string;
    typeText?: (pane: string, text: string) => boolean;
    pressEnter?: (pane: string) => boolean;
    deliver?: SendHost['deliver'];
  } = {},
): SendHost {
  let step = 0;
  const native: NativePane = {
    typeText: (pane, text) => (overrides.typeText ? overrides.typeText(pane, text) : true),
    pressEnter: (pane) => (overrides.pressEnter ? overrides.pressEnter(pane) : true),
    status: (pane) => {
      if (overrides.status) return overrides.status(pane);
      return step++ % 2 === 0 ? 'idle' : 'working';
    },
    wait: async () => {},
    paneText: (session, pane) => (overrides.paneText ? overrides.paneText(session, pane) : null),
  };
  return {
    agents: () => [
      { name: 'lead-a', pane: 'pane-lead-a' },
      { name: 'seat-a', pane: 'pane-seat-a' },
      { name: 'seat-peer', pane: 'pane-seat-peer' },
      { name: 'lead-b', pane: 'pane-lead-b' },
      { name: 'seat-b', pane: 'pane-seat-b' },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: w.sockets,
    deliver: overrides.deliver ?? (async () => ({ ok: true })),
    native,
    now: () => NOW,
    home: w.home,
  };
}

describe('no-silent-hold + held-notice-synthetic (d4e2cd11b) independent verification', () => {
  test('Scene 1: held send reports to sender and recipient lead once per id (metadata only), updates status notes, honors dry-run/session separation, and clears on preflight recovery or verified receipt', async () => {
    const w = makeSyntheticWorld();
    // Configure seat-peer with Claude Fable 5.1 in registry while pane shows Opus 4.6 -> model drift hold
    registerSyntheticSeat(w.home, 'seat-peer', 'implementer', 'pane-seat-peer', {
      team: teamIdOf(w.alphaRoot),
      session: 'alpha-ses',
      model: 'Claude Fable',
      version: '5.1',
    });
    const host = makeFakeHost(w, {
      paneText: (_session, pane) => (pane === 'pane-seat-peer' ? MODEL_DRIFT_SCREEN : null),
    });

    const confidentialBody = 'Secret token alpha-99281-never-in-lead-notice';

    // 1a) --dry-run writes no held-send report and no lead notice
    const dryIo = testIo(w.alphaRoot, {
      kind: 'seat',
      name: 'seat-a',
      pane: 'pane-seat-a',
      session: 'alpha-ses',
    });
    expect(await runSend(['seat-peer', confidentialBody, '--dry-run'], dryIo, host)).toBe(1);
    expect(
      heldSendNotes({
        project: 'alpha',
        root: w.alphaRoot,
        home: w.home,
        session: 'alpha-ses',
        lead: 'lead-a',
      }),
    ).toEqual([]);
    expect(dropBodies(w.alphaDir, 'alpha-ses', 'lead-a')).toEqual([]);

    // 1b) Real send to seat-peer is held on model drift: sender gets exit 1 (send.held) with explicit not-kept wording,
    // recipient lead (lead-a) gets metadata-only notice without confidentialBody, and status notes count 1 held send
    const sendIo = testIo(w.alphaRoot, {
      kind: 'seat',
      name: 'seat-a',
      pane: 'pane-seat-a',
      session: 'alpha-ses',
    });
    const fixedId = '11111111-1111-4111-8111-111111111111';
    expect(
      await runSend(['seat-peer', confidentialBody, '--json'], sendIo, {
        ...host,
        sendId: () => fixedId,
      }),
    ).toBe(1);
    const errObj = JSON.parse(sendIo.out).error;
    expect(errObj.id).toBe('send.held');
    expect(errObj.message).toContain('model drift');
    expect(errObj.message).toContain('1 held send');
    expect(errObj.message).toContain('body not read or kept; retry after repair');
    expect(dropBodies(w.alphaDir, 'alpha-ses', 'seat-peer')).toEqual([]);

    const leadNotices = dropBodies(w.alphaDir, 'alpha-ses', 'lead-a');
    expect(leadNotices).toHaveLength(1);
    expect(leadNotices[0]).toContain('seat-peer: 1 held send');
    expect(leadNotices[0]).toContain('the body was not read or kept; the sender must retry after repair');
    expect(leadNotices[0]).not.toContain(confidentialBody);

    // Repeating reportHeldSend for the same original id returns existing: true and does not write a second notice
    const repeatReport = reportHeldSend({
      project: 'alpha',
      root: w.alphaRoot,
      home: w.home,
      session: 'alpha-ses',
      lead: 'lead-a',
      seat: 'seat-peer',
      id: fixedId,
      reason: 'model drift',
      at: NOW.toISOString(),
      stored: false,
    });
    expect(repeatReport.ok).toBe(true);
    if (repeatReport.ok) {
      expect(repeatReport.existing).toBe(true);
      expect(repeatReport.count).toBe(1);
    }

    // Status notes reflect the held send in alpha-ses, while another session is isolated
    expect(
      heldSendNotes({
        project: 'alpha',
        root: w.alphaRoot,
        home: w.home,
        session: 'alpha-ses',
        lead: 'lead-a',
      }),
    ).toEqual([
      expect.stringContaining('seat-peer: 1 held send —'),
    ]);
    expect(
      heldSendNotes({
        project: 'alpha',
        root: w.alphaRoot,
        home: w.home,
        session: 'other-ses',
        lead: 'lead-a',
      }),
    ).toEqual([]);

    // 1c) Stored hold (stored: true) keeps original unread drop intact and clears from status once read or lead-cleared
    const storedId = '22222222-2222-4222-8222-222222222222';
    const peerDropDir = join(w.alphaDir, 'send-drops', 'alpha-ses', 'seat-peer');
    const storedPayload: RecordPayload = {
      kind: RECORD_KIND,
      id: storedId,
      root: w.alphaRoot,
      session: 'alpha-ses',
      to: 'seat-peer',
      to_id: null,
      from: 'seat-a',
      from_id: null,
      rule: 'a seat to a declared seat of its own team',
      at: NOW.toISOString(),
      body: 'Stored body preserved unread.',
      thread: storedId,
    };
    expect(ensureRecord(peerDropDir, signRecord(storedPayload, w.home)).ok).toBe(true);
    const storedReport = reportHeldSend({
      project: 'alpha',
      root: w.alphaRoot,
      home: w.home,
      session: 'alpha-ses',
      lead: 'lead-a',
      seat: 'seat-peer',
      id: storedId,
      reason: 'the composer holds text',
      at: NOW.toISOString(),
      stored: true,
    });
    expect(storedReport.ok).toBe(true);
    if (storedReport.ok) {
      expect(storedReport.count).toBe(2);
      expect(storedReport.notice.body).toContain('the message is kept; no delivery is claimed');
    }
    const key = messageKeyOf(w.home);
    expect(
      isRead(peerDropDir, storedId, { root: w.alphaRoot, session: 'alpha-ses', to: 'seat-peer', lead: 'lead-a' }, key),
    ).toBe(false);
    expect(recordBody(join(peerDropDir, storedId))).toBe('Stored body preserved unread.');

    // Clear preflight unstored report via clearPreflightReports, then settle stored report via verified receipt
    expect(
      clearPreflightReports({
        project: 'alpha',
        root: w.alphaRoot,
        home: w.home,
        session: 'alpha-ses',
        lead: 'lead-a',
        seat: 'seat-peer',
        at: NOW.toISOString(),
      }),
    ).toBeNull();
    expect(
      heldSendNotes({
        project: 'alpha',
        root: w.alphaRoot,
        home: w.home,
        session: 'alpha-ses',
        lead: 'lead-a',
      }),
    ).toEqual(['seat-peer: 1 held send — the composer holds text']);

    const receipt = signReceiptPayload(
      {
        kind: 'receipt',
        status: 'read',
        id: storedId,
        to: 'seat-peer',
        root: w.alphaRoot,
        session: 'alpha-ses',
        at: NOW.toISOString(),
        read_by: 'lead-ack:owner',
      },
      w.home,
    );
    expect(writeReceipt(peerDropDir, receipt, w.home).ok).toBe(true);
    expect(
      heldSendNotes({
        project: 'alpha',
        root: w.alphaRoot,
        home: w.home,
        session: 'alpha-ses',
        lead: 'lead-a',
      }),
    ).toEqual([]);
  });

  test('Scene 2: held socket marker is written before any report or await so a second send during the report sees the hold', async () => {
    const w = makeSyntheticWorld('[socket]');
    // Write generated hook settings declaring crossSessionInbound: accept and a live socket for seat-peer
    const settingsPath = cliHookSettingsPath(w.alphaDir, 'alpha-ses', 'seat-peer')!;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, '{"crossSessionInbound":"accept"}\n');
    const sockPath = join(w.sockets, '222.sock');
    writeFileSync(sockPath, '');
    const baseSec = Math.floor(NOW.getTime() / 1000);
    utimesSync(settingsPath, baseSec - 20, baseSec - 20);
    utimesSync(sockPath, baseSec - 5, baseSec - 5);

    // Stage a socket-delivered message in seat-peer's drop folder and send history
    const msgId = '33333333-3333-4333-8333-333333333333';
    const peerDropDir = join(w.alphaDir, 'send-drops', 'alpha-ses', 'seat-peer');
    const payload: RecordPayload = {
      kind: RECORD_KIND,
      id: msgId,
      root: w.alphaRoot,
      session: 'alpha-ses',
      to: 'seat-peer',
      to_id: null,
      from: 'seat-a',
      from_id: null,
      rule: 'a seat to a declared seat of its own team',
      at: NOW.toISOString(),
      body: 'Socket frame that hits dialog.',
      thread: msgId,
    };
    expect(ensureRecord(peerDropDir, signRecord(payload, w.home)).ok).toBe(true);
    expect(
      appendHistory('alpha', w.alphaRoot, w.home, {
        ts: NOW.toISOString(),
        from: 'seat-a',
        to: 'seat-peer',
        body: payload.body,
        id: msgId,
        outcome: 'delivered',
        via: 'socket',
        thread: msgId,
      }).ok,
    ).toBe(true);

    // Bind a synthetic bus server at busSocket(w.alphaRoot) that accepts the nudgeBus connection
    // and holds it pending so raise() is paused at await nudgeBus(...)
    const busSockPath = busSocket(w.alphaRoot);
    mkdirSync(dirname(busSockPath), { recursive: true });
    let notifyConnected!: () => void;
    const nudgeConnected = new Promise<void>((resolve) => {
      notifyConnected = resolve;
    });
    const openSockets: Socket[] = [];
    const server: Server = createServer((socket) => {
      openSockets.push(socket);
      socket.once('data', () => {
        notifyConnected();
      });
    });
    await new Promise<void>((resolve) => server.listen(busSockPath, resolve));

    try {
      const step = createPresenceHeld({
        stateDir: w.alphaDir,
        project: 'alpha',
        root: w.alphaRoot,
        session: 'alpha-ses',
        home: w.home,
        seats: [
          { name: 'lead-a', launch: 'claude' },
          { name: 'seat-a', launch: 'claude' },
          { name: 'seat-peer', launch: 'claude' },
        ],
        lead: 'lead-a',
        agents: async () => [{ name: 'seat-peer', pane: 'pane-seat-peer' }],
        screen: async () => HELD_DIALOG_SCREEN,
      });

      // Pass 1 at NOW scans history and schedules look at NOW + HELD_FIRST_LOOK_MS
      const firstPass = await step(NOW);
      expect(firstPass.watching).toBe(1);
      expect(firstPass.raised).toEqual([]);

      // Pass 2 at NOW + HELD_FIRST_LOOK_MS sees HELD_DIALOG_SCREEN, writes held history + recordHeldSocket + reportHeldSend,
      // and then awaits nudgeBus(busSockPath)
      let secondPassSettled = false;
      const secondPassPromise = step(new Date(NOW.getTime() + HELD_FIRST_LOOK_MS)).then((res) => {
        secondPassSettled = true;
        return res;
      });

      await nudgeConnected;
      expect(secondPassSettled).toBe(false);

      // WHILE the report/nudge await is still pending:
      // 1) The held socket marker is ALREADY written on disk
      const heldMark = readHeldSocket(heldSocketPath(w.alphaDir, 'alpha-ses', 'seat-peer'));
      expect(heldMark).not.toBeNull();
      const inbound = declaredInboundOf({
        dir: w.alphaDir,
        root: w.alphaRoot,
        session: 'alpha-ses',
        seat: 'seat-peer',
        launch: 'claude',
      });
      expect(socketHeldReason(heldMark, inbound)).toContain(
        'its last socket frame was held at its box',
      );

      // 2) A second send to seat-peer over [socket] during this pending window sees the hold and does NOT dial the socket
      let dialCalls = 0;
      const secondSendHost = makeFakeHost(w, {
        deliver: async () => {
          dialCalls += 1;
          return { ok: true };
        },
      });
      const secondIo = testIo(w.alphaRoot, {
        kind: 'seat',
        name: 'seat-a',
        pane: 'pane-seat-a',
        session: 'alpha-ses',
      });
      const secondCode = await runSend(
        ['seat-peer', 'Second send during pending report.', '--json'],
        secondIo,
        secondSendHost,
      );
      expect(secondCode).toBe(1);
      expect(dialCalls).toBe(0);
      expect(secondIo.out).toContain('its last socket frame was held at its box');

      // Release the pending nudge connection so secondPassPromise completes cleanly
      for (const s of openSockets) s.destroy();
      const secondPass = await secondPassPromise;
      expect(secondPass.raised).toEqual([msgId]);
      expect(
        heldSendNotes({
          project: 'alpha',
          root: w.alphaRoot,
          home: w.home,
          session: 'alpha-ses',
          lead: 'lead-a',
        }),
      ).toEqual([
        'seat-peer: 1 held send — the receiving session holds the socket frame at a message dialog',
      ]);
    } finally {
      for (const s of openSockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('Scene 3: worker-only cross-team grant where notice to recipient lead is refused writes NOTHING into recipient lead inbox and notifies sender and sender own lead', async () => {
    const w = makeSyntheticWorld();
    // Grant seat-a@alpha -> seat-b@beta ONLY (no grant to lead-b@beta)
    signSendGrant(w.home, 'worker-only-grant', {
      from: 'seat-a@alpha',
      to: 'seat-b@beta',
      expires: FUTURE,
    });

    // Put seat-b@beta into model drift (registry says Claude Fable 5.1, pane shows Opus 4.6)
    registerSyntheticSeat(w.home, 'seat-b', 'implementer', 'pane-seat-b', {
      team: teamIdOf(w.betaRoot),
      session: 'beta-ses',
      model: 'Claude Fable',
      version: '5.1',
    });

    const host = makeFakeHost(w, {
      paneText: (_session, pane) => (pane === 'pane-seat-b' ? MODEL_DRIFT_SCREEN : null),
    });

    // Confirm direct send from seat-a@alpha to lead-b@beta is refused by admission
    const directRefusedIo = testIo(w.alphaRoot, {
      kind: 'seat',
      name: 'seat-a',
      pane: 'pane-seat-a',
      session: 'alpha-ses',
    });
    expect(
      await runSend(['lead-b@beta', 'Direct probe without grant.', '--json'], directRefusedIo, host),
    ).toBe(1);
    expect(JSON.parse(directRefusedIo.out).error.id).toBe('send.refused');
    expect(dropBodies(w.betaDir, 'beta-ses', 'lead-b')).toEqual([]);

    // Now send from seat-a@alpha to seat-b@beta (which hits model-drift hold)
    const heldIo = testIo(w.alphaRoot, {
      kind: 'seat',
      name: 'seat-a',
      pane: 'pane-seat-a',
      session: 'alpha-ses',
    });
    const secretCrossBody = 'Cross-team secret payload 77419.';
    expect(
      await runSend(['seat-b@beta', secretCrossBody, '--json'], heldIo, host),
    ).toBe(1);
    const error = JSON.parse(heldIo.out).error;
    expect(error.id).toBe('send.held');
    expect(error.message).toContain('model drift');
    expect(error.message).toContain('no runtime fallback written');
    expect(error.message).toContain('sender lead');

    // CRITICAL: Nothing was written into lead-b@beta's inbox or seat-b@beta's inbox!
    expect(dropBodies(w.betaDir, 'beta-ses', 'lead-b')).toEqual([]);
    expect(dropBodies(w.betaDir, 'beta-ses', 'seat-b')).toEqual([]);

    // Instead, sender's own lead (lead-a@alpha) received the ordinary admitted notice
    const senderLeadNotices = dropBodies(w.alphaDir, 'alpha-ses', 'lead-a');
    expect(senderLeadNotices).toHaveLength(1);
    expect(senderLeadNotices[0]).toContain('Held-send notice to lead-b@beta was refused or admission was unknown');
    expect(senderLeadNotices[0]).toContain('seat-b: 1 held send');
    expect(senderLeadNotices[0]).toContain('model drift');
    expect(senderLeadNotices[0]).not.toContain(secretCrossBody);
  });

  test('Scene 4: admitted same-team lead notice whose transport fails queues runtime notice without recursion and leaves unrelated lead mail unread', async () => {
    const w = makeSyntheticWorld('[typed]');
    // Put an unrelated unread message in lead-a's drop folder beforehand
    const unrelatedId = '44444444-4444-4444-8444-444444444444';
    const leadDropDir = join(w.alphaDir, 'send-drops', 'alpha-ses', 'lead-a');
    const unrelatedPayload: RecordPayload = {
      kind: RECORD_KIND,
      id: unrelatedId,
      root: w.alphaRoot,
      session: 'alpha-ses',
      to: 'lead-a',
      to_id: null,
      from: 'owner',
      from_id: null,
      rule: 'the owner',
      at: NOW.toISOString(),
      body: 'Unrelated unread lead message.',
      thread: unrelatedId,
    };
    expect(ensureRecord(leadDropDir, signRecord(unrelatedPayload, w.home)).ok).toBe(true);

    // Put seat-peer into model drift, and make lead-a's pane fail typing (typeText -> false -> send.unreachable after attempted typed leg)
    registerSyntheticSeat(w.home, 'seat-peer', 'implementer', 'pane-seat-peer', {
      team: teamIdOf(w.alphaRoot),
      session: 'alpha-ses',
      model: 'Claude Fable',
      version: '5.1',
    });
    const host = makeFakeHost(w, {
      paneText: (_session, pane) => (pane === 'pane-seat-peer' ? MODEL_DRIFT_SCREEN : null),
      typeText: (pane) => (pane === 'pane-lead-a' ? false : true),
    });

    const io = testIo(w.alphaRoot, {
      kind: 'seat',
      name: 'seat-a',
      pane: 'pane-seat-a',
      session: 'alpha-ses',
    });
    expect(await runSend(['seat-peer', 'Message held while lead unreachable.', '--json'], io, host)).toBe(1);
    const error = JSON.parse(io.out).error;
    expect(error.id).toBe('send.held');
    expect(error.message).toContain('queued for the lead reader');

    // Unrelated lead message is still unread (no read receipt created for it)
    const key = messageKeyOf(w.home);
    expect(
      isRead(leadDropDir, unrelatedId, { root: w.alphaRoot, session: 'alpha-ses', to: 'lead-a', lead: 'lead-a' }, key),
    ).toBe(false);
    const allLeadBodies = dropBodies(w.alphaDir, 'alpha-ses', 'lead-a');
    expect(allLeadBodies.some((b) => b.includes('Unrelated unread lead message.'))).toBe(true);
    expect(allLeadBodies.some((b) => b.includes('seat-peer: 1 held send'))).toBe(true);
  });
});
