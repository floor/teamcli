// Red-first tests for 0.5.13 compact delivery mode and `team show <id>` (`feat/compact-delivery-mode`):
// 1. Per-seat opt-in `compact_delivery: true` on a seat in `.agents/team.yaml`:
//    - Omitted and `compact_delivery: false` both omit `compactDelivery` on the parsed `Seat`,
//      preserving the existing seat approval digest (`fingerprints(team).seats.<seat>`).
//    - `compact_delivery: true` sets `seat.compactDelivery === true` and changes the seat digest.
//    - Non-boolean `compact_delivery` fails team file validation with a clear message.
//    - `compact_delivery` is a seat setting only, not in `CONFIG_KEYS`.
// 2. Compact socket frame when the receiving seat has `compact_delivery: true`:
//    - Socket frame carries only `<compact sender header>\n\n<first content line>\n\n↩ team show <prefix> · team reply <prefix> · team ack <prefix>`.
//    - Never emits line 2+ of a multi-line body in the socket frame.
//    - Signed record on disk (`.agents/send-drops/<session>/<seat>/<id>`) still stores the full
//      multi-line `payload.body` and `payload.rule` unchanged.
//    - Seats without `compact_delivery: true` continue to receive the full multi-line body and
//      `↩ team reply <prefix> "…" · team ack <prefix>`.
//    - Daemon socket sends and daemon relay route frames also honor `compact_delivery: true`.
// 3. `team show <id>` command:
//    - Prints the caller's own message by full id or unique >=8-char prefix with the compact sender
//      header, the full multi-line body, and `↩ team reply <prefix> "…" · team ack <prefix>`.
//    - Works for both seat-origin and client-origin messages in the caller's own mailbox, and
//      supports `--json` (`team.show` envelope).
//    - Publishes the signed `<id>.read.json` receipt on first show (`written: true`) and still
//      shows an already-read (`written: false`) or already-replied record from the caller's own
//      mailbox when re-run.
//    - Refuses another seat's message id without leaking any body text or writing a receipt.
//    - Refuses an unplaced/detached caller or a seat caller on the wrong pane/session (raising a
//      placement security refusal).
//    - Refuses a prefix shorter than 8 characters, an ambiguous prefix naming colliding ids, an
//      unknown id, or a tampered record without leaking the body.
//
// Synthetic homes, repositories, keys, and panes only; never touches real credential stores.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fingerprints } from '../src/approve/fingerprint.ts';
import { CLIENT_RULE } from '../src/client/send.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply } from '../src/commands/reply.ts';
import { runSend } from '../src/commands/send.ts';
import { CONFIG_KEYS } from '../src/config/registry.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { cliHookSettingsPath } from '../src/launch/cli-hook.ts';
import { lobbyDir, resolveLobby } from '../src/lobby/gate.ts';
import { registerAgent } from '../src/registry/agents.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { requestDaemon, startSendDaemon, type DaemonHost } from '../src/send/daemon.ts';
import * as frameMod from '../src/send/frame.ts';
import { readRecord, signRecord, writeRecord, type RecordPayload } from '../src/send/record.ts';
import { attributedBody } from '../src/send/sender-claim.ts';
import { updateState } from '../src/state.ts';
import { messageKeyOf } from '../src/store/keys.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { fake, owner, world, type World } from './send-native-fixtures.ts';
import { claimRead, ownerOfClaim } from '../src/send/read-claim.ts';

const NOW = new Date('2026-11-05T15:00:00.000Z');
const PANE_ORCH = 'pane-orch-cdm';
const PANE_BEA = 'pane-bea-cdm';
const PANE_ARGON = 'pane-argon-cdm';
const TO_ORCH_RULE = "a seat to its own team's orchestrator";
const FROM_ORCH_RULE = 'an orchestrator or operator to a seat of its own team';

const BASE_SEAT_YAML = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const TEAM_YAML = `format: 1
project: acme
coordinator: orchestrator
operator: orchestrator
workspace:
  mode: shared
seats:
  - role: coordinator
    name: orchestrator
    label: coordinator
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    leads: true
    compact_delivery: true
  - role: implementer
    name: builder-claude
    label: Bea · builder
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: implementer
    name: builder-gemini
    label: Argon · builder
    cli: antigravity
    vendor: google
    model: Gemini 4 Argon
    version: "1"
    launch: agy --model gemini-4-argon
`;

const cleanupDirs: string[] = [];
const extraCleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of extraCleanups.splice(0)) fn();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFixture() {
  const base = fixtureBase('.compact-delivery-mode-');
  cleanupDirs.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv(), stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
  messageKeyOf(home);

  const orchAgent = registerAgent(home, {
    name: 'Dora',
    signing: { model: 'Claude Opus', version: '5.5', role: 'coordinator' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-opus-5-5',
    reach: { team: 'acme', seat: 'orchestrator', session: 'acme', pane: PANE_ORCH, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const beaAgent = registerAgent(home, {
    name: 'Bea',
    signing: { model: 'Claude Sonnet', version: '5.5', role: 'implementer' },
    lab: 'anthropic',
    cli: 'claude-code',
    launcher: null,
    launch: 'claude --model claude-sonnet-5-5',
    reach: { team: 'acme', seat: 'builder-claude', session: 'acme', pane: PANE_BEA, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });
  const argonAgent = registerAgent(home, {
    name: 'Argon',
    signing: { model: 'Gemini 4 Argon', version: '1', role: 'implementer' },
    lab: 'google',
    cli: 'antigravity',
    launcher: null,
    launch: 'agy --model gemini-4-argon',
    reach: { team: 'acme', seat: 'builder-gemini', session: 'acme', pane: PANE_ARGON, address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    by: 'team up',
  });

  upsertTeam(home, teamIdOf(root), {
    project: 'acme',
    session: 'acme',
    root,
    lobby: '',
    roster: [
      { agent: orchAgent.id, seat: 'orchestrator', role: 'coordinator', nickname: 'Dora' },
      { agent: beaAgent.id, seat: 'builder-claude', role: 'implementer', nickname: 'Bea' },
      { agent: argonAgent.id, seat: 'builder-gemini', role: 'implementer', nickname: 'Argon' },
    ],
  });

  updateState(join(root, '.agents'), (state) => {
    state.sessions.acme = {
      seats: {
        orchestrator: { stage: 'ready' as const, pane: PANE_ORCH },
        'builder-claude': { stage: 'ready' as const, pane: PANE_BEA },
        'builder-gemini': { stage: 'ready' as const, pane: PANE_ARGON },
      },
    } as never;
  });

  const dropDir = join(root, '.agents', 'send-drops', 'acme', 'orchestrator');
  return {
    base,
    root,
    home,
    dropDir,
    agents: {
      orchestrator: orchAgent.id,
      claude: beaAgent.id,
      gemini: argonAgent.id,
    },
  };
}

describe('1. seat compact_delivery setting and approval digest preservation', () => {
  test('compact_delivery is omitted on Seat when unset or false, preserves the seat digest when unset or false, and changes the seat digest when true', () => {
    const omitted = validateTeamFile(BASE_SEAT_YAML);
    expect(omitted.ok).toBe(true);
    if (!omitted.ok) return;
    const seatOmitted = omitted.team.seats[0]! as Record<string, unknown>;
    expect('compactDelivery' in seatOmitted).toBe(false);
    const digestOmitted = fingerprints(omitted.team).seats.lead;
    expect(typeof digestOmitted).toBe('string');

    const explicitFalse = validateTeamFile(`${BASE_SEAT_YAML}    compact_delivery: false\n`);
    expect(explicitFalse.ok).toBe(true);
    if (!explicitFalse.ok) return;
    const seatFalse = explicitFalse.team.seats[0]! as Record<string, unknown>;
    expect('compactDelivery' in seatFalse).toBe(false);
    const digestFalse = fingerprints(explicitFalse.team).seats.lead;
    expect(digestFalse).toBe(digestOmitted);

    const explicitTrue = validateTeamFile(`${BASE_SEAT_YAML}    compact_delivery: true\n`);
    expect(explicitTrue.ok).toBe(true);
    if (!explicitTrue.ok) return;
    const seatTrue = explicitTrue.team.seats[0]! as Record<string, unknown>;
    expect(seatTrue.compactDelivery).toBe(true);
    const digestTrue = fingerprints(explicitTrue.team).seats.lead;
    expect(digestTrue).not.toBe(digestOmitted);
  });

  test('non-boolean compact_delivery fails validation and compact_delivery is not a team config key', () => {
    const bad = validateTeamFile(`${BASE_SEAT_YAML}    compact_delivery: "yes"\n`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.message).join('; ')).toContain(
        'seat "lead": compact_delivery must be true or false',
      );
    }

    expect((CONFIG_KEYS as readonly string[]).includes('compact_delivery')).toBe(false);
  });
});

describe('2. compact socket frame vs full socket frame', () => {
});

describe('3. team show <id> full-body inspection, read receipt, re-show, and mailbox scoping', () => {
  test('team show prints the full multi-line message by full id or >=8-char prefix, writes the read receipt on first show, and still shows an already-read or already-replied record', async () => {
    const f = makeFixture();
    const id = '47c25f34-ab42-47d2-a54c-5597aeb305fa';
    const rawBody = `from Argon — admitted by: ${TO_ORCH_RULE}\n\nHeadline line 1\nBody line 2\nBody line 3`;
    plantRecord(f.home, f.root, 'acme', 'orchestrator', id, rawBody, {
      from: 'builder-gemini',
      from_id: f.agents.gemini,
      rule: TO_ORCH_RULE,
      at: NOW.toISOString(),
    });

    const showMod = await import('../src/commands/show.ts');
    const runShow = showMod.runShow as (
      argv: string[],
      io: ReturnType<typeof testIo>,
      host: { home: string; now: () => Date },
    ) => Promise<number>;

    // 1. First show by 8-char prefix writes the read receipt and prints the full multi-line body
    const firstIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['47c25f34'], firstIo, { home: f.home, now: () => NOW })).toBe(0);
    expect(firstIo.out).toBe(
      'Argon · builder-gemini@acme · Gemini 4 Argon 1 · 2026-11-05 15:00Z · admitted: to orchestrator\n\nHeadline line 1\nBody line 2\nBody line 3\n\n↩ team reply 47c25f34 "…" · team ack 47c25f34\n',
    );
    expect(existsSync(join(f.dropDir, `${id}.read.json`))).toBe(true);

    // 2. Second show by full id on the already-read record still prints the full body (with written:false in --json)
    const secondIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow([id], secondIo, { home: f.home, now: () => NOW })).toBe(0);
    expect(secondIo.out).toBe(firstIo.out);

    const jsonIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['47c25f34', '--json'], jsonIo, { home: f.home, now: () => NOW })).toBe(0);
    const parsedJson = JSON.parse(jsonIo.out) as {
      format: number;
      id: string;
      prefix: string;
      seat: string;
      written: boolean;
      content: string;
    };
    expect(parsedJson.format).toBe(1);
    expect(parsedJson.id).toBe(id);
    expect(parsedJson.prefix).toBe('47c25f34');
    expect(parsedJson.seat).toBe('orchestrator');
    expect(parsedJson.written).toBe(false);
    expect(parsedJson.content).toBe(
      'Argon · builder-gemini@acme · Gemini 4 Argon 1 · 2026-11-05 15:00Z · admitted: to orchestrator\n\nHeadline line 1\nBody line 2\nBody line 3\n\n↩ team reply 47c25f34 "…" · team ack 47c25f34',
    );

    // 3. Even after `team reply` writes `<id>.replied.json`, `team show` still displays the message
    const replyIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(
      await runReply(['47c25f34', 'Ack'], replyIo, {
        home: f.home,
        now: () => NOW,
      }),
    ).toBe(0);
    expect(existsSync(join(f.dropDir, `${id}.replied.json`))).toBe(true);

    const afterReplyIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['47c25f34'], afterReplyIo, { home: f.home, now: () => NOW })).toBe(0);
    expect(afterReplyIo.out).toBe(firstIo.out);
  });

  test('team show rereads a body a hand-over holds (expose owner): shown, no read receipt, claim kept', async () => {
    const f = makeFixture();
    const id = '47c25f34-ab42-47d2-a54c-5597aeb305fb';
    plantRecord(f.home, f.root, 'acme', 'orchestrator', id, `from Argon — admitted by: ${TO_ORCH_RULE}\n\nHeld line`, {
      from: 'builder-gemini',
      from_id: f.agents.gemini,
      rule: TO_ORCH_RULE,
      at: NOW.toISOString(),
    });
    const owner = `expose:channel:${id}:a1b2c3d4e5f6`;
    const claim = claimRead(f.dropDir, id, owner);
    expect(claim.ok).toBe(true);
    if (claim.ok) claim.keep();
    const { runShow } = await import('../src/commands/show.ts');
    const io = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow([id], io, { home: f.home, now: () => NOW })).toBe(0);
    expect(io.out).toContain('Held line');
    expect(existsSync(join(f.dropDir, `${id}.read.json`))).toBe(false);
    expect(ownerOfClaim(f.dropDir, id)).toBe(owner);
    // A claim held by a non-expose owner (an interrupted relayed read) is not reshown.
    const other = '47c25f34-ab42-47d2-a54c-5597aeb305fc';
    plantRecord(f.home, f.root, 'acme', 'orchestrator', other, `from Argon — admitted by: ${TO_ORCH_RULE}\n\nRecovering line`, {
      from: 'builder-gemini',
      from_id: f.agents.gemini,
      rule: TO_ORCH_RULE,
      at: NOW.toISOString(),
    });
    const relayed = claimRead(f.dropDir, other, 'relay:req-1');
    if (relayed.ok) relayed.keep();
    const io2 = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow([other], io2, { home: f.home, now: () => NOW })).not.toBe(0);
    expect(io2.out).not.toContain('Recovering line');
  });

  test('team show works for client-origin messages in the orchestrator mailbox', async () => {
    const f = makeFixture();
    mkdirSync(f.dropDir, { recursive: true });
    const clientId = '019a0000-0000-7000-8000-000000000101';
    const payload: RecordPayload = {
      kind: 'message',
      id: clientId,
      to: 'orchestrator',
      to_id: f.agents.orchestrator,
      from: 'client:grok-bot',
      from_id: null,
      from_client: {
        client_id: 'grok-bot',
        grant_id: 'grant-01',
      },
      rule: CLIENT_RULE,
      root: f.root,
      session: 'acme',
      at: NOW.toISOString(),
      body: `from client:grok-bot — admitted by: ${CLIENT_RULE}\n\nClient ping line 1.\nClient ping line 2.`,
      thread: clientId,
    };
    writeRecord(f.dropDir, signRecord(payload, f.home));

    const showMod = await import('../src/commands/show.ts');
    const runShow = showMod.runShow as (
      argv: string[],
      io: ReturnType<typeof testIo>,
      host: { home: string; now: () => Date },
    ) => Promise<number>;

    const io = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['019a0000'], io, { home: f.home, now: () => NOW })).toBe(0);
    expect(io.out).toBe(
      'Grok Bot · client:grok-bot (grant grant-01) · 2026-11-05 15:00Z · admitted: owner relay\n\nClient ping line 1.\nClient ping line 2.\n\n↩ team reply 019a0000 "…" · team ack 019a0000\n',
    );
    expect(existsSync(join(f.dropDir, `${clientId}.read.json`))).toBe(true);
  });

  test('team show refuses another seat message id, an unplaced/wrong-pane caller, a <8-char prefix, an ambiguous prefix, and an unknown id without leaking any body text', async () => {
    const f = makeFixture();
    const id1 = '47c25f34-ab42-47d2-a54c-5597aeb305fa';
    const id2 = '47c25f34-ab99-4000-8000-000000000001';
    const otherSeatId = '99aa0011-2233-4455-6677-8899aabbccdd';

    plantRecord(
      f.home,
      f.root,
      'acme',
      'orchestrator',
      id1,
      `from Bea — admitted by: ${TO_ORCH_RULE}\n\nSecret orchestrator note 1.\n`,
      {
        from: 'builder-claude',
        from_id: f.agents.claude,
        rule: TO_ORCH_RULE,
        at: NOW.toISOString(),
      },
    );
    plantRecord(
      f.home,
      f.root,
      'acme',
      'orchestrator',
      id2,
      `from Argon — admitted by: ${TO_ORCH_RULE}\n\nSecret orchestrator note 2.\n`,
      {
        from: 'builder-gemini',
        from_id: f.agents.gemini,
        rule: TO_ORCH_RULE,
        at: NOW.toISOString(),
      },
    );
    plantRecord(
      f.home,
      f.root,
      'acme',
      'builder-claude',
      otherSeatId,
      `from Dora — admitted by: ${FROM_ORCH_RULE}\n\nPrivate note for Bea only.\n`,
      {
        from: 'orchestrator',
        from_id: f.agents.orchestrator,
        rule: FROM_ORCH_RULE,
        at: NOW.toISOString(),
      },
    );

    const showMod = await import('../src/commands/show.ts');
    const runShow = showMod.runShow as (
      argv: string[],
      io: ReturnType<typeof testIo>,
      host: { home: string; now: () => Date },
    ) => Promise<number>;

    // 1. Orchestrator trying to show builder-claude's message is refused without leaking body
    const crossSeatIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['99aa0011'], crossSeatIo, { home: f.home, now: () => NOW })).toBe(1);
    expect(crossSeatIo.err).toContain('addressed to builder-claude, not to orchestrator');
    expect(crossSeatIo.out).toBe('');
    expect(crossSeatIo.err).not.toContain('Private note for Bea only');
    expect(existsSync(join(recordDir(f.root, 'acme', 'builder-claude'), `${otherSeatId}.read.json`))).toBe(false);

    // 2. Seat caller on wrong pane is refused with placement refusal and no body leak
    const wrongPaneIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_BEA, session: 'acme' });
    expect(await runShow(['47c25f34-ab4'], wrongPaneIo, { home: f.home, now: () => NOW })).toBe(1);
    expect(wrongPaneIo.err).toContain('is not this call on its own pane and session');
    expect(wrongPaneIo.out).toBe('');
    expect(wrongPaneIo.err).not.toContain('Secret orchestrator note');

    // 3. Prefix shorter than 8 characters is refused
    const shortIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['47c2'], shortIo, { home: f.home, now: () => NOW })).toBe(1);
    expect(shortIo.err).toContain('8 characters');
    expect(shortIo.out).toBe('');

    // 4. Ambiguous prefix in the caller's mailbox is refused naming the colliding ids
    const ambigIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['47c25f34'], ambigIo, { home: f.home, now: () => NOW })).toBe(1);
    expect(ambigIo.err).toContain('ambiguous');
    expect(ambigIo.err).toContain(id1);
    expect(ambigIo.err).toContain(id2);
    expect(ambigIo.out).toBe('');

    // 5. Unknown id is refused
    const unknownIo = testIo(f.root, { kind: 'seat', name: 'orchestrator', pane: PANE_ORCH, session: 'acme' });
    expect(await runShow(['deadbeef'], unknownIo, { home: f.home, now: () => NOW })).toBe(1);
    expect(unknownIo.err).toContain('no record named deadbeef waits');
    expect(unknownIo.out).toBe('');
  });
});
