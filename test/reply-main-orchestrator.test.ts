// A seat answers the entity's main orchestrator on the thread that orchestrator opened toward
// that seat, and nowhere else (the main orchestrator reach's reply direction).
//
// The reach itself is the send direction's — the lead of the team whose project is the entity
// writes to any seat below it. This file covers the one reply it admits in return: bound to the
// verified record the main orchestrator sent to this seat, on the thread whose opening record is
// that same sender's and this seat's, gated by the reach's own `seats_cross_teams` setting, and
// refused wherever the binding does not hold. A seat never opens a thread to the main
// orchestrator: a plain send stays refused, and a closed thread is not reopened as one.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir } from '../src/commands/messages.ts';
import { runReply, type ReplyHost } from '../src/commands/reply.ts';
import { realHost as realSendHost, runSend } from '../src/commands/send.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { findAgent, type Agent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { admitSend, MAIN_ORCHESTRATOR_REPLY_RULE, REPLY_RULE, senderHeader, type AdmitContext, type AdmitTeams } from '../src/send/admit.ts';
import { installKey } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { recordAt, testIo } from './helpers.ts';

const MAIN_SEND_RULE = "the entity's main orchestrator to any seat of the entity's teams";
const SEAT_RULE = "a seat to its own team's orchestrator";
const LEADS_RULE = 'an orchestrator to another orchestrator';

// The command scenes' records: the answered question and its answer.
const SENT_ONE = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b';
const SENT_TWO = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c';
const OPENED = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
const REPLY_ONE = '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const REPLY_TWO = '8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f';

// ---------------------------------------------------------------------------------------------
// The rules, at admission's own level: what the marker asks, and what a plain send still asks.
// ---------------------------------------------------------------------------------------------

function agent(id: string, seat: string, team: string, role = 'builder'): Agent {
  return {
    id,
    name: `${seat} of ${team}`,
    signing: { model: 'Claude Sonnet', version: '5.5', role },
    lab: 'anthropic',
    cli: 'antigravity',
    launcher: null,
    launch: 'zsh -lc "agy"',
    reach: { team, seat, session: team, pane: 'pane1', address: null },
    mcp: [],
    skills: [],
    lifecycle: 'running',
    provenance: { registered_by: 'team up', registered_at: '2026-11-03T10:00:00Z', updated_at: '2026-11-03T10:00:00Z' },
  };
}

const FLOOR_ORCH = 'agt_000000061001';
const FLOOR_BUILDER = 'agt_000000061002';
const LABS_ORCH = 'agt_000000061003';
const LABS_BUILDER = 'agt_000000061004';
const RADIO_ORCH = 'agt_000000061005';
const RADIO_BUILDER = 'agt_000000061006';
const LEGACY_BUILDER = 'agt_000000061007';

// The entity's head team (`floor`, its project is the entity itself) and two teams below it —
// one of the entity, one of another entity. `legacy` names no entity, so no reach may leave it.
const floorOrch = agent(FLOOR_ORCH, 'orchestrator', 'floor', 'orchestrator');
const floorBuilder = agent(FLOOR_BUILDER, 'builder-1', 'floor');
const labsOrch = agent(LABS_ORCH, 'orchestrator', 'labs', 'orchestrator');
const labsBuilder = agent(LABS_BUILDER, 'builder-1', 'labs');
const radioOrch = agent(RADIO_ORCH, 'orchestrator', 'radio', 'orchestrator');
const radioBuilder = agent(RADIO_BUILDER, 'builder-1', 'radio');
const legacyBuilder = agent(LEGACY_BUILDER, 'builder-1', 'legacy');

const teams: AdmitTeams = {
  floor: {
    project: 'floor',
    entity: 'floor',
    roster: [
      { agent: FLOOR_ORCH, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: FLOOR_BUILDER, seat: 'builder-1', role: 'builder' },
    ],
  },
  labs: {
    project: 'labs',
    entity: 'floor',
    roster: [
      { agent: LABS_ORCH, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: LABS_BUILDER, seat: 'builder-1', role: 'builder' },
    ],
  },
  radio: {
    project: 'radio',
    entity: 'radio',
    roster: [
      { agent: RADIO_ORCH, seat: 'orchestrator', role: 'orchestrator', leads: true },
      { agent: RADIO_BUILDER, seat: 'builder-1', role: 'builder' },
    ],
  },
  legacy: {
    project: 'legacy',
    entity: null,
    roster: [{ agent: LEGACY_BUILDER, seat: 'builder-1', role: 'builder' }],
  },
};

/** The marker the reply command hands admission after it verified the record, its sender and the
 *  thread's opening record; a plain send never carries it. */
const marked = (crossTeams?: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>): AdmitContext => ({
  projects: {},
  crossTeams,
  reply: 'main-orchestrator-thread',
});

describe("the reply to the entity's main orchestrator, at admission's level", () => {
  test('the marked reply is admitted, and the rule names itself', () => {
    // The name is the contract the refusal and the reply header print.
    expect(MAIN_ORCHESTRATOR_REPLY_RULE).toBe("a seat replying to the entity's main orchestrator on its thread");
    expect(admitSend(labsBuilder, floorOrch, teams, undefined, marked())).toEqual({
      ok: true,
      rule: MAIN_ORCHESTRATOR_REPLY_RULE,
    });
    // The drop header carries the rule's own name.
    expect(senderHeader(labsBuilder, MAIN_ORCHESTRATOR_REPLY_RULE)).toContain(`admitted by: ${MAIN_ORCHESTRATOR_REPLY_RULE}`);
  });

  test('a send to the main orchestrator stays refused: the marker is a reply’s alone', () => {
    // A `team send` asks with no reply word at all — exactly this call.
    const plain = admitSend(labsBuilder, floorOrch, teams);
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.why).toContain('no rule admits it');
    // The project context a send builds changes nothing about this pair.
    expect(admitSend(labsBuilder, floorOrch, teams, undefined, { projects: {} }).ok).toBe(false);
    // And the seat reaching the main orchestrator is judged exactly as before.
    expect(admitSend(floorBuilder, floorOrch, teams)).toEqual({ ok: true, rule: SEAT_RULE });
    expect(admitSend(labsBuilder, floorOrch, teams).ok).toBe(false);
    expect(admitSend(radioOrch, floorOrch, teams).ok).toBe(false);
  });

  test('the marker is asked only for the place: another lead, a plain head seat, or no entity is refused', () => {
    // The target must hold the entity's main orchestrator place — the head team's lead.
    const plainHeadSeat = admitSend(labsBuilder, floorBuilder, teams, undefined, marked());
    expect(plainHeadSeat.ok).toBe(false);
    if (!plainHeadSeat.ok) {
      expect(plainHeadSeat.why).toContain('does not hold the entity\'s main orchestrator place');
      expect(plainHeadSeat.why).toContain(MAIN_ORCHESTRATOR_REPLY_RULE);
    }
    // Another entity's lead is not this entity's main orchestrator.
    expect(admitSend(labsBuilder, radioOrch, teams, undefined, marked()).ok).toBe(false);
    expect(admitSend(radioOrch, floorOrch, teams, undefined, marked()).ok).toBe(false);
    // A team that names no entity has no main orchestrator to answer.
    expect(admitSend(legacyBuilder, floorOrch, teams, undefined, marked()).ok).toBe(false);
  });

  test('ordinary rules answer first and keep their names, even under the marker', () => {
    expect(admitSend(floorBuilder, floorOrch, teams, undefined, marked())).toEqual({ ok: true, rule: SEAT_RULE });
    expect(admitSend(labsBuilder, labsOrch, teams, undefined, marked())).toEqual({ ok: true, rule: SEAT_RULE });
    expect(admitSend(labsOrch, floorOrch, teams, undefined, marked())).toEqual({ ok: true, rule: LEADS_RULE });
  });

  test('the generic open-thread rule is unchanged and keeps its own name', () => {
    // A pair no other rule admits is still admitted by a reply on an open thread, and the rule
    // that answered it is the generic one — the bound rule is asked instead of it only where the
    // verified sender is the entity's main orchestrator.
    expect(admitSend(labsBuilder, radioBuilder, teams, undefined, { projects: {}, reply: 'open-thread' })).toEqual({
      ok: true,
      rule: REPLY_RULE,
    });
    // A marked pair the place refuses names the bound rule, never the generic one.
    const refused = admitSend(labsBuilder, radioBuilder, teams, undefined, marked());
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.why).toContain(MAIN_ORCHESTRATOR_REPLY_RULE);
      expect(refused.why).not.toContain(REPLY_RULE);
    }
  });

  test("the reach is a setting, on by default: closed at any level of the asker's chain, reopened only by the project", () => {
    expect(admitSend(labsBuilder, floorOrch, teams, undefined, marked())).toEqual({ ok: true, rule: MAIN_ORCHESTRATOR_REPLY_RULE });
    expect(admitSend(labsBuilder, floorOrch, teams, undefined, marked({ project: true }))).toEqual({
      ok: true,
      rule: MAIN_ORCHESTRATOR_REPLY_RULE,
    });
    const closed: Partial<Record<'entity' | 'project' | 'team' | 'seat', boolean>>[] = [
      { entity: false }, { project: false }, { team: false }, { seat: false },
    ];
    for (const crossTeams of closed) {
      const verdict = admitSend(labsBuilder, floorOrch, teams, undefined, marked(crossTeams));
      expect({ crossTeams, ok: verdict.ok }).toEqual({ crossTeams, ok: false });
      if (!verdict.ok) expect(verdict.why).toContain("reach is closed by the asker's seats_cross_teams chain");
    }
    // Only the project may reopen what an entity closed; a lower level still closes it.
    expect(admitSend(labsBuilder, floorOrch, teams, undefined, marked({ entity: false, project: true }))).toEqual({
      ok: true,
      rule: MAIN_ORCHESTRATOR_REPLY_RULE,
    });
    for (const crossTeams of [{ entity: false, team: true }, { entity: false, project: true, team: false }, { project: false, team: true }]) {
      expect({ crossTeams, ok: admitSend(labsBuilder, floorOrch, teams, undefined, marked(crossTeams)).ok }).toEqual({ crossTeams, ok: false });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The command: the reply is bound to the verified record and to the thread it stands on.
// ---------------------------------------------------------------------------------------------

const NOW = new Date('2026-11-03T20:00:00.000Z');
const NOW_ISO = NOW.toISOString();

type TeamSpec = { project: string; entity: string; session: string; seats: string[]; lead: string };

// The entity's head team (its project is the entity itself), and a team below it whose plain
// seat answers. The work team's own lead is another seat, so the answering seat is no lead and
// no other rule pairs it with the head team's orchestrator: only the bound rule can.
const TEAMS: Record<string, TeamSpec> = {
  head: { project: 'acme', entity: 'acme', session: 'head', seats: ['orchestrator', 'inbox'], lead: 'orchestrator' },
  work: { project: 'work', entity: 'acme', session: 'work', seats: ['worker', 'helper', 'lead'], lead: 'lead' },
};

function teamText(spec: TeamSpec): string {
  const seats = spec.seats
    .map(
      (name) => `  - role: ${name === spec.lead ? 'coordinator' : 'implementer'}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
`,
    )
    .join('');
  return `format: 1
project: ${spec.project}
entity: ${spec.entity}
session: ${spec.session}
coordinator: ${spec.lead}
operator: ${spec.lead}
workspace:
  mode: shared
seats:
${seats}`;
}

function parsed(spec: TeamSpec, key: string): TeamFile {
  const checked = validateTeamFile(teamText(spec));
  if (!checked.ok) throw new Error(`the fixture's own file for ${key} does not validate: ${JSON.stringify(checked.errors)}`);
  return checked.team;
}

type World = { home: string; roots: Record<'head' | 'work', string>; headOrch: string; worker: string };

let base: string;
let world: World;

const paneOf = (team: string): string => `pane-${team}`;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reply-main-orchestrator-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const roots = { head: join(base, 'head'), work: join(base, 'work') };
  const files: Record<string, TeamFile> = {};
  for (const [key, spec] of Object.entries(TEAMS)) {
    const root = roots[key as 'head' | 'work'];
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(spec));
    files[key] = parsed(spec, key);
  }
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  // Both answering seats stand as launched: the head team's orchestrator (the record's sender)
  // and the work team's plain seat (the caller). Only the work seat needs a standing; the head
  // seat's record is read, not judged.
  const launched: [key: 'head' | 'work', seat: string][] = [['head', 'orchestrator'], ['work', 'worker']];
  for (const [key, seat] of launched) {
    const file = files[key] as TeamFile;
    const one = file.seats.find((candidate) => candidate.name === seat);
    if (!one) throw new Error(`the fixture's own team ${key} has no seat ${seat}`);
    const written = registerLaunch({ home, team: file, root: roots[key], by: 'up' }, one, paneOf(key));
    if ('note' in written) throw new Error(`the fixture's own registration failed: ${written.note}`);
    updateState(join(roots[key], '.agents'), (state) => {
      const session = state.sessions[file.session] ?? { seats: {}, worktrees: {} };
      session.seats[seat] = { stage: 'launched', pane: paneOf(key), workspace: 'main' };
      state.sessions[file.session] = session;
    });
  }
  const headOrch = findAgentOf(home, roots.head, 'orchestrator');
  const worker = findAgentOf(home, roots.work, 'worker');
  world = { home, roots, headOrch, worker };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function findAgentOf(home: string, root: string, seat: string): string {
  // The registry lookup the command itself uses, by the team's own id and seat.
  const agent = findAgent(home, { team: teamIdOf(root), seat });
  if (agent === null) throw new Error(`the fixture did not register ${seat}`);
  return agent.id;
}

function host(patch: Partial<ReplyHost> = {}): ReplyHost {
  return { home: world.home, now: () => NOW, ...patch };
}

/** The record the entity's main orchestrator sent this seat: signed, bound to the work tree's
 *  root and session, addressed to its worker, carrying the head team's registry id. */
function fromMainOrchestrator(id: string, text: string, thread = id): string {
  return plantRecord(
    world.home,
    world.roots.work,
    'work',
    'worker',
    id,
    `from orchestrator@acme — admitted by: ${MAIN_SEND_RULE}\n\n${text}`,
    {
      at: NOW_ISO,
      from: 'orchestrator',
      from_id: world.headOrch,
      to_id: world.worker,
      rule: MAIN_SEND_RULE,
      thread,
    },
  );
}

/** One reply as the work team's plain seat, standing on the pane the state records for it. */
async function answer(id: string, text: string, newId: string): Promise<{ code: number; out: string; err: string }> {
  const caller: Caller = { kind: 'seat', name: 'worker', pane: paneOf('work'), session: 'work' };
  const io = testIo(world.roots.work, caller);
  const code = await runReply([id, text], io, host({ newId: () => newId }));
  return { code, out: io.out, err: io.err };
}

const inHead = (id: string): string => join(recordDir(world.roots.head, 'head', 'orchestrator'), id);

describe("a seat's answer to the entity's main orchestrator", () => {
  test("is admitted on the main orchestrator's own thread, and lands where its reader reads", async () => {
    fromMainOrchestrator(SENT_ONE, 'the question');
    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const at = inHead(REPLY_ONE);
    expect(existsSync(at)).toBe(true);
    const record = recordAt(at);
    expect(record.payload).toMatchObject({
      to: 'orchestrator',
      to_id: world.headOrch,
      root: world.roots.head,
      session: 'head',
      from: 'worker',
      from_id: world.worker,
      thread: SENT_ONE,
      in_reply_to: SENT_ONE,
      rule: MAIN_ORCHESTRATOR_REPLY_RULE,
    });
    // The rule the header prints is the bound one, named in the drop itself.
    expect(record.payload.body).toContain(`admitted by: ${MAIN_ORCHESTRATOR_REPLY_RULE}`);
    expect(result.out).toContain('orchestrator: delivered');
    // The answering team's own tree does not hold a copy under the same name.
    expect(existsSync(join(recordDir(world.roots.work, 'work', 'worker'), REPLY_ONE))).toBe(false);
  });

  test('is refused on a thread another sender opened', async () => {
    // The thread's opening record was sent by the work team's helper, and the orchestrator then
    // wrote on that thread: the seat's answer is bound to the opening record, not just to the
    // answered one, so this thread is not the main orchestrator's to be answered on.
    plantRecord(world.home, world.roots.work, 'work', 'worker', OPENED, 'helper asked first', {
      at: NOW_ISO,
      from: 'helper',
      thread: OPENED,
    });
    fromMainOrchestrator(SENT_ONE, 'the orchestrator weighs in', OPENED);

    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`the thread ${OPENED} was not opened by the entity's main orchestrator`);
    expect(result.err).toContain(MAIN_ORCHESTRATOR_REPLY_RULE);
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);
  });

  test('is refused on a closed thread, never reopened as a thread of the seat’s own', async () => {
    fromMainOrchestrator(SENT_ONE, 'the question');
    // The addressee closes the thread the orchestrator opened.
    const caller: Caller = { kind: 'seat', name: 'worker', pane: paneOf('work'), session: 'work' };
    const closeIo = testIo(world.roots.work, caller);
    expect(await runReply([SENT_ONE, '--close'], closeIo, host())).toBe(0);
    expect(closeIo.out).toContain(`${SENT_ONE}: closed`);
    // A later word on the same thread: the generic reply rule would open a new thread here; the
    // main-orchestrator answer must not — that would be the seat opening a thread to it.
    fromMainOrchestrator(SENT_TWO, 'a later word', SENT_ONE);

    const result = await answer(SENT_TWO, 'the answer', REPLY_ONE);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`the thread ${SENT_ONE} is already closed`);
    expect(result.err).toContain("a seat answers the entity's main orchestrator only on the open thread that orchestrator opened, and never opens one");
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);
  });

  test('is refused for an id nothing holds, and for a record that does not verify', async () => {
    const missing = await answer('9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a', 'the answer', REPLY_ONE);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('no record named');

    // Bytes changed after signing: the id exists but names a record this build cannot trust.
    const path = fromMainOrchestrator(SENT_ONE, 'the question');
    const sealed = JSON.parse(readFileSync(path, 'utf8')) as { payload: { body: string }; signature: string };
    sealed.payload.body = 'from orchestrator@acme — admitted by: forged\n\nnot what was signed';
    writeFileSync(path, `${JSON.stringify(sealed, null, 2)}\n`);
    const tampered = await answer(SENT_ONE, 'the answer', REPLY_TWO);
    expect(tampered.code).toBe(1);
    expect(tampered.err).toContain(`record ${SENT_ONE} does not verify against this message key`);
    expect(existsSync(inHead(REPLY_TWO))).toBe(false);
  });

  test('is refused for a record addressed to a different seat', async () => {
    // The orchestrator's word waits in the helper's folder, addressed to the helper: this seat
    // cannot answer a record that was not sent to it, whichever folder holds the file.
    plantRecord(world.home, world.roots.work, 'work', 'helper', SENT_ONE, 'for the helper', {
      at: NOW_ISO,
      from: 'orchestrator',
      from_id: world.headOrch,
      thread: SENT_ONE,
    });

    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`record ${SENT_ONE} is addressed to helper, not to worker`);
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);
  });

  test('leaves an ordinary reply on an open thread to the generic rule', async () => {
    // A sender that is not the entity's main orchestrator: the reply is admitted exactly as
    // before, by the record-and-thread rule, and lands in that sender's own folder.
    plantRecord(world.home, world.roots.work, 'work', 'worker', SENT_TWO, 'a local question', {
      at: NOW_ISO,
      from: 'helper',
      thread: SENT_TWO,
    });
    const result = await answer(SENT_TWO, 'a local answer', REPLY_ONE);
    expect(result.code).toBe(0);
    const at = join(recordDir(world.roots.work, 'work', 'helper'), REPLY_ONE);
    expect(existsSync(at)).toBe(true);
    expect(recordAt(at).payload).toMatchObject({ to: 'helper', rule: REPLY_RULE, thread: SENT_TWO });
  });

  test('independent adversarial checks: same-named foreign thread opener, tampered opening record, unsigned record, copied other-seat record, idle-expired thread, and plain send refusal', async () => {
    // 1. Plain `team send` from `worker` to `orchestrator@acme` is refused and writes nothing.
    const caller: Caller = { kind: 'seat', name: 'worker', pane: paneOf('work'), session: 'work' };
    const sendIo = testIo(world.roots.work, caller);
    const sendCode = await runSend(['orchestrator@acme', 'unsolicited message'], sendIo, {
      ...realSendHost,
      home: world.home,
      now: () => NOW,
    });
    expect(sendCode).toBe(1);
    expect(sendIo.err).toContain('no rule admits it');

    // 2. Thread opened by ANOTHER sender also named `orchestrator` (`opening.from === 'orchestrator'`,
    //    `opening.from_id !== world.headOrch`), followed by a message from the entity's main orchestrator
    //    on that same thread: must be refused (`opening.from_id !== answered.from_id`).
    plantRecord(world.home, world.roots.work, 'work', 'worker', OPENED, 'same-named opener', {
      at: NOW_ISO,
      from: 'orchestrator',
      from_id: 'agt_000000099999',
      thread: OPENED,
    });
    fromMainOrchestrator(SENT_ONE, 'main orchestrator follow-up on foreign thread', OPENED);
    const sameNameOpener = await answer(SENT_ONE, 'the answer', REPLY_ONE);
    expect(sameNameOpener.code).toBe(1);
    expect(sameNameOpener.err).toContain(`the thread ${OPENED} was not opened by the entity's main orchestrator`);
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);

    // 3. Multi-message thread where the opening record was forged/tampered after signing:
    //    `findRecord` rejects the tampered opening record (`opening === null`) and refuses.
    const openedPath = fromMainOrchestrator(OPENED, 'authentic opening', OPENED);
    const tamperedOpen = JSON.parse(readFileSync(openedPath, 'utf8')) as { payload: { body: string }; signature?: string };
    tamperedOpen.payload.body = 'tampered opening body';
    writeFileSync(openedPath, `${JSON.stringify(tamperedOpen, null, 2)}\n`);
    const tamperedThread = await answer(SENT_ONE, 'the answer', REPLY_ONE);
    expect(tamperedThread.code).toBe(1);
    expect(tamperedThread.err).toContain(`the thread ${OPENED} was not opened by the entity's main orchestrator`);
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);

    // 4. Answered record with `signature` stripped (unsigned JSON) or `from_id` forged after signing: refused.
    const unsignedPath = fromMainOrchestrator(SENT_TWO, 'unsigned question', SENT_TWO);
    const rawUnsigned = JSON.parse(readFileSync(unsignedPath, 'utf8')) as { payload: Record<string, unknown>; signature?: string };
    delete rawUnsigned.signature;
    writeFileSync(unsignedPath, `${JSON.stringify(rawUnsigned, null, 2)}\n`);
    const unsignedRes = await answer(SENT_TWO, 'the answer', REPLY_ONE);
    expect(unsignedRes.code).toBe(1);
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);

    // 5. Record signed for `helper` (`to: 'helper'`) copied into `worker`'s own drop folder: still refused.
    const helperRecordId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const helperPath = plantRecord(world.home, world.roots.work, 'work', 'helper', helperRecordId, 'for helper only', {
      at: NOW_ISO,
      from: 'orchestrator',
      from_id: world.headOrch,
      thread: helperRecordId,
    });
    const copiedToWorker = join(recordDir(world.roots.work, 'work', 'worker'), helperRecordId);
    writeFileSync(copiedToWorker, readFileSync(helperPath, 'utf8'));
    const wrongRecipient = await answer(helperRecordId, 'the answer', REPLY_ONE);
    expect(wrongRecipient.code).toBe(1);
    expect(wrongRecipient.err).toContain(`record ${helperRecordId} is addressed to helper, not to worker`);
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);

    // 6. Thread ended by the 72h idle threshold is refused and never reopened as a new thread.
    const expiredId = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    const fourDaysAgo = new Date(NOW.getTime() - 96 * 60 * 60 * 1000).toISOString();
    plantRecord(
      world.home,
      world.roots.work,
      'work',
      'worker',
      expiredId,
      `from orchestrator@acme — admitted by: ${MAIN_SEND_RULE}\n\nold question`,
      {
        at: fourDaysAgo,
        from: 'orchestrator',
        from_id: world.headOrch,
        to_id: world.worker,
        rule: MAIN_SEND_RULE,
        thread: expiredId,
      },
    );
    const expiredRes = await answer(expiredId, 'late answer', REPLY_ONE);
    expect(expiredRes.code).toBe(1);
    expect(expiredRes.err).toContain(`the thread ${expiredId} ended: no record on it for 72h`);
    expect(expiredRes.err).toContain("a seat answers the entity's main orchestrator only on the open thread that orchestrator opened, and never opens one");
    expect(existsSync(inHead(REPLY_ONE))).toBe(false);

    // 7. Additional `seats_cross_teams` chain checks: `seat: true` cannot reopen what `team: false`,
    //    `project: false`, or `entity: false` (even after `project: true, team: false`) closed;
    //    and `target === 'owner'` is refused under `main-orchestrator-thread`.
    for (const crossTeams of [
      { team: false, seat: true },
      { project: false, seat: true },
      { entity: false, seat: true },
      { entity: false, project: true, seat: false },
      { entity: false, project: true, team: false, seat: true },
    ] as const) {
      expect({ crossTeams, ok: admitSend(labsBuilder, floorOrch, teams, undefined, marked(crossTeams)).ok }).toEqual({
        crossTeams,
        ok: false,
      });
    }
    expect(admitSend(labsBuilder, 'owner', teams, undefined, marked()).ok).toBe(false);
  });
});
