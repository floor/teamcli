// `team brief rollout`: the plan and the delivery of this build's general seat brief to the
// seats a launch is not about to deliver it to itself. The dry run writes nothing at all; the
// `--apply` run is the one delivery boundary every launch calls; a name held by a file that is
// not this brief's, a link or a folder is recovered at the claim's next attempt while the held
// name is left exactly as it was found. Current is the delivery's currency, never the seat's
// read: the rollout writes no receipt.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { USAGE, runBrief } from '../../src/commands/brief.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import {
  GENERAL_BRIEF_SHA256,
  MEMORY_TRANSPORT_UNSUPPORTED,
  currentBriefClaim,
  generalBriefBody,
  generalBriefId,
  type CurrentBriefClaim,
} from '../../src/launch/general-brief.ts';
import type { InboxListener } from '../../src/mcp/inbox.ts';
import { writePolicySet } from '../../src/policy/sources.ts';
import { receiptFile } from '../../src/send/record.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import type { BuildIdentity } from '../../src/version.ts';
import { deliverBriefs, recordAt, testIo } from '../helpers.ts';

const NOW = new Date('2026-10-19T09:00:00Z');
const NOW_ISO = NOW.toISOString();

const TEXT = `format: 1
project: acme
coordinator: lead
operator: desk
session: acme
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
  - role: implementer
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: operator
    name: desk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    human: true
`;

const loaded = validateTeamFile(TEXT);
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));

const INC = 'inc_0123456789ab';
const INC_WORKER = 'inc_ba9876543210';
const EPOCH = 'run_0123456789ab';
const BODY = generalBriefBody();
/** The record ids the fixture's fixed lifetimes have: the canonical text, attempts 0 and 1. */
const ID0 = generalBriefId(INC, BODY);
const ID1 = generalBriefId(INC, BODY, 1);
const ID_WORKER = generalBriefId(INC_WORKER, BODY);
const H12 = GENERAL_BRIEF_SHA256.slice(0, 12);
const OLD_SHA = 'e'.repeat(64);

const PANE: Record<string, string> = { lead: 'w1:p1', worker: 'w1:p2', helper: 'w1:p3' };

const NOT_RUNNING_WORKER = 'not running worker: delivered at its next launch\n';
const NOT_RUNNING_HELPER = 'not running helper: delivered at its next launch\n';
const HUMAN_DESK = 'human desk: delivery only\n';

let base: string;
let root: string;
let dir: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-brief-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  mkdirSync(dir, { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(dir, 'team.yaml'), TEXT);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function dropDir(seat: string): string {
  return join(dir, 'send-drops', 'acme', seat);
}

/** The state records this seat as running, with the pane the caller gate then places it on. */
function remember(name: string): void {
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats = { ...(session.seats ?? {}), [name]: { stage: 'ready' as const, pane: PANE[name] ?? 'w1:p1' } };
  });
}

/**
 * A claim written the way a launch writes it, before any file: an id derived from a fixed
 * lifetime, so a scene that plants a name at the planned id knows it in advance. The default is
 * this build's claim with no record written; `sha256` and `id` carry an earlier brief's.
 */
function seedClaim(
  seat: string,
  input: { incarnation?: string; sha256?: string; id?: string } = {},
): CurrentBriefClaim {
  const incarnation = input.incarnation ?? INC;
  const sha256 = input.sha256 ?? GENERAL_BRIEF_SHA256;
  const id = input.id ?? generalBriefId(incarnation, BODY);
  updateState(dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats = { ...(session.seats ?? {}), [seat]: { stage: 'ready' as const, pane: PANE[seat] ?? 'w1:p1' } };
    session.briefs = {
      ...(session.briefs ?? {}),
      [seat]: { id, at: NOW_ISO, incarnation, epoch: EPOCH, sha256, attempt: 0, stage: 'ready' as const },
    };
  });
  return {
    id,
    at: NOW_ISO,
    incarnation,
    epoch: EPOCH,
    sha256,
    attempt: 0,
    stage: 'ready',
    superseded: [],
  };
}

/** The seat's current claim, as the rollout and the check resolve it. */
function claimOf(seat: string): CurrentBriefClaim | null {
  return currentBriefClaim(readState(dir).sessions.acme?.briefs?.[seat]);
}

/** A settled seat through the one delivery boundary a launch calls, read like a first turn. */
function settle(seats: readonly string[]): void {
  deliverBriefs({ dir, root, session: 'acme', seats, home, at: NOW_ISO });
}

/** Every byte the rollout must never write without `--apply`: the state and the drop folders. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (folder: string, prefix: string): void => {
    for (const name of readdirSync(folder).sort()) {
      const at = join(folder, name);
      const key = prefix === '' ? name : `${prefix}/${name}`;
      const info = statSync(at);
      if (info.isDirectory()) {
        out[`${key}/`] = '';
        walk(at, key);
      } else if (info.isFile()) {
        out[key] = readFileSync(at, 'utf8');
      } else {
        out[key] = '<other>';
      }
    }
  };
  walk(dir, '');
  return out;
}

async function runRollout(
  argv: string[],
  options: { caller?: Caller; cwd?: string; build?: BuildIdentity } = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(options.cwd ?? root, options.caller ?? { kind: 'owner' });
  const code = await runBrief(argv, io, {
    home,
    now: () => NOW,
    ...(options.build === undefined ? {} : { build: () => options.build as BuildIdentity }),
  });
  return { code, out: io.out, err: io.err };
}

/** The build the runs compare a listener marker against, unless a test pins another. */
const BUILD: BuildIdentity = { version: '0.5.3-hotfix.1', build: '0123456789abcdef', builtAt: Date.parse(NOW_ISO), head: null };

/** A live listener marker in the seat's inbox, as a server leaves it. */
function listener(seat: string, over: Partial<InboxListener> = {}): void {
  const folder = dropDir(seat);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.inbox-listener'), `${JSON.stringify({
    v: 1,
    seat,
    session: 'acme',
    root,
    cli: 'claude-code',
    pid: process.pid,
    ts: NOW_ISO,
    version: BUILD.version,
    build: BUILD.build,
    ...over,
  })}\n`);
}

describe('the rollout plan', () => {
  test('a settled team plans as current and writes nothing', async () => {
    remember('lead');
    remember('worker');
    settle(['lead', 'worker', 'desk']);
    const lead = claimOf('lead');
    const worker = claimOf('worker');
    if (lead === null || worker === null) throw new Error('the fixture delivered no claim');
    const before = snapshot();

    const run = await runRollout(['rollout']);

    expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: '' });
    expect(run.out).toBe(
      `brief lead: current ${H12} ${lead.id}\n`
      + `brief worker: current ${H12} ${worker.id}\n`
      + NOT_RUNNING_HELPER
      + HUMAN_DESK,
    );
    expect(snapshot()).toEqual(before);
  });

  test('--json carries one row per seat and the counts, without writing', async () => {
    remember('lead');
    remember('worker');
    settle(['lead', 'worker', 'desk']);
    const lead = claimOf('lead');
    const worker = claimOf('worker');
    const desk = claimOf('desk');
    if (lead === null || worker === null || desk === null) throw new Error('the fixture delivered no claim');
    const before = snapshot();

    const run = await runRollout(['rollout', '--json']);

    expect(run.code).toBe(0);
    expect(run.err).toBe('');
    expect(JSON.parse(run.out)).toEqual({
      schema: { name: 'team.brief', version: 1 },
      format: 1,
      project: 'acme',
      session: 'acme',
      apply: false,
      seats: [
        { seat: 'lead', action: 'current', hash12: H12, id: lead.id, from: null, reason: null, current: true },
        { seat: 'worker', action: 'current', hash12: H12, id: worker.id, from: null, reason: null, current: true },
        { seat: 'helper', action: 'not-running', hash12: null, id: null, from: null, reason: null, current: false },
        { seat: 'desk', action: 'human', hash12: H12, id: desk.id, from: null, reason: null, current: true },
      ],
      counts: { current: 2, deliver: 0, recover: 0, not_running: 1, human: 1, stale_listener: 0, failed: 0 },
    });
    expect(snapshot()).toEqual(before);
  });

  test('an earlier brief is planned for delivery at the id the run will write, and the dry run writes nothing', async () => {
    const old = seedClaim('lead', { sha256: OLD_SHA, id: generalBriefId(INC, 'an earlier brief\n') });
    settle(['desk']);
    const before = snapshot();
    const deliverLine = `deliver lead: ${H12} -> ${ID0}\n`;

    const dry = await runRollout(['rollout']);
    expect(dry.code).toBe(1);
    expect(dry.err).toBe('');
    expect(dry.out).toBe(deliverLine + NOT_RUNNING_WORKER + NOT_RUNNING_HELPER + HUMAN_DESK);
    expect(snapshot()).toEqual(before);

    const applied = await runRollout(['rollout', '--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toBe(deliverLine + NOT_RUNNING_WORKER + NOT_RUNNING_HELPER + HUMAN_DESK);
    const claim = claimOf('lead');
    expect(claim).toMatchObject({ id: ID0, sha256: GENERAL_BRIEF_SHA256, attempt: 0, stage: 'ready' });
    expect(claim?.superseded).toEqual([old.id]);
    expect(recordAt(join(dropDir('lead'), ID0)).payload.id).toBe(ID0);

    const again = await runRollout(['rollout']);
    expect(again.code).toBe(0);
    expect(again.out).toBe(
      `brief lead: current ${H12} ${ID0}\n` + NOT_RUNNING_WORKER + NOT_RUNNING_HELPER + HUMAN_DESK,
    );
  });
});

describe('the delivery', () => {
  test('--apply delivers two live seats at once, leaves the down seat for its launch, and reads nothing', async () => {
    seedClaim('lead', { incarnation: INC, sha256: OLD_SHA, id: generalBriefId(INC, 'an earlier brief\n') });
    seedClaim('worker', { incarnation: INC_WORKER, sha256: OLD_SHA, id: generalBriefId(INC_WORKER, 'an earlier brief\n') });
    settle(['desk']);
    const before = snapshot();
    const deliverLines = `deliver lead: ${H12} -> ${ID0}\n` + `deliver worker: ${H12} -> ${ID_WORKER}\n`;

    const dry = await runRollout(['rollout']);
    expect(dry.code).toBe(1);
    expect(dry.out).toBe(deliverLines + NOT_RUNNING_HELPER + HUMAN_DESK);
    expect(snapshot()).toEqual(before);

    const applied = await runRollout(['rollout', '--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toBe(deliverLines + NOT_RUNNING_HELPER + HUMAN_DESK);
    for (const [seat, id] of [['lead', ID0], ['worker', ID_WORKER]] as const) {
      expect(claimOf(seat)).toMatchObject({ id, sha256: GENERAL_BRIEF_SHA256, stage: 'ready' });
      expect(recordAt(join(dropDir(seat), id)).payload.id).toBe(id);
      // The rollout delivers; reading is the seat's own turn. Current never means read.
      expect(existsSync(receiptFile(dropDir(seat), id, 'read'))).toBe(false);
    }

    // A second --apply changes nothing: the same claims, the same records, the same state bytes.
    const stateAfterFirst = readFileSync(join(dir, 'team.state.json'), 'utf8');
    const rerun = await runRollout(['rollout', '--apply']);
    expect(rerun.code).toBe(0);
    expect(rerun.out).toBe(
      `brief lead: current ${H12} ${ID0}\n`
      + `brief worker: current ${H12} ${ID_WORKER}\n`
      + NOT_RUNNING_HELPER
      + HUMAN_DESK,
    );
    expect(readFileSync(join(dir, 'team.state.json'), 'utf8')).toBe(stateAfterFirst);
  });

  test('a name held by a file that is not the brief\'s is recovered at the next attempt, the file untouched', async () => {
    seedClaim('lead');
    mkdirSync(dropDir('lead'), { recursive: true });
    writeFileSync(join(dropDir('lead'), ID0), 'not this brief\n');
    settle(['desk']);
    const before = snapshot();
    const wouldLine = `recover lead: the name at ${ID0} is not this brief's; would deliver at ${ID1}\n`;
    const doneLine = `recovered lead: the name at ${ID0} is not this brief's; delivered at ${ID1}\n`;

    const dry = await runRollout(['rollout']);
    expect(dry.code).toBe(1);
    expect(dry.out).toBe(wouldLine + NOT_RUNNING_WORKER + NOT_RUNNING_HELPER + HUMAN_DESK);
    expect(snapshot()).toEqual(before);

    const applied = await runRollout(['rollout', '--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toBe(doneLine + NOT_RUNNING_WORKER + NOT_RUNNING_HELPER + HUMAN_DESK);
    expect(readFileSync(join(dropDir('lead'), ID0), 'utf8')).toBe('not this brief\n');
    const claim = claimOf('lead');
    expect(claim).toMatchObject({ id: ID1, attempt: 1 });
    expect(claim?.superseded).toEqual([ID0]);
    expect(recordAt(join(dropDir('lead'), ID1)).payload.id).toBe(ID1);

    const again = await runRollout(['rollout']);
    expect(again.code).toBe(0);
    expect(again.out).toBe(
      `brief lead: current ${H12} ${ID1}\n` + NOT_RUNNING_WORKER + NOT_RUNNING_HELPER + HUMAN_DESK,
    );
  });

  test('a name held by a link is recovered too, and the link still points where it did', async () => {
    seedClaim('lead');
    mkdirSync(dropDir('lead'), { recursive: true });
    const target = join(base, 'not-a-record.txt');
    writeFileSync(target, 'the link target\n');
    symlinkSync(target, join(dropDir('lead'), ID0));

    const dry = await runRollout(['rollout']);
    expect(dry.code).toBe(1);
    expect(dry.out).toBe(
      `recover lead: the name at ${ID0} is not this brief's; would deliver at ${ID1}\n`
      + NOT_RUNNING_WORKER
      + NOT_RUNNING_HELPER
      + HUMAN_DESK,
    );
    expect(readFileSync(join(dropDir('lead'), ID0), 'utf8')).toBe('the link target\n');
  });

  test('a seat whose record cannot be written fails alone, and the next --apply retries only it', async () => {
    remember('lead');
    remember('worker');
    settle(['lead', 'desk']);
    const leadId = claimOf('lead')?.id;
    if (leadId === undefined) throw new Error('the fixture delivered no lead claim');
    // A regular file where worker's drop folder must be: the claim is written, the record is not.
    mkdirSync(join(dir, 'send-drops', 'acme'), { recursive: true });
    const blocker = join(dir, 'send-drops', 'acme', 'worker');
    writeFileSync(blocker, 'not a folder\n');

    const failed = await runRollout(['rollout', '--apply']);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe(
      `brief lead: current ${H12} ${leadId}\n`
      + 'failed worker: the record could not be written\n'
      + NOT_RUNNING_HELPER
      + HUMAN_DESK,
    );
    const claimed = claimOf('worker');
    if (claimed === null) throw new Error('the failed run recorded no claim');
    expect(existsSync(join(dropDir('worker'), claimed.id))).toBe(false);

    unlinkSync(blocker);
    const retried = await runRollout(['rollout', '--apply']);
    expect(retried.code).toBe(0);
    expect(retried.out).toBe(
      `brief lead: current ${H12} ${leadId}\n`
      + `deliver worker: ${H12} -> ${claimed.id}\n`
      + NOT_RUNNING_HELPER
      + HUMAN_DESK,
    );
    // The retried run kept the seat's lifetime and left the settled seat's claim where it was.
    expect(claimOf('worker')).toMatchObject({ id: claimed.id, attempt: 0, stage: 'ready' });
    expect(claimOf('lead')?.id).toBe(leadId);
    expect(recordAt(join(dropDir('worker'), claimed.id)).payload.id).toBe(claimed.id);
  });

  test('brief-transport memory refuses every seat: every row fails and no byte is written', async () => {
    remember('lead');
    settle(['lead']);
    const wrote = writePolicySet(
      home,
      { level: 'team', target: root, teamRoot: root, name: 'brief-transport', value: 'memory' },
      { now: NOW },
    );
    expect(wrote.ok).toBe(true);
    // The policy write is the change; from here the rollout must add not one byte to the tree.
    const before = snapshot();

    const run = await runRollout(['rollout', '--apply']);

    expect(run.code).toBe(1);
    expect(run.out).toBe(
      `failed lead: ${MEMORY_TRANSPORT_UNSUPPORTED}\n`
      + `failed worker: ${MEMORY_TRANSPORT_UNSUPPORTED}\n`
      + `failed helper: ${MEMORY_TRANSPORT_UNSUPPORTED}\n`
      + `failed desk: ${MEMORY_TRANSPORT_UNSUPPORTED}\n`,
    );
    expect(snapshot()).toEqual(before);
  });
});

describe('the invocation and the team file', () => {
  test('the invocation is one verb, read before anything else', async () => {
    const noVerb = await runRollout([]);
    expect({ code: noVerb.code, out: noVerb.out, err: noVerb.err }).toEqual({
      code: 2,
      out: '',
      err: `team brief: a subcommand is required: rollout\n${USAGE}`,
    });

    const unknown = await runRollout(['deploy']);
    expect({ code: unknown.code, out: unknown.out, err: unknown.err }).toEqual({
      code: 2,
      out: '',
      err: `team brief: unexpected "deploy"\n${USAGE}`,
    });

    const extra = await runRollout(['rollout', 'now']);
    expect({ code: extra.code, out: extra.out, err: extra.err }).toEqual({
      code: 2,
      out: '',
      err: `team brief: unexpected "now"\n${USAGE}`,
    });

    const flag = await runRollout(['--rollout']);
    expect({ code: flag.code, out: flag.out, err: flag.err }).toEqual({
      code: 2,
      out: '',
      err: `team brief: unknown option --rollout\n${USAGE}`,
    });

    const json = await runRollout(['rollout', '--json', 'again']);
    expect({ code: json.code, err: json.err }).toEqual({ code: 2, err: '' });
    expect(JSON.parse(json.out)).toMatchObject({
      schema: { name: 'team.error', version: 1 },
      error: { id: 'brief.invocation', message: 'unexpected "again"' },
    });
  });

  test('a team file that can\'t be read or parsed is brief.file or brief.file-invalid', async () => {
    const empty = join(base, 'empty');
    mkdirSync(empty);
    execFileSync('git', ['init', '-q'], { cwd: empty, stdio: 'ignore' });
    const missing = await runRollout(['rollout', '--json'], { cwd: empty });
    expect({ code: missing.code, err: missing.err }).toEqual({ code: 2, err: '' });
    expect(JSON.parse(missing.out)).toMatchObject({
      schema: { name: 'team.error', version: 1 },
      error: { id: 'brief.file' },
    });

    const broken = join(base, 'broken');
    mkdirSync(join(broken, '.agents'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: broken, stdio: 'ignore' });
    writeFileSync(join(broken, '.agents', 'team.yaml'), 'format: 1\nproject: [unclosed\n');
    const invalid = await runRollout(['rollout', '--json'], { cwd: broken });
    expect({ code: invalid.code, err: invalid.err }).toEqual({ code: 2, err: '' });
    expect(JSON.parse(invalid.out)).toMatchObject({
      schema: { name: 'team.error', version: 1 },
      error: { id: 'brief.file-invalid' },
    });

    // The plain refusal carries the command's prefix, never the JSON envelope.
    const plain = await runRollout(['rollout'], { cwd: broken });
    expect(plain.code).toBe(2);
    expect(plain.out).toBe('');
    expect(plain.err.startsWith('team brief: ')).toBe(true);
  });

  test('a seat reads the plan, and only the owner aims --file or --session', async () => {
    seedClaim('worker', { incarnation: INC_WORKER });
    const worker: Caller = { kind: 'seat', name: 'worker', pane: PANE.worker as string, session: 'acme' };

    const ownerRun = await runRollout(['rollout']);
    expect(ownerRun.code).toBe(1);
    const seatRun = await runRollout(['rollout'], { caller: worker });
    expect({ code: seatRun.code, out: seatRun.out, err: seatRun.err }).toEqual({
      code: ownerRun.code,
      out: ownerRun.out,
      err: ownerRun.err,
    });

    const before = snapshot();
    const file = await runRollout(['rollout', '--file', join(base, 'other.yaml')], { caller: worker });
    expect({ code: file.code, out: file.out, err: file.err }).toEqual({
      code: 1,
      out: '',
      err: 'team brief: --file is the owner\'s, from a terminal outside herdr; this call is worker\n',
    });
    expect(snapshot()).toEqual(before);

    const session = await runRollout(['rollout', '--session', 'other'], { caller: worker });
    expect({ code: session.code, out: session.out, err: session.err }).toEqual({
      code: 1,
      out: '',
      err: 'team brief: --session is the owner\'s, from a terminal outside herdr; this call is worker\n',
    });
    expect(snapshot()).toEqual(before);

    // A caller the gate does not place on a recorded pane learns nothing of the team.
    const stranger = await runRollout(['rollout'], {
      caller: { kind: 'seat', name: 'helper', pane: 'w9:p9', session: 'acme' },
    });
    expect({ code: stranger.code, out: stranger.out, err: stranger.err }).toEqual({
      code: 2,
      out: '',
      err: 'team brief: this team is not yours to read\n',
    });
  });
});

describe('a live listener from another build', () => {
  test('the plan names the stale runtime, and --apply writes nothing to that seat', async () => {
    remember('lead');
    listener('lead', { version: '0.5.3', build: 'ffffffffffffffff' });
    const before = snapshot();

    const dry = await runRollout(['rollout', '--seat', 'lead'], { build: BUILD });
    expect(dry.code).toBe(1);
    expect(dry.err).toBe('');
    expect(dry.out).toBe(
      "stale lead: the inbox listener runs 0.5.3, this build is 0.5.3-hotfix.1; "
      + "restart the seat's CLI host so its MCP server reloads this build\n",
    );
    expect(snapshot()).toEqual(before);

    const applied = await runRollout(['rollout', '--seat', 'lead', '--apply'], { build: BUILD });
    expect(applied.code).toBe(1);
    expect(applied.out).toBe(dry.out);
    expect(snapshot()).toEqual(before);
    expect(claimOf('lead')).toBeNull();
  });

  test('a marker that records no build identity is stale, and one from this build is not', async () => {
    remember('lead');
    listener('lead', { version: undefined, build: undefined });
    const legacy = await runRollout(['rollout', '--seat', 'lead'], {
      build: { ...BUILD, builtAt: Date.parse(NOW_ISO) + 1_000 },
    });
    expect(legacy.code).toBe(1);
    expect(legacy.out).toContain('started before this build (0.5.3-hotfix.1) was installed');
    expect(legacy.out).toContain("restart the seat's CLI host");

    // The same marker compared without a recorded install time says only that it cannot vouch
    // for the runtime: no ordering is invented from the pid.
    const unknown = await runRollout(['rollout', '--seat', 'lead'], { build: { ...BUILD, builtAt: 0 } });
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('records no build identity');
    expect(unknown.out).not.toContain('started before');

    // A listener that names this build is a live inbox: the plan delivers as usual.
    listener('lead');
    const current = await runRollout(['rollout', '--seat', 'lead'], { build: BUILD });
    expect(current.code).toBe(1);
    expect(current.out.startsWith('deliver lead: ')).toBe(true);
    const applied = await runRollout(['rollout', '--seat', 'lead', '--apply'], { build: BUILD });
    expect(applied.code).toBe(0);
    expect(claimOf('lead')?.sha256).toBe(GENERAL_BRIEF_SHA256);
  });

  test('--seat plans and delivers one seat, and an undeclared seat is an invocation error', async () => {
    remember('lead');
    remember('worker');
    settle(['lead']);
    const lead = claimOf('lead');
    if (lead === null) throw new Error('the fixture delivered no claim');

    const dry = await runRollout(['rollout', '--seat', 'worker']);
    expect(dry.code).toBe(1);
    expect(dry.out.startsWith('deliver worker: ')).toBe(true);
    expect(dry.out).not.toContain('lead');
    expect(dry.out).not.toContain('helper');
    expect(dry.out).not.toContain('desk');

    const applied = await runRollout(['rollout', '--seat', 'worker', '--apply']);
    expect(applied.code).toBe(0);
    expect(claimOf('worker')?.sha256).toBe(GENERAL_BRIEF_SHA256);
    // The seat outside the target kept the claim and the record it stood on.
    expect(claimOf('lead')?.id).toBe(lead.id);

    const nobody = await runRollout(['rollout', '--seat', 'nobody']);
    expect({ code: nobody.code, out: nobody.out, err: nobody.err }).toEqual({
      code: 2,
      out: '',
      err: `team brief: the team file declares no seat "nobody"\n${USAGE}`,
    });
  });
});
