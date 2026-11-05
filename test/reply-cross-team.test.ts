// `team reply` across teams: the reply lands where the sender's own reader reads it.
//
// A cross-team send is written into the receiving team's transport tree, bound to that team's
// root and session, and it carries the sender's registry id. The sender of such a record reads
// its mail in its own checkout: `team messages` there scans its own root and session, and the
// seat's own inbox server serves the same folder. A reply written into the answering team's tree
// is never read by the sender, whatever the answering command printed. These scenes pin the
// destination, the sender's own read of the reply (both readers), the report that says what
// happened, and the same-team path that must not change.
//
// Two synthetic teams of one entity, in a synthetic home. Both name their coordinator
// `orchestrator`, as real teams do, so a reply routed by seat name alone cannot tell them apart:
// only the registry id the answered record carries can.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../src/caller.ts';
import { plantRecord, recordDir, runMessages } from '../src/commands/messages.ts';
import { landsWhereRead, runReply, type ReplyHost } from '../src/commands/reply.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { findAgent, updateAgent } from '../src/registry/agents.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { updateState } from '../src/state.ts';
import { recordAt, testIo } from './helpers.ts';

const NOW = new Date('2026-10-31T20:00:00.000Z');
const NOW_ISO = NOW.toISOString();

const SENT_ONE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SENT_TWO = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e';
const REPLY_ONE = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const REPLY_TWO = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';

type TeamSpec = { project: string; session: string; seats: string[] };

const TEAMS: Record<string, TeamSpec> = {
  web: { project: 'web', session: 'web', seats: ['orchestrator', 'scribe'] },
  api: { project: 'api', session: 'api', seats: ['orchestrator'] },
};

function teamText(spec: TeamSpec): string {
  const seats = spec.seats
    .map(
      (name) => `  - role: ${name === 'orchestrator' ? 'coordinator' : 'implementer'}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Test
    version: "1"
    launch: claude --model test
${name === 'orchestrator' ? '    leads: true\n' : ''}`,
    )
    .join('');
  return `format: 1
project: ${spec.project}
entity: acme
session: ${spec.session}
coordinator: orchestrator
operator: orchestrator
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

type World = {
  home: string;
  roots: Record<string, string>;
  webAgent: string;
  apiAgent: string;
};

let base: string;
let world: World;

const paneOf = (team: string): string => `pane-${team}`;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reply-cross-team-')));
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  const roots: Record<string, string> = {};
  const files: Record<string, TeamFile> = {};
  for (const [key, spec] of Object.entries(TEAMS)) {
    const root = join(base, key);
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(spec));
    roots[key] = root;
    files[key] = parsed(spec, key);
  }
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  for (const [key, spec] of Object.entries(TEAMS)) {
    for (const seat of spec.seats) {
      if (seat !== 'orchestrator') continue;
      const file = files[key] as TeamFile;
      const one = file.seats.find((candidate) => candidate.name === seat);
      if (!one) throw new Error(`the fixture's own team ${key} has no seat ${seat}`);
      const written = registerLaunch({ home, team: file, root: roots[key] as string, by: 'up' }, one, paneOf(key));
      if ('note' in written) throw new Error(`the fixture's own registration failed: ${written.note}`);
      updateState(join(roots[key] as string, '.agents'), (state) => {
        const session = state.sessions[file.session] ?? { seats: {}, worktrees: {} };
        session.seats[seat] = { stage: 'launched', pane: paneOf(key), workspace: 'main' };
        state.sessions[file.session] = session;
      });
    }
  }
  const webAgent = findAgent(home, { team: teamIdOf(roots.web as string), seat: 'orchestrator' });
  const apiAgent = findAgent(home, { team: teamIdOf(roots.api as string), seat: 'orchestrator' });
  if (webAgent === null || apiAgent === null) throw new Error('the fixture did not register both orchestrators');
  world = { home, roots, webAgent: webAgent.id, apiAgent: apiAgent.id };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The record a cross-team send from web's orchestrator leaves in api's tree: signed, bound to
 *  api's root and session, addressed to api's orchestrator, carrying web's registry id. */
function sentAcross(id: string, text: string): void {
  const header = 'from orchestrator@web — admitted by: an orchestrator to another orchestrator\n';
  plantRecord(world.home, world.roots.api as string, 'api', 'orchestrator', id, `${header}\n${text}`, {
    at: NOW_ISO,
    from: 'orchestrator',
    from_id: world.webAgent,
    to_id: world.apiAgent,
    rule: 'an orchestrator to another orchestrator',
  });
}

function host(patch: Partial<ReplyHost> = {}): ReplyHost {
  return { home: world.home, now: () => NOW, ...patch };
}

/** One reply as api's orchestrator, standing on the pane the state records for it. */
async function answer(id: string, text: string, newId: string): Promise<{ code: number; out: string; err: string }> {
  const caller: Caller = { kind: 'seat', name: 'orchestrator', pane: paneOf('api'), session: 'api' };
  const io = testIo(world.roots.api as string, caller);
  const code = await runReply([id, text], io, host({ newId: () => newId }));
  return { code, out: io.out, err: io.err };
}

/** One `team messages` as web's own checkout runs it: its root, its session, and the seat whose
 *  mailbox the reply landed in — the reply serves only the mailbox it is addressed to. */
async function readAtWeb(
  caller: Caller = { kind: 'seat', name: 'orchestrator', pane: paneOf('web'), session: 'web' },
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(world.roots.web as string, caller);
  const code = await runMessages([], io, { home: world.home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

describe('a cross-team reply', () => {
  test("lands in the sender's own tree, where the sender's team messages reads it", async () => {
    sentAcross(SENT_ONE, 'the question');
    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);

    expect(result.code).toBe(0);
    const atSender = join(recordDir(world.roots.web as string, 'web', 'orchestrator'), REPLY_ONE);
    expect(existsSync(atSender)).toBe(true);
    // The answering team's own seat folder must not hold it: its reader is not the sender's.
    expect(existsSync(join(recordDir(world.roots.api as string, 'api', 'orchestrator'), REPLY_ONE))).toBe(false);

    const record = recordAt(atSender);
    expect(record.payload).toMatchObject({
      to: 'orchestrator',
      to_id: world.webAgent,
      root: world.roots.web as string,
      session: 'web',
      from: 'orchestrator',
      from_id: world.apiAgent,
      thread: SENT_ONE,
      in_reply_to: SENT_ONE,
    });

    const read = await readAtWeb();
    expect(read.code).toBe(0);
    expect(read.out).toContain('the answer');
  });

  test('is served by the sender seat\'s inbox_read', async () => {
    sentAcross(SENT_TWO, 'the second question');
    const result = await answer(SENT_TWO, 'the second answer', REPLY_TWO);
    expect(result.code).toBe(0);

    const served = readMessage(
      {
        dropDir: recordDir(world.roots.web as string, 'web', 'orchestrator'),
        root: world.roots.web as string,
        seat: 'orchestrator',
        session: 'web',
      },
      REPLY_TWO,
      world.home,
    );
    if (!served.ok) throw new Error(`inbox_read refused the reply: ${served.reason}`);
    expect(served.body).toContain('the second answer');
  });

  test("reaches the seat's live holder when the carried id no longer holds it", async () => {
    sentAcross(SENT_ONE, 'the question');
    // The sending seat is re-created after the record was written: the record carries the old id,
    // and the same team and seat are held by a new one.
    updateAgent(world.home, world.webAgent, { lifecycle: 'retired' });
    const file = parsed(TEAMS.web as TeamSpec, 'web');
    const seat = file.seats.find((candidate) => candidate.name === 'orchestrator');
    if (!seat) throw new Error('the fixture has no orchestrator seat');
    const again = registerLaunch({ home: world.home, team: file, root: world.roots.web as string, by: 'up' }, seat, paneOf('web'));
    if ('note' in again) throw new Error(`the fixture's own re-registration failed: ${again.note}`);
    expect(again.id).not.toBe(world.webAgent);

    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);
    expect(result.code).toBe(0);
    expect(result.out).toContain('orchestrator: delivered (drop)');
    const record = recordAt(join(recordDir(world.roots.web as string, 'web', 'orchestrator'), REPLY_ONE));
    expect(record.payload).toMatchObject({ to: 'orchestrator', to_id: again.id, session: 'web' });
  });

  test("follows the sender's live session when its file moved on", async () => {
    sentAcross(SENT_ONE, 'the question');
    // The sender's team file moves its session without a registry refresh. The sender's own
    // `team messages` reads the live file, so its session is where the reply has to land: a write
    // under the registry's old session would be a reply its reader never sees, reported as if it
    // had been read.
    writeFileSync(join(world.roots.web as string, '.agents', 'team.yaml'), teamText({ ...(TEAMS.web as TeamSpec), session: 'web-next' }));
    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);

    expect(result.code).toBe(0);
    expect(result.out).toContain('orchestrator: delivered (drop)');
    const atLive = join(recordDir(world.roots.web as string, 'web-next', 'orchestrator'), REPLY_ONE);
    expect(existsSync(atLive)).toBe(true);
    expect(existsSync(join(recordDir(world.roots.web as string, 'web', 'orchestrator'), REPLY_ONE))).toBe(false);
    expect(recordAt(atLive).payload).toMatchObject({
      to: 'orchestrator',
      to_id: world.webAgent,
      root: world.roots.web as string,
      session: 'web-next',
    });

    // The sender's reader, reading its live file, has the answer.
    const read = await readAtWeb();
    expect(read.code).toBe(0);
    expect(read.out).toContain('the answer');
  });

  test('reports delivered only when the record is in the sender\'s reader folder', async () => {
    sentAcross(SENT_ONE, 'the question');
    const result = await answer(SENT_ONE, 'the answer', REPLY_ONE);

    expect(result.code).toBe(0);
    expect(result.out).toContain('orchestrator: delivered');
    const atSender = join(recordDir(world.roots.web as string, 'web', 'orchestrator'), REPLY_ONE);
    expect(existsSync(atSender)).toBe(true);
  });
});

describe('the confirmation the report stands on', () => {
  test("accepts the record at the reader's own folder, and only there", () => {
    const root = world.roots.web as string;
    const folder = recordDir(root, 'web', 'orchestrator');
    plantRecord(world.home, root, 'web', 'orchestrator', SENT_ONE, 'a record');

    expect(landsWhereRead(world.home, folder, SENT_ONE, root, 'web', 'orchestrator')).toBe(true);
    // Each of the reader's checks, one at a time: session, seat, root.
    expect(landsWhereRead(world.home, folder, SENT_ONE, root, 'other', 'orchestrator')).toBe(false);
    expect(landsWhereRead(world.home, folder, SENT_ONE, root, 'web', 'scribe')).toBe(false);
    expect(landsWhereRead(world.home, folder, SENT_ONE, world.roots.api as string, 'web', 'orchestrator')).toBe(false);
  });
});

describe('a same-team reply', () => {
  test('still lands in the sender\'s own folder here, and its reader reads it', async () => {
    const header = 'from the file\'s seat scribe — admitted by: an orchestrator or operator to a seat of its own team\n';
    plantRecord(world.home, world.roots.web as string, 'web', 'orchestrator', SENT_TWO, `${header}\nlocal question`, {
      at: NOW_ISO,
      from: 'scribe',
      to_id: world.webAgent,
      rule: 'an orchestrator or operator to a seat of its own team',
    });
    const caller: Caller = { kind: 'seat', name: 'orchestrator', pane: paneOf('web'), session: 'web' };
    const io = testIo(world.roots.web as string, caller);
    const code = await runReply([SENT_TWO, 'local answer'], io, host({ newId: () => REPLY_TWO }));

    expect(code).toBe(0);
    expect(io.out).toContain('scribe: delivered');
    const at = join(recordDir(world.roots.web as string, 'web', 'scribe'), REPLY_TWO);
    expect(existsSync(at)).toBe(true);
    expect(recordAt(at).payload).toMatchObject({ to: 'scribe', root: world.roots.web as string, session: 'web', thread: SENT_TWO });

    const read = await readAtWeb({ kind: 'seat', name: 'scribe', pane: 'pane-web-scribe', session: 'web' });
    expect(read.code).toBe(0);
    expect(read.out).toContain('local answer');
  });
});
