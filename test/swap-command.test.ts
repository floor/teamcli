// `team swap` at its edges: the rule's own proposal, an aimed target, the queue record in the
// state, the owner's force, the cancel, and the wait the resolved policy chain gives it
// (Policies rules 10 and 11).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { type Caller } from '../src/caller.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { DownLaunch } from '../src/commands/down.ts';
import { runSwap, type SwapCommandOptions } from '../src/commands/swap.ts';
import type { Launch } from '../src/commands/up.ts';
import type { RestartSources } from '../src/commands/restart.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { SWAP_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { writePolicySet } from '../src/policy/index.ts';
import { beginSession } from '../src/sessions/registry.ts';
import { readState } from '../src/state.ts';
import type { Screen } from '../src/watch/screen.ts';
import { CLAUDE_IDLE, claudeBox, testIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';

// The other CLI's own idle screen, its footer naming the model this scene's recipe declares, so
// a relaunch on it is read as ready the way codex writes it and the read-back reads that model.
const CODEX_IDLE = readFileSync(new URL('./fixtures/codex/0.161.0/idle.txt', import.meta.url), 'utf8')
  .replace('gpt-5.6-terra', 'gpt-5.0-sol')
  .replace('GPT-5.6-Terra', 'GPT-5.0-Sol');

const TEAM = `format: 1
project: acme
session: acme
entity: lab
operator: lead
workspace:
  mode: shared
seats:
  - role: project coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: worker
    cli: claude-code
    vendor: deepseek
    model: DeepSeek Flash
    version: "4.0"
    launch: claude --model deepseek-flash
  - role: reviewer
    name: helper
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "5.0"
    launch: codex --model gpt-sol
`;

const NOW = new Date('2026-10-19T09:00:00Z');
const OWNER: Caller = { kind: 'owner' };

const files: string[] = [];
let root = '';
let home = '';

function place(): void {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-swap-')));
  files.push(base);
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  // A migrated trust block: a swap's run is a restart, and a restart preflights the file a seat
  // would start from. The lobby is the entity's, and the project root is trusted for the seats.
  const yaml = TEAM.replace('workspace:\n', `trust:\n  - ~/.config/team/lobbies/lab\n  - ${root}\nworkspace:\n`);
  writeFileSync(join(root, '.agents', 'team.yaml'), yaml);
}

afterEach(() => {
  for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setRule(value: string): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'lab', name: 'model-rule', value }, { now: NOW });
  if (!wrote.ok) throw new Error(wrote.why);
}

const SEAT_ID = 'seat_0123456789ab';
const BINDING = 'prs_0123456789ab';
/** The run reads the store itself, so a scene that exercises the hold writes the daemon's own
 *  projection shape and the seat record that fences it: identity, binding, the canonical fence
 *  at the projection's exact seq and instant, and the persisted activity stamp. */
function writePresence(state: 'working' | 'idle'): void {
  const since = '2026-10-19T08:50:00.000Z';
  const observedAt = '2026-10-19T08:51:00.000Z';
  const seatDir = join(root, '.agents', 'presence', 'acme', 'lead');
  mkdirSync(seatDir, { recursive: true });
  writeFileSync(join(seatDir, 'current.json'), `${JSON.stringify({
    v: 1,
    seq: 7,
    id: `${since}-a1b2c3d4`,
    state,
    source: 'runtime-hook',
    event: state === 'working' ? 'turn-start' : 'turn-end',
    binding: BINDING,
    since,
    observedAt,
  })}\n`);
  const stateDir = join(root, '.agents');
  const stored = readState(stateDir);
  const session = stored.sessions.acme ?? { seats: {}, worktrees: {} };
  session.seats.lead = {
    ...(session.seats.lead ?? {}),
    stage: 'ready',
    id: SEAT_ID,
    presence_binding: BINDING,
    presence_applied: { seat_id: SEAT_ID, binding: BINDING, seq: 7, applied_at: observedAt },
    last_active: since,
  };
  writeFileSync(
    join(stateDir, 'team.state.json'),
    `${JSON.stringify({ ...stored, format: 1, sessions: { ...stored.sessions, acme: session } })}\n`,
  );
}

async function swap(
  argv: string[],
  caller: Caller = OWNER,
  options: Partial<SwapCommandOptions> = {},
): Promise<{ code: number; out: string; err: string }> {
  const io = testIo(root, caller);
  const code = await runSwap(argv, io, { home, now: () => NOW, ...options });
  return { code, out: io.out, err: io.err };
}

const queue = () => readState(join(root, '.agents')).swaps ?? {};

type FakeHerdr = {
  sources: RestartSources;
  did: { typed: string[]; closed: string[]; runs: string[] };
};

/**
 * The live world a run reads, for these scenes: one seat answering for `lead` on `pane-old`, a
 * launch that makes `pane-new-1` (its text is the captured idle screen, so the read-back is
 * unread), and a clock that advances when the run sleeps — the handover wait and the ready wait
 * end in fake time, never in the wall clock. `unreadable` is herdr failing to answer at all.
 * `screen` is the old pane's screen kind; a new pane is idle. `slowHandover` makes the old
 * conversation's handover turn still read `working` after its file lands, until the next sleep.
 */
function fakeHerdr(
  opts: {
    status?: string;
    screen?: 'idle' | 'working' | 'unsent' | 'provider error' | 'rate limit';
    unreadable?: boolean;
    newScreen?: string;
    slowHandover?: boolean;
    /** False for a conversation that never writes the handover its request named. */
    handoverWritten?: boolean;
  } = {},
): FakeHerdr {
  const did = { typed: [] as string[], closed: [] as string[], runs: [] as string[] };
  let clock = NOW.getTime();
  const now = (): Date => new Date(clock);
  // A handover turn that is still finishing when its file lands: the old pane reads `working`
  // until the next sleep, as a conversation finishing its final response does.
  let handoverTurn = false;
  const sleep = async (ms: number): Promise<void> => {
    clock += ms;
    if (handoverTurn) {
      handoverTurn = false;
      const old = led[0];
      if (old) old.status = 'idle';
    }
  };
  const led: { name: string; pane: string; workspace: string; status: string }[] = [
    { name: 'lead', pane: 'pane-old', workspace: 'ws-old', status: opts.status ?? 'idle' },
  ];
  // The old pane's composer: the stop types the exit text into it and needs to read it back, then
  // the Enter runs and the CLI is gone (the shell is the foreground process).
  let boxedText = CLAUDE_IDLE;
  let shelled = false;
  const newPanes = new Map<string, { text: string; agent: boolean; name: string | null; workspace: string }>();
  // The binary each new pane runs: the launch's own first word, so a relaunch on another CLI is
  // read as that CLI's foreground process and the rules delivery goes on.
  const binaries = new Map<string, string>();
  // The first-message rules line a CLI like codex types into its idle box: the echo replaces the
  // grey placeholder, so the delivery's read-back sees the line in the box. `workingLeft` is the
  // one `working` reading the status gives after Enter, before the seat settles back to idle.
  let workingLeft = 0;
  let created = 0;
  const agents = (): HerdrAgent[] => [
    ...led.map((seat) => ({
      name: seat.name,
      agent: 'claude-code',
      pane: seat.pane,
      workspace: seat.workspace,
      status: seat.status,
      cwd: root,
    })),
    ...[...newPanes.entries()]
      .filter(([, slot]) => slot.agent)
      .map(([pane, slot]) => ({
        name: slot.name ?? '',
        agent: 'claude-code',
        pane,
        workspace: slot.workspace,
        status: 'idle',
        cwd: root,
      })),
  ];
  const closeWorkspace = (_session: string, workspace: string): boolean => {
    did.closed.push(workspace);
    for (let index = led.length - 1; index >= 0; index -= 1) {
      if (led[index]!.workspace === workspace) led.splice(index, 1);
    }
    for (const [pane, slot] of [...newPanes.entries()]) {
      if (slot.workspace === workspace) newPanes.delete(pane);
    }
    return true;
  };
  const downLaunch: DownLaunch = {
    typeText(_session, pane, text) {
      did.typed.push(text);
      if (pane === 'pane-old') boxedText = claudeBox(text);
      return true;
    },
    sendKey: () => true,
    pressEnter(_session, pane) {
      if (pane === 'pane-old') shelled = true;
      return true;
    },
    agentPanes: () => agents().map((agent) => agent.pane),
    closeWorkspace,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep,
    now,
  };
  const upLaunch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      created += 1;
      const pane = `pane-new-${created}`;
      const workspace = `ws-new-${created}`;
      newPanes.set(pane, { text: opts.newScreen ?? CLAUDE_IDLE, agent: false, name: null, workspace });
      return { pane, workspace };
    },
    paneRun(_session, pane, command) {
      did.runs.push(command);
      // The launch line may start with the run's environment assignments; the binary the pane
      // runs is the first word that is not one.
      binaries.set(pane, command.trim().split(/\s+/).find((word) => !word.includes('=')) ?? 'claude');
      const slot = newPanes.get(pane);
      if (slot) slot.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const slot = newPanes.get(pane);
      if (slot) slot.name = name;
      return true;
    },
    closeWorkspace,
    agentPanes: () => agents().map((agent) => agent.pane),
    agents: () => agents(),
    paneText: (_session, pane) => newPanes.get(pane)?.text ?? CLAUDE_IDLE,
    // herdr's own status for the new pane: idle once the launch line ran; the seat is `working`
    // for the one reading after the rules line is sent.
    agentStatus: (_session, pane) => {
      if (workingLeft > 0) {
        workingLeft -= 1;
        return 'working';
      }
      return newPanes.has(pane) ? 'idle' : null;
    },
    foreground: (_session, pane) => [binaries.get(pane) ?? 'claude'],
    // The handover request is typed into the old conversation's box: the fake answers it the way
    // an obedient conversation would, writing the file the request names. A line typed into a new
    // pane's box is its echo, which the delivery reads back before it sends it.
    typeText(_session, pane, text) {
      did.typed.push(text);
      const at = / to (\S+):/.exec(text);
      if (at) {
        if (opts.handoverWritten !== false) writeFileSync(at[1]!, '# handover\n\nwhat is left\n');
        if (opts.slowHandover && pane === 'pane-old') {
          handoverTurn = true;
          if (led[0]) led[0].status = 'working';
        }
      }
      const slot = newPanes.get(pane);
      if (slot !== undefined) {
        slot.text = slot.text.includes('› Ask Codex to do anything')
          ? slot.text.replace('› Ask Codex to do anything', `› ${text}`)
          : claudeBox(text);
      }
      return true;
    },
    pressEnter(_session, pane) {
      const slot = newPanes.get(pane);
      if (slot !== undefined) {
        // The line was sent: the box is empty again and the seat starts its turn.
        slot.text = opts.newScreen ?? CLAUDE_IDLE;
        workingLeft = 1;
      }
      return true;
    },
    sleep,
    now,
  };
  const doctor: DoctorSources = {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => true,
    now,
    home,
  };
  const screenKind = opts.screen ?? 'idle';
  const screenOf = (kind: Screen['kind']): Screen => (kind === 'rate limit' ? { kind, reset: null } : { kind });
  const sources: RestartSources = {
    home,
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => (opts.unreadable ? null : agents()),
    workspaces: () => agents().map((agent) => ({ id: agent.workspace })),
    alive: () => true,
    screen: (_session, pane) => (pane === 'pane-old' ? screenOf(screenKind) : { kind: 'idle' }),
    screenText: (_session, pane) => (pane === 'pane-old' ? boxedText : newPanes.get(pane)?.text ?? CLAUDE_IDLE),
    status: (_session, pane) => agents().find((agent) => agent.pane === pane)?.status ?? null,
    foreground: (_session, pane) => (pane === 'pane-old' && shelled ? ['zsh'] : [binaries.get(pane) ?? 'claude']),
    now,
    sleep,
    launch: downLaunch,
    upLaunch,
    doctor,
  };
  return { sources, did };
}

describe('team swap queue', () => {
  test('queues the recipe the rule proposes, for the boundary and the default 30 minutes', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('swap queued: lead');
    const record = queue().lead;
    expect(record).toBeDefined();
    expect(record!.reason).toBe('model-rule');
    expect(record!.from).toMatchObject({ cli: 'claude-code', vendor: 'anthropic', model: 'Claude Opus' });
    expect(record!.to).toMatchObject({ cli: 'claude-code', vendor: 'deepseek', model: 'DeepSeek Flash' });
    expect(Date.parse(record!.deadline) - Date.parse(record!.queuedAt)).toBe(1800 * 1000);
    expect(record!.waitFor).toContain('boundary');
  });

  test('a swap-wait-seconds entity value sets the deadline', async () => {
    place();
    setRule('*=!anthropic');
    writePolicySet(home, { level: 'entity', target: 'lab', name: 'swap-wait-seconds', value: 60 }, { now: NOW });
    const result = await swap(['queue', 'lead']);
    expect(result.code).toBe(0);
    const record = queue().lead!;
    expect(Date.parse(record.deadline) - Date.parse(record.queuedAt)).toBe(60 * 1000);
  });

  test('--to copies a donor on that cli and model', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead', '--to', 'codex:gpt sol']);
    expect(result.code).toBe(0);
    const record = queue().lead!;
    expect(record.to).toMatchObject({ cli: 'codex', vendor: 'openai', model: 'GPT Sol', launch: 'codex --model gpt-sol' });
  });

  test('--to with no donor of the entity refuses', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead', '--to', 'codex:gemini']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('no seat of the entity this team may copy from');
    expect(queue()).toEqual({});
  });

  test('a seat the rule allows has nothing to swap to', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'worker']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('nothing to swap to');
    expect(queue()).toEqual({});
  });

  test('a seat the team does not declare is refused', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'nobody']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('no seat "nobody"');
  });

  test('no entity rule means nothing to queue', async () => {
    place();
    const result = await swap(['queue', 'lead']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('declares no model rule');
  });

  test('a caller that is not the owner or a lead is refused', async () => {
    place();
    setRule('*=!anthropic');
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p2', session: 'acme' };
    const result = await swap(['queue', 'lead'], worker);
    expect(result.code).toBe(1);
    expect(result.err).toContain('only the owner, the orchestrator or the operator');
  });
});

describe('team swap views', () => {
  test('the view prints each queued swap and says when nothing waits', async () => {
    place();
    setRule('*=!anthropic');
    const quiet = await swap([]);
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain('nothing queued');
    await swap(['queue', 'lead']);
    const listed = await swap([]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('lead: anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0');
    expect(listed.out).toContain('waits for');
  });

  test('--rule lists the breach and the donor', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['--rule']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('rule: *=!anthropic (entity lab)');
    expect(result.out).toContain('acme/lead: role project coordinator, vendor anthropic -> claude-code DeepSeek Flash 4.0 from acme/worker');
  });

  test('--rule with -json prints the listing', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['--rule', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{
      schema: { name: string };
      status: string;
      breaches: Array<{ proposal: { donor: Record<string, string> } }>;
    }>(result.out, SWAP_OUTPUT_SCHEMA);
    expect(doc.schema.name).toBe('team.swap');
    expect(doc.status).toBe('rule');
    expect(doc.breaches).toHaveLength(1);
    expect(doc.breaches[0]!.proposal.donor).toMatchObject({ team: 'acme', seat: 'worker' });
  });

  test('a queued swap under --json matches the published schema', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'lead', '--json']);
    expect(result.code).toBe(0);
    const doc = assertMatchesOutputSchema<{ status: string; seat: string }>(result.out, SWAP_OUTPUT_SCHEMA);
    expect(doc.status).toBe('queued');
    expect(doc.seat).toBe('lead');
  });

  test('a refusal under --json is the team.error envelope', async () => {
    place();
    setRule('*=!anthropic');
    const result = await swap(['queue', 'worker', '--json']);
    expect(result.code).toBe(1);
    assertJsonErrorShape(result.out, { id: 'swap.unchanged' });
  });
});

describe('team swap now and --run', () => {
  test('the owner forces a queued swap, and the run carries it out', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const world = fakeHerdr();
    const forced = await swap(['now', 'lead'], OWNER, { sources: world.sources });
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('forced by owner');
    expect(forced.out).toContain('swapped: lead in pane-new-1 (read-back unread)');
    // The request is done: the queue holds nothing, and the file declares the recipe.
    expect(queue()).toEqual({});
    const yaml = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    expect(yaml).toContain('model: DeepSeek Flash');
    expect(yaml).toContain('launch: claude --model deepseek-flash');
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('lead: forced now');
    expect(log).toContain('lead: swapped anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0');
  });

  test('a forced swap the seat cannot leave yet stays queued', async () => {
    place();
    setRule('*=!anthropic');
    const world = fakeHerdr({ status: 'working', screen: 'working' });
    const forced = await swap(['now', 'lead'], OWNER, { sources: world.sources });
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('stays queued');
    expect(queue().lead!.forced).toMatchObject({ by: 'owner', at: NOW.toISOString() });
  });

  test('a forced run with herdr unreadable exits 1 and leaves the forced record standing', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const world = fakeHerdr({ unreadable: true });
    const forced = await swap(['now', 'lead'], OWNER, { sources: world.sources });
    expect(forced.code).toBe(1);
    expect(forced.err).toContain('herdr cannot be read, so the forced swap cannot run now');
    // The force is written before the run: the record outlives the failed run, still forced,
    // for the watch or a later `--run`. The refusal is a partial effect, not a no-change one.
    expect(queue().lead!.forced).toMatchObject({ by: 'owner', at: NOW.toISOString() });
  });

  test('the owner forces a swap that was not queued by taking the rule recipe', async () => {
    place();
    setRule('*=!anthropic');
    const world = fakeHerdr();
    const forced = await swap(['now', 'lead'], OWNER, { sources: world.sources });
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('swapped: lead');
    expect(queue()).toEqual({});
  });

  test('a seat is refused `now`', async () => {
    place();
    setRule('*=!anthropic');
    const lead: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme' };
    const result = await swap(['now', 'lead'], lead);
    expect(result.code).toBe(1);
    expect(result.err).toContain('only the owner forces a swap');
  });

  test('--run drains the queue at the boundary the seat is at', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('swapped: lead in pane-new-1 (read-back unread)');
    expect(queue()).toEqual({});
  });

  // At the boundary, before the deadline could rescue it: herdr reads idle and the screen reads
  // idle, but the projected turn is the authority, so the seat is not free.
  test('--run does not call a seat free while the native proof says a turn runs', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    writePresence('working');
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('lead: stays queued (not due yet)');
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
    expect(queue().lead).toBeDefined();
  });

  // Past its wait, with herdr reading idle and an idle screen: the screen's word is not the
  // authority. The run reads the projected turn itself and leaves the seat alone.
  test('--run past its wait holds a seat the native proof says is working', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    writePresence('working');
    const world = fakeHerdr();
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const ran = await swap(['--run'], OWNER, { sources: world.sources, now: () => later, presenceChannelHealthy: () => true });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('lead: stays queued (past its wait; the native presence proof holds the seat)');
    expect(world.did.typed).toEqual([]);
    expect(world.did.closed).toEqual([]);
    expect(queue().lead).toBeDefined();
  });

  test('--run counts a qualified native idle, with the caller\'s channel proof, as the boundary', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    writePresence('idle');
    const world = fakeHerdr();
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const ran = await swap(['--run'], OWNER, {
      sources: world.sources,
      now: () => later,
      presenceChannelHealthy: () => true,
    });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('swapped: lead in pane-new-1 (read-back unread)');
    expect(queue()).toEqual({});
  });

  // The contract makes an unproven channel a hold, never a fallback: no provider means the
  // native idle projection cannot license the stop, even though herdr shows an idle screen.
  test('--run without a channel proof holds even a native idle projection', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    writePresence('idle');
    const world = fakeHerdr();
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const ran = await swap(['--run'], OWNER, { sources: world.sources, now: () => later });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('lead: stays queued (past its wait; the native presence proof holds the seat)');
    expect(queue().lead).toBeDefined();
  });

  test('an automatic broken screen does not bypass the native hold', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    writePresence('working');
    const world = fakeHerdr({ screen: 'provider error' });
    const later = new Date(NOW.getTime() + 31 * 60_000);
    const ran = await swap(['--run'], OWNER, { sources: world.sources, now: () => later, presenceChannelHealthy: () => true });
    expect(ran.code).toBe(0);
    expect(ran.out).toContain('lead: stays queued (past its wait; the native presence proof holds the seat)');
    expect(world.did.closed).toEqual([]);
  });

  // The one override is the owner's explicit force for this record: it keeps its own semantics.
  test('an explicit force still runs a seat the native proof holds', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    writePresence('working');
    const world = fakeHerdr();
    const forced = await swap(['now', 'lead'], OWNER, { sources: world.sources });
    expect(forced.code).toBe(0);
    expect(forced.out).toContain('swapped: lead in pane-new-1');
    expect(queue()).toEqual({});
  });

  test('--run with nothing queued is no work', async () => {
    place();
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(0);
    expect(ran.out).toBe('');
  });

  test('--run is the owner\'s or a lead\'s: a plain seat is refused', async () => {
    place();
    setRule('*=!anthropic');
    const worker: Caller = { kind: 'seat', name: 'worker', pane: 'w1:p2', session: 'acme' };
    const world = fakeHerdr();
    const ran = await swap(['--run'], worker, { sources: world.sources });
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('only the owner, the orchestrator or the operator');
  });

  test('--run refuses when herdr cannot be read', async () => {
    place();
    const world = fakeHerdr({ unreadable: true });
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('herdr cannot be read');
  });

  test('--run under --json matches the published schema', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const world = fakeHerdr();
    const ran = await swap(['--run', '--json'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(0);
    const doc = assertMatchesOutputSchema<{ status: string; results: Array<{ seat: string; result: string }> }>(
      ran.out,
      SWAP_OUTPUT_SCHEMA,
    );
    expect(doc.status).toBe('ran');
    expect(doc.results).toEqual([expect.objectContaining({ seat: 'lead', result: 'swapped' })]);
  });

  test('--run takes no subcommand and no seat', async () => {
    place();
    const result = await swap(['--run', 'lead']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--run takes no subcommand and no seat');
  });

  // The registry's own record of the seat's last conversation, planted the way a launch writes
  // it: a swap that finds an id on an unchanged CLI resumes it rather than handing over.
  function plantSession(): void {
    const parsed = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const seat = parsed.team.seats.find((one) => one.name === 'lead');
    if (seat === undefined) throw new Error('no lead');
    const made = beginSession({
      home,
      root,
      team: parsed.team,
      session: parsed.team.session,
      seat,
      pane: 'pane-old',
      cli_session: 'ses_0123456789ab',
      now: NOW,
    });
    if ('note' in made) throw new Error(made.note);
  }

  test('a recorded session on an unchanged CLI is resumed, not handed over', async () => {
    place();
    setRule('*=!anthropic');
    plantSession();
    await swap(['queue', 'lead']);
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(0);
    expect(world.did.runs.join('\n')).toContain('claude --model deepseek-flash --resume ses_0123456789ab');
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('lead: resuming session ses_0123456789ab on the new declaration');
    expect(log).toContain('lead: swapped anthropic Claude Opus 5.5 -> deepseek DeepSeek Flash 4.0 (resumed session ses_0123456789ab)');
    // No handover was asked: a resumed conversation already holds its own context.
    expect(world.did.typed.join('\n')).not.toContain('write a handover');
  });

  test('a swap to another CLI asks for a handover, and the launch reads it first', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead', '--to', 'codex:gpt sol']);
    const world = fakeHerdr({ newScreen: CODEX_IDLE });
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code, `${ran.err}${ran.out}`).toBe(0);
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('lead: the old conversation wrote the handover at');
    expect(log).toContain('lead: swapped anthropic Claude Opus 5.5 -> openai GPT Sol 5.0 (handover passed from');
    expect(world.did.runs.join('\n')).toContain('codex --model gpt-sol');
    expect(world.did.runs.join('\n')).not.toContain('--resume');
  });

  test('the run writes the recipe into the seat and leaves the other seats alone', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const world = fakeHerdr();
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(0);
    const yaml = readFileSync(join(root, '.agents', 'team.yaml'), 'utf8');
    const lead = yaml.slice(yaml.indexOf('name: lead'), yaml.indexOf('name: worker'));
    expect(lead).toContain('cli: claude-code');
    expect(lead).toContain('vendor: deepseek');
    expect(lead).toContain('model: DeepSeek Flash');
    expect(lead).toContain('version: "4.0"');
    expect(lead).toContain('display: DeepSeek Flash 4.0');
    expect(lead).toContain('launch: claude --model deepseek-flash');
    const helper = yaml.slice(yaml.indexOf('name: helper'));
    expect(helper).toContain('vendor: openai');
    expect(helper).toContain('launch: codex --model gpt-sol');
    expect(helper).not.toContain('deepseek');
  });

  test('a screen that shows another model is a read-back mismatch; nothing says it swapped and the record stands', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    // The wrapper's banner names a model id the file's launch line does not: the swap ran, and
    // the read-back says it did not land on the declared model.
    const world = fakeHerdr({ newScreen: CLAUDE_IDLE.replace('Opus 5.5 · Acme billing', 'deepseek-v4 · API Usage Billing') });
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code).toBe(1);
    expect(ran.err).toContain('read-back: mismatch');
    expect(ran.err).toContain('the file declares deepseek-flash, the screen shows deepseek-v4; the swap failed');
    // A failed swap is not done: the record stands, and no log line says it swapped.
    expect(queue().lead).toBeDefined();
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('read-back: mismatch');
    expect(log).not.toContain('lead: swapped ');
  });

  test('a seat at a rate limit or provider error swaps at once, closed without typing', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const world = fakeHerdr({ screen: 'provider error' });
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code, `${ran.err}${ran.out}`).toBe(0);
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('lead: at a rate limit or provider error; the swap runs at once');
    // The pane cannot answer, so no handover is asked and no exit text is typed into it.
    expect(log).toContain('lead: no handover is asked; the screen is at a rate limit or provider error');
    expect(world.did.typed.join('\n')).not.toContain('write a handover');
    expect(world.did.typed).not.toContain('/exit');
    // The workspace was closed without typing, and the request is done.
    expect(world.did.closed).toContain('ws-old');
    expect(log).toContain('lead: swapped ');
    expect(queue()).toEqual({});
  });

  test('unsent text is never a boundary and never the past-deadline pause', async () => {
    for (const late of [false, true]) {
      place();
      setRule('*=!anthropic');
      await swap(['queue', 'lead']);
      const world = fakeHerdr({ screen: 'unsent' });
      // `late` reads the queue an hour past a deadline that was NOW + 30 minutes.
      const at = late ? new Date(NOW.getTime() + 3_600_000) : NOW;
      const ran = await swap(['--run'], OWNER, { sources: world.sources, now: () => at });
      expect(ran.code, `${ran.err}${ran.out}`).toBe(0);
      // Past the deadline the pause is the draft nobody sent, not a clock that has not run out.
      expect(ran.out).toContain(
        late
          ? 'lead: stays queued (past its wait; the input box holds unsent text)'
          : 'lead: stays queued (not due yet)',
      );
      // No attempt was made: nothing was typed, and no boundary line was logged.
      expect(world.did.typed).toEqual([]);
      const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
      expect(log).not.toContain('at its boundary');
      expect(log).not.toContain('the wait ran out');
      expect(queue().lead).toBeDefined();
    }
  });

  test('the handover wait runs until the conversation\'s turn ends, not just until its file lands', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead', '--to', 'codex:gpt sol']);
    // The old conversation writes the file inside its turn and is still working after it.
    const world = fakeHerdr({ newScreen: CODEX_IDLE, slowHandover: true });
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code, `${ran.err}${ran.out}`).toBe(0);
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('lead: the old conversation wrote the handover at');
    expect(log).toContain('lead: swapped anthropic Claude Opus 5.5 -> openai GPT Sol 5.0 (handover passed from');
    expect(queue()).toEqual({});
  });

  test('a handover that was never written is not reported as passed', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead', '--to', 'codex:gpt sol']);
    // The old conversation takes the request and writes nothing before the bounded wait ends.
    const world = fakeHerdr({ newScreen: CODEX_IDLE, handoverWritten: false });
    const ran = await swap(['--run'], OWNER, { sources: world.sources });
    expect(ran.code, `${ran.err}${ran.out}`).toBe(0);
    const log = readFileSync(join(root, '.agents', 'team.log'), 'utf8');
    expect(log).toContain('no handover was written before the wait ended; the launch goes on');
    expect(log).toContain(
      'lead: swapped anthropic Claude Opus 5.5 -> openai GPT Sol 5.0 (fresh conversation; no handover was written)',
    );
    expect(log).not.toContain('handover passed from');
    expect(queue()).toEqual({});
  });

  test('cancel removes the record and refused a second cancel', async () => {
    place();
    setRule('*=!anthropic');
    await swap(['queue', 'lead']);
    const cancelled = await swap(['cancel', 'lead']);
    expect(cancelled.code).toBe(0);
    expect(cancelled.out).toContain('swap cancelled: lead');
    expect(queue()).toEqual({});
    const again = await swap(['cancel', 'lead']);
    expect(again.code).toBe(1);
    expect(again.err).toContain('waits on no swap');
  });
});
