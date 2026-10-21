// Independent S4 coverage: signed lead-drop aggregation and drain retry semantics
// through the production `reportUnreadDrops(scene, { unreadAfter })` entrypoint.
//
// Author: operator-3 (Atalanta · operator 3)
// All fixtures (team file, scratch checkout root, isolated home/store, signing keys,
// registered agents, and signed unread drops) are authored in this file.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_MAILBOX, OWNER_RECORD_FROM } from '../src/bus/owner.ts';
import { messageFile, type MessagePayload } from '../src/commands/messages.ts';
import { loadTeamFile } from '../src/file/load.ts';
import type { TeamFile } from '../src/file/types.ts';
import { listUnread } from '../src/mcp/inbox.ts';
import { registerAgent, type Agent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import {
  readRecord,
  signRecord,
  verifyRecord,
  writeRecord,
  type RecordPayload,
} from '../src/send/record.ts';
import {
  MESSAGE_DOMAIN,
  messageKeyOf,
  verifyDomain,
  type Json,
} from '../src/store/keys.ts';
import type { RetryScene, RetrySources } from '../src/watch/retry.ts';
import { reportedPath, reportUnreadDrops, wakePath } from '../src/watch/unread.ts';

const BASE_TIME = new Date('2026-10-21T19:00:00.000Z');
const UNREAD_AFTER_SECONDS = 60;
// Report threshold is 2 * unreadAfter = 120 seconds (2 minutes).
// Seed messages 180 seconds (3 minutes) before BASE_TIME so they are due for reporting.
const MESSAGE_TIME = new Date(BASE_TIME.getTime() - 180_000).toISOString();

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort cleanup.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Deterministic RFC UUID v8 derivation from the sorted deduplicated set of source message IDs. */
function expectedAggregateReportUuid(messageIds: readonly string[]): string {
  const hash = createHash('sha256').update('unread-report');
  for (const id of [...new Set(messageIds)].sort()) {
    hash.update(`\u0000${id}`);
  }
  const bytes = [...hash.digest().subarray(0, 16)];
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type SyntheticHarness = {
  base: string;
  root: string;
  dir: string;
  home: string;
  session: string;
  team: TeamFile;
  agents: Record<string, Agent>;
  spoken: Array<{ text: string; desktop: boolean }>;
  scene: RetryScene;
  seedUnreadDrop(input: {
    id: string;
    to: string;
    from: string;
    fromId?: string | null;
    body?: string;
    at?: string;
  }): string;
  leadDropDir(): string;
  leadDropFiles(): string[];
  readSenderMailboxRecord(sender: string, messageId: string): {
    payload: MessagePayload;
    signature: string;
  } | null;
};

function createSyntheticHarness(now: Date = BASE_TIME): SyntheticHarness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'o3-s4-unread-')));
  tempRoots.push(base);
  const root = join(base, 'checkout');
  const dir = join(root, '.agents');
  const home = join(base, 'home');
  const session = 's4-session';

  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });

  const teamYaml = `format: 1
project: s4-project
entity: s4-entity
operator: ops-lead
session: ${session}
trust:
  - ~/.config/team/lobby
  - ${home}/.config/team/lobbies/s4-entity
  - ${root}
workspace:
  mode: shared
seats:
  - role: orchestrator
    name: lead-coord
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: ops-lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: worker-a
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: builder
    name: worker-b
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: tester
    name: sender-one
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: tester
    name: sender-two
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`;
  writeFileSync(join(dir, 'team.yaml'), teamYaml);
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) {
    throw new Error(`team.yaml failed to load: ${loaded.errors.map((e) => e.message).join('; ')}`);
  }
  const team = loaded.team;

  // Ensure the checkout message key is initialized in the synthetic home.
  messageKeyOf(home);

  const teamId = teamIdOf(root);
  const agents: Record<string, Agent> = {};
  for (const seat of team.seats) {
    agents[seat.name] = registerAgent(home, {
      name: seat.name,
      signing: { model: seat.model, version: String(seat.version ?? '5.5'), role: seat.role },
      lab: seat.vendor,
      cli: seat.cli,
      launcher: null,
      launch: seat.launch ?? 'claude',
      reach: {
        team: teamId,
        seat: seat.name,
        session,
        pane: `w-${seat.name}:p1`,
        address: null,
      },
      mcp: [],
      skills: [],
      lifecycle: 'running',
      by: 'owner',
    });
  }

  upsertTeam(home, teamId, {
    project: team.project,
    session,
    root,
    lobby: join(home, '.config/team/lobbies', session),
    roster: Object.values(agents).map((a) => ({ seat: a.reach.seat, agent: a.id, role: a.signing.role })),
    lifecycle: 'running',
    by: 'owner',
    at: now.toISOString(),
  });

  const spoken: Array<{ text: string; desktop: boolean }> = [];
  const noopSources: RetrySources = {
    screen: () => null,
    status: () => 'idle',
    typeText: () => false,
    pressEnter: () => false,
    sleep: async () => {},
  };

  const scene: RetryScene = {
    dir,
    session,
    root,
    home,
    team,
    live: {
      running: true,
      agents: [],
      workspaces: [],
      screens: {},
    },
    ownPane: null,
    sources: noopSources,
    now,
    say(text: string, desktop: boolean) {
      spoken.push({ text, desktop });
    },
  };

  function seedUnreadDrop(input: {
    id: string;
    to: string;
    from: string;
    fromId?: string | null;
    body?: string;
    at?: string;
  }): string {
    const dropDir = join(dir, 'send-drops', session, input.to);
    const resolvedFromId =
      input.fromId !== undefined
        ? input.fromId
        : input.from === OWNER_MAILBOX
          ? null
          : (agents[input.from]?.id ?? null);
    const resolvedToId = agents[input.to]?.id ?? null;
    const payload: RecordPayload = {
      kind: 'message',
      id: input.id,
      to: input.to,
      to_id: resolvedToId,
      root,
      session,
      at: input.at ?? MESSAGE_TIME,
      body: input.body ?? `from ${input.from}\n\ncheck item ${input.id}`,
      from: input.from,
      from_id: resolvedFromId,
      rule: 'a seat to a declared seat of its own team',
      thread: input.id,
    };
    const signed = signRecord(payload, home);
    const written = writeRecord(dropDir, signed);
    if (!written.ok) {
      throw new Error(`failed to seed drop ${input.id}: ${written.reason}`);
    }
    return written.path;
  }

  function leadDropDir(): string {
    return join(dir, 'send-drops', session, 'lead-coord');
  }

  function leadDropFiles(): string[] {
    const folder = leadDropDir();
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => !name.endsWith('.reported') && !name.endsWith('.wake') && !name.endsWith('.json'))
      .sort();
  }

  function readSenderMailboxRecord(sender: string, messageId: string) {
    const path = messageFile(root, sender, `unread-${messageId}`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as {
      payload: MessagePayload;
      signature: string;
    };
  }

  return {
    base,
    root,
    dir,
    home,
    session,
    team,
    agents,
    spoken,
    scene,
    seedUnreadDrop,
    leadDropDir,
    leadDropFiles,
    readSenderMailboxRecord,
  };
}

describe('S4 independent coverage: signed lead-drop aggregation and drain retry', () => {
  test('1. N waiting unread items across multiple seats yield one signed lead drop listing all N, while preserving per-message sender records and runtime signing identity', () => {
    const h = createSyntheticHarness();
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    const id3 = '33333333-3333-4333-8333-333333333333';

    h.seedUnreadDrop({ id: id1, to: 'worker-a', from: 'sender-one' });
    h.seedUnreadDrop({ id: id2, to: 'worker-a', from: 'sender-two' });
    h.seedUnreadDrop({ id: id3, to: 'worker-b', from: 'sender-one' });

    // Record a sent wake marker on id2 so wake state differentiation is also verified in the aggregate body.
    const workerADropDir = join(h.dir, 'send-drops', h.session, 'worker-a');
    const workerBDropDir = join(h.dir, 'send-drops', h.session, 'worker-b');
    writeFileSync(
      wakePath(workerADropDir, id2),
      `${JSON.stringify({ id: id2, at: '2026-10-21T18:58:00.000Z', state: 'sent' })}\n`,
    );

    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    // Exactly ONE signed drop in the lead's send-drops directory.
    const leadFiles = h.leadDropFiles();
    const expectedLeadId = expectedAggregateReportUuid([id3, id1, id2]);
    expect(leadFiles).toEqual([expectedLeadId]);
    expect(expectedLeadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    // Verify the signed lead drop's cryptographic signature and runtime identity.
    const leadDropPath = join(h.leadDropDir(), expectedLeadId);
    const readLead = readRecord(leadDropPath, expectedLeadId);
    expect(readLead.ok).toBe(true);
    if (!readLead.ok || readLead.record === null) throw new Error('missing lead record');
    const key = messageKeyOf(h.home);
    expect(verifyRecord(readLead.record, key)).toBe(true);
    expect(readLead.record.payload).toMatchObject({
      kind: 'message',
      id: expectedLeadId,
      to: 'lead-coord',
      to_id: null,
      root: h.root,
      session: h.session,
      from: 'runtime',
      from_id: null,
      rule: "the team's unread-message report",
      thread: expectedLeadId,
    });

    // Body lists all 3 unread items under the aggregate count header.
    const lines = readLead.record.payload.body.split('\n');
    expect(lines[0]).toBe('3 messages have been unread past the report window:');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(`worker-a: a message from sender-one has been unread for 3 min (id ${id1}); no wake line was typed`);
    expect(lines[2]).toContain(`worker-a: a message from sender-two has been unread for 3 min (id ${id2}); its wake line was sent at 2026-10-21T18:58:00.000Z`);
    expect(lines[3]).toContain(`worker-b: a message from sender-one has been unread for 3 min (id ${id3}); no wake line was typed`);

    // Lead's inbox (`listUnread`) serves the single aggregated drop.
    const leadUnread = listUnread(
      h.leadDropDir(),
      { to: 'lead-coord', root: h.root, session: h.session },
      h.home,
    );
    expect(leadUnread.map((m) => m.id)).toEqual([expectedLeadId]);

    // Per-message sender Runtime mailbox records exist for each message and verify under MESSAGE_DOMAIN.
    const senderOneRec1 = h.readSenderMailboxRecord('sender-one', id1);
    const senderTwoRec2 = h.readSenderMailboxRecord('sender-two', id2);
    const senderOneRec3 = h.readSenderMailboxRecord('sender-one', id3);
    expect(senderOneRec1).not.toBeNull();
    expect(senderTwoRec2).not.toBeNull();
    expect(senderOneRec3).not.toBeNull();

    for (const [rec, msgId, recipient] of [
      [senderOneRec1!, id1, 'worker-a'],
      [senderTwoRec2!, id2, 'worker-a'],
      [senderOneRec3!, id3, 'worker-b'],
    ] as const) {
      expect(verifyDomain(MESSAGE_DOMAIN, rec.payload as unknown as Json, rec.signature, key)).toBe(true);
      expect(rec.payload.from).toBe(OWNER_RECORD_FROM);
      expect(rec.payload.id).toBe(`unread-${msgId}`);
      expect(rec.payload.body).toContain(`${recipient}: a message from `);
      expect(rec.payload.body).toContain(`(id ${msgId})`);
    }

    // Each `.reported` marker names the aggregate report UUID and state: 'reported'.
    for (const [dropDir, msgId, sender] of [
      [workerADropDir, id1, 'sender-one'],
      [workerADropDir, id2, 'sender-two'],
      [workerBDropDir, id3, 'sender-one'],
    ] as const) {
      const marker = JSON.parse(readFileSync(reportedPath(dropDir, msgId), 'utf8'));
      expect(marker).toMatchObject({
        id: msgId,
        report: expectedLeadId,
        state: 'reported',
        to: [sender, 'lead-coord'],
      });
    }
  });

  test('2. repeat pass and lost-marker pass produce no duplicate lead drop, no duplicate sender record, and no self-report on the lead drop', () => {
    const h = createSyntheticHarness();
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    h.seedUnreadDrop({ id: idA, to: 'worker-a', from: 'sender-one' });
    h.seedUnreadDrop({ id: idB, to: 'worker-b', from: 'sender-two' });

    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });
    const expectedLeadId = expectedAggregateReportUuid([idA, idB]);
    expect(h.leadDropFiles()).toEqual([expectedLeadId]);
    expect(h.spoken).toHaveLength(2);

    const leadDropPath = join(h.leadDropDir(), expectedLeadId);
    const firstLeadBytes = readFileSync(leadDropPath, 'utf8');
    const firstSenderABytes = readFileSync(messageFile(h.root, 'sender-one', `unread-${idA}`), 'utf8');

    // (a) Immediate repeat pass with `.reported` markers present — even after advancing clock past 2x window
    // so the unread lead report drop itself is older than threshold (verifying LEAD_REPORT_RULE is ignored).
    h.spoken.length = 0;
    h.scene.now = new Date(BASE_TIME.getTime() + 300_000);
    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    expect(h.leadDropFiles()).toEqual([expectedLeadId]);
    expect(h.spoken).toEqual([]);
    expect(readFileSync(leadDropPath, 'utf8')).toBe(firstLeadBytes);

    // (b) Lost-marker pass: remove `.reported` markers while the standing lead drop and sender records remain.
    const dropDirA = join(h.dir, 'send-drops', h.session, 'worker-a');
    const dropDirB = join(h.dir, 'send-drops', h.session, 'worker-b');
    unlinkSync(reportedPath(dropDirA, idA));
    unlinkSync(reportedPath(dropDirB, idB));
    expect(existsSync(reportedPath(dropDirA, idA))).toBe(false);
    expect(existsSync(reportedPath(dropDirB, idB))).toBe(false);

    h.spoken.length = 0;
    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    // No second lead drop is written; standing lead drop and sender record bytes are untouched;
    // `.reported` markers are restored with `report: expectedLeadId`; nothing new is spoken.
    expect(h.leadDropFiles()).toEqual([expectedLeadId]);
    expect(readFileSync(leadDropPath, 'utf8')).toBe(firstLeadBytes);
    expect(readFileSync(messageFile(h.root, 'sender-one', `unread-${idA}`), 'utf8')).toBe(firstSenderABytes);
    expect(h.spoken).toEqual([]);
    expect(JSON.parse(readFileSync(reportedPath(dropDirA, idA), 'utf8'))).toMatchObject({
      id: idA,
      report: expectedLeadId,
      state: 'reported',
    });
    expect(JSON.parse(readFileSync(reportedPath(dropDirB, idB), 'utf8'))).toMatchObject({
      id: idB,
      report: expectedLeadId,
      state: 'reported',
    });
  });

  test('3. failed lead write releases every reservation before sender records are written, and subsequent retry publishes once', () => {
    const h = createSyntheticHarness();
    const id1 = '44444444-4444-4444-8444-444444444444';
    const id2 = '55555555-5555-4555-8555-555555555555';

    h.seedUnreadDrop({ id: id1, to: 'worker-a', from: 'sender-one' });
    h.seedUnreadDrop({ id: id2, to: 'worker-b', from: 'sender-two' });

    const dropDirA = join(h.dir, 'send-drops', h.session, 'worker-a');
    const dropDirB = join(h.dir, 'send-drops', h.session, 'worker-b');

    // Obstruct the lead's drop folder by placing a regular file at `<dir>/send-drops/<session>/lead-coord`
    // so `writeLeadReportDrop` fails on disk write before any sender mailbox record is written.
    mkdirSync(join(h.dir, 'send-drops', h.session), { recursive: true });
    writeFileSync(h.leadDropDir(), 'obstruction-file');

    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    // Every `.reported` reservation taken in the pass must be released on lead write failure.
    expect(existsSync(reportedPath(dropDirA, id1))).toBe(false);
    expect(existsSync(reportedPath(dropDirB, id2))).toBe(false);

    // Zero sender mailbox records may be written when the lead write fails.
    expect(h.readSenderMailboxRecord('sender-one', id1)).toBeNull();
    expect(h.readSenderMailboxRecord('sender-two', id2)).toBeNull();

    // The refusal line names the count of messages that could not be written.
    expect(h.spoken).toHaveLength(1);
    expect(h.spoken[0]?.text).toContain('the unread report for 2 messages was not written');
    expect(h.spoken[0]?.text).toContain('nothing was sent');

    // Remove the obstruction and run the retry pass.
    unlinkSync(h.leadDropDir());
    h.spoken.length = 0;

    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    const expectedLeadId = expectedAggregateReportUuid([id1, id2]);
    expect(h.leadDropFiles()).toEqual([expectedLeadId]);
    expect(h.readSenderMailboxRecord('sender-one', id1)).not.toBeNull();
    expect(h.readSenderMailboxRecord('sender-two', id2)).not.toBeNull();
    expect(existsSync(reportedPath(dropDirA, id1))).toBe(true);
    expect(existsSync(reportedPath(dropDirB, id2))).toBe(true);
    expect(h.spoken).toHaveLength(2);
  });

  test('4. deterministic UUID is order-independent and single-message report preserves the 1-message header and UUID vector', () => {
    const h = createSyntheticHarness();
    const singleId = '66666666-6666-4666-8666-666666666666';
    h.seedUnreadDrop({ id: singleId, to: 'worker-a', from: 'sender-one' });

    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    const expectedSingleUuid = expectedAggregateReportUuid([singleId]);
    expect(h.leadDropFiles()).toEqual([expectedSingleUuid]);

    const readSingle = readRecord(join(h.leadDropDir(), expectedSingleUuid), expectedSingleUuid);
    expect(readSingle.ok).toBe(true);
    if (!readSingle.ok || readSingle.record === null) throw new Error('missing single lead record');
    expect(readSingle.record.payload.body.split('\n')[0]).toBe(
      '1 message has been unread past the report window:',
    );

    // Order independence of deterministic UUID helper for multi-message sets.
    const idX = '77777777-7777-4777-8777-777777777777';
    const idY = '88888888-8888-4888-8888-888888888888';
    expect(expectedAggregateReportUuid([idX, idY])).toBe(expectedAggregateReportUuid([idY, idX]));
    expect(expectedAggregateReportUuid([idX, idY, idX])).toBe(expectedAggregateReportUuid([idX, idY]));
  });

  test('5. owner sender and unresolved sender are aggregated into the single lead drop with explicit resolution reason while keeping per-sender mailbox isolation', () => {
    const h = createSyntheticHarness();
    const idOwner = '99999999-9999-4999-8999-999999999991';
    const idUnresolved = '99999999-9999-4999-8999-999999999992';

    h.seedUnreadDrop({ id: idOwner, to: 'worker-a', from: OWNER_MAILBOX, fromId: null });
    h.seedUnreadDrop({
      id: idUnresolved,
      to: 'worker-b',
      from: 'sender-one',
      fromId: 'agt_deadbeef0000',
    });

    reportUnreadDrops(h.scene, { unreadAfter: UNREAD_AFTER_SECONDS });

    const expectedLeadId = expectedAggregateReportUuid([idOwner, idUnresolved]);
    expect(h.leadDropFiles()).toEqual([expectedLeadId]);

    const readLead = readRecord(join(h.leadDropDir(), expectedLeadId), expectedLeadId);
    expect(readLead.ok).toBe(true);
    if (!readLead.ok || readLead.record === null) throw new Error('missing aggregate lead record');

    const body = readLead.record.payload.body;
    expect(body).toContain('2 messages have been unread past the report window:');
    expect(body).toContain(`worker-a: a message from owner has been unread for 3 min (id ${idOwner})`);
    expect(body).toContain(
      `worker-b: a message from sender-one has been unread for 3 min (id ${idUnresolved}); no wake line was typed; the drop is at ${join(h.dir, 'send-drops', h.session, 'worker-b', idUnresolved)}; the sender's own mailbox could not be resolved (agent agt_deadbeef0000 is not a live record in this home's registry), so this report goes to the team's lead only`,
    );

    // Owner mailbox receives its per-message record; sender-one does NOT receive a record for the unresolved agent id.
    expect(h.readSenderMailboxRecord(OWNER_MAILBOX, idOwner)).not.toBeNull();
    expect(h.readSenderMailboxRecord('sender-one', idUnresolved)).toBeNull();
  });
});
