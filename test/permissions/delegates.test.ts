// The delegate rules of the permissions round, written from the orchestrator's rule text and
// independently of the gate's own suite (test/delegate.test.ts):
//
//   (a) a delegate is the actor and authorizes nothing, so the record names the owner as signer
//       and the delegate as actor;
//   (b) a delegate may add a SAME-COPY seat only, and a non-copy add — a different stanza — is
//       refused outside dev mode, naming the rule, even with a delegate entry;
//   (c) a delegate entry naming up/down runs start/stop for its own team only, and a seat
//       holding `grant`, `agree` or `leads` is removed by the owner only.
//
// A scene whose wiring the base already holds is real, pinned at the seam that decides it —
// the gate (src/delegate.ts) for a file's own words and the file they stand in, the command
// (src/commands/add.ts) for a delegated add that would write. The rest are `test.todo`, their
// names the rules they will pin: each flips to a real scene as its wiring lands. A delegated
// run's record naming its signer and its actor — (a) — has no field on this base; the
// same-copy boundary of (b) is builder wiring under way; (c)'s protected removal is a real
// scene, both halves pinned by runs: the removal gate clamps the lead's seats itself
// (src/commands/remove.ts), and the owner's own attempt meets the file's validation, which
// refuses the dangling `operator:` — a lead seat is never taken out of the file.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprints } from '../../src/approve/fingerprint.ts';
import type { Caller } from '../../src/caller.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { DownSources } from '../../src/commands/down.ts';
import { runRemove } from '../../src/commands/remove.ts';
import type { Launch } from '../../src/commands/up.ts';
import { ADD_DELEGATE_EDIT, delegateGate, type DelegateVerdict } from '../../src/delegate.ts';
import type { ActingCommand } from '../../src/delegate-types.ts';
import type { TeamFile } from '../../src/file/types.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import type { HerdrAgent } from '../../src/herdr.ts';
import { emptySession, type State, updateState } from '../../src/state.ts';
import { type Standing } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

const NOW = new Date('2026-10-17T12:00:00.000Z');

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A pane outside the team's session, standing as a seat of its own session: the delegate the
 *  entry names, and the caller every scene here comes from. */
const pilot: Caller = { kind: 'seat', name: 'pilot', pane: 'w1:p1', session: 'main' };

const team = (delegates: string): string => `format: 1
project: acme
session: acme
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
${delegates}`;

/** One entry, its pane and the words it names. */
const entry = (pane: string, commands: string): string => `delegates:
  - pane: ${pane}
    commands: [${commands}]
`;

function parsed(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

function verified(team: TeamFile, file: string): Standing {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: '2026-10-17T00:00:00.000Z',
    record: {
      approval: {
        format: 2,
        approvedAt: '2026-10-17T00:00:00.000Z',
        root: '/proj',
        fingerprints: fingerprints(team),
        ceilings: { seats: team.limits.seats, temporary: team.limits.temporary, vendors: { ...team.limits.vendors } },
      },
      file,
      generation: 1,
      signature: 'test',
    },
  };
}

const empty: State = { format: 1, sessions: {} };

type Scene = {
  command?: ActingCommand;
  file?: string;
  caller?: Caller;
  standing?: Standing;
  state?: State;
  agents?: HerdrAgent[] | null;
  flags?: readonly string[];
  swap?: boolean;
};

function gate(scene: Scene = {}): DelegateVerdict {
  const file = scene.file ?? team(entry('main/w1:p1', 'up, down'));
  const judged = parsed(file);
  return delegateGate({
    command: scene.command ?? 'up',
    ...(scene.swap ? { swap: true } : {}),
    team: judged,
    root: '/proj',
    dir: '/proj/.agents',
    flags: scene.flags ?? [],
    io: { env: {}, stdinIsTTY: true, caller: scene.caller ?? pilot },
    sources: {
      standing: () => scene.standing ?? verified(judged, file),
      state: () => scene.state ?? empty,
      agents: () => scene.agents ?? [],
      sessionRunning: () => null,
    },
  });
}

function refused(scene: Scene): { id: string; text: string } {
  const verdict = gate(scene);
  if (verdict.kind !== 'refused') throw new Error(`passed ${verdict.pane}`);
  return { id: verdict.id, text: verdict.text };
}

describe("a file's words are its own, and they are all a delegate holds", () => {
  test('an entry of up and down runs start and stop, and refuses every other word', () => {
    expect(gate({ command: 'up' })).toEqual({ kind: 'passed', pane: 'main/w1:p1' });
    expect(gate({ command: 'down' })).toEqual({ kind: 'passed', pane: 'main/w1:p1' });
    for (const command of ['add', 'remove', 'approve'] as const) {
      expect(refused({ command })).toEqual({
        id: `${command}.delegate-command`,
        text: `the approved delegate main/w1:p1 may not run \`${command}\`; its approved commands are up, down`,
      });
    }
    // The lead seat's replacement is the word `swap`; `remove` never stands for it.
    expect(refused({ command: 'remove', swap: true })).toEqual({
      id: 'remove.delegate-command',
      text: 'the approved delegate main/w1:p1 may not swap a lead seat (`swap`); its approved commands are up, down',
    });
  });

  test("the entry is the file's own: the same pane is no delegate of the next team", () => {
    // The pane the next file names is another pane, and the entry of one file never reaches
    // the other: the caller stands in `main/w1:p1`, and this file's words are start and stop
    // for `main/w2:p1` alone.
    const elsewhere = team(entry('main/w2:p1', 'up, down'));
    expect(refused({ file: elsewhere })).toEqual({
      id: 'up.delegate',
      text: 'only the owner or the approved delegate runs `up`; this call is pilot',
    });
    // And a file that names no delegate at all — the words are nowhere.
    const plain = team('');
    expect(refused({ file: plain }).id).toBe('up.delegate');
    expect(refused({ file: plain, command: 'down' }).id).toBe('down.delegate');
  });

  test('a pass hands back the acting pane and nothing beside it', () => {
    // The verdict is the pane and no authority of its own: a delegate is an actor.
    expect(gate()).toEqual({ kind: 'passed', pane: 'main/w1:p1' });
  });
});

describe('the record a delegated run leaves', () => {
  test.todo('a delegated run records the owner as signer and the delegate pane as actor — never the pane as signer', () => {
    // Flipped when the record lands: run a delegated `up`/`add` and read the record it leaves —
    // its signer is the owner whose approval admitted the run, its actor the pane that ran it.
  });

  test.todo('a delegated approval keeps the owner as the signer and the pane as the actor that submitted it', () => {
    // Flipped when the approval record names its actor beside its signer: the approving word is
    // the owner's and the submission is the pane's.
  });
});

const worker = `  - role: worker
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

type Place = { base: string; root: string; home: string; file: string };

function layout(): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegates-')));
  made.push(base);
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  return { base, root, home, file: join(root, '.agents', 'team.yaml') };
}

/** The team's file with a stopped `worker` declared, so `team add worker` would clear
 *  `stopped` — a write. The delegates section is the scene's variable. */
function addFile(place: Place, delegates: string): string {
  return `format: 1
project: acme
session: acme
coordinator: lead
operator: lead
trust:
  - ~/.config/team/lobby
  - ${place.root}
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
${worker}${delegates}`;
}

const agent: HerdrAgent = { name: 'lead', agent: 'claude', pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null };

function launching(): Launch {
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, boolean>();
  let n = 0;
  return {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `w${n}:p1`;
      panes.set(pane, false);
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
      if (panes.has(pane)) panes.set(pane, true);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, up]) => up).map(([id]) => id),
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
}

function doctor(home: string): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

function addSources(place: Place, over: Partial<AddSources> = {}): AddSources {
  return {
    home: place.home,
    sessionState: () => 'absent',
    agents: () => [agent],
    workspaces: () => [],
    doctor: doctor(place.home),
    now: () => NOW,
    launch: launching(),
    ...over,
  };
}

type Ran = { code: number; out: string; err: string };

async function added(place: Place, argv: string[], caller: Caller, sources: AddSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runAdd(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

describe('the delegated add: the file it may not write', () => {
  test('an add that would clear `stopped` is refused, the rule named, and nothing is written', async () => {
    const place = layout();
    const text = addFile(place, entry('main/w1:p1', 'add'));
    writeFileSync(place.file, text);
    const launch = launching();
    const sources = addSources(place, {
      launch,
      delegateGate: () => ({ kind: 'passed' as const, pane: 'main/w1:p1' }),
    });
    const ran = await added(place, ['worker'], pilot, sources);
    expect(ran.code).toBe(1);
    expect(ran.err).toBe(`team add: ${ADD_DELEGATE_EDIT.text}\n`);
    // The entry names `add` and the gate passed — and the file is still byte for byte the one
    // that was approved: the edit is the owner's, and the refusal comes before any write.
    expect(readFileSync(place.file, 'utf8')).toBe(text);
    expect(existsSync(join(place.root, '.agents', 'team.log'))).toBe(false);
    expect(launch.sessionUp('acme')).toBe(false);
    expect(launch.agentPanes('acme')).toEqual([]);
  });

  test('with no delegates section the same run is refused by the ordinary rule, the gate never asked', async () => {
    const place = layout();
    writeFileSync(place.file, addFile(place, ''));
    const sources = addSources(place, {
      delegateGate: () => {
        throw new Error('the delegate gate was asked with no delegates section');
      },
    });
    const ran = await added(place, ['worker'], pilot, sources);
    expect(ran.code).toBe(1);
    expect(ran.err).toBe('team add: only the owner or a standing grant (delegate) runs it; this call is pilot\n');
  });

  test.todo('a delegate may add a same-copy seat: a stanza the file already holds, copied hash for hash', () => {
    // Flipped when the same-copy wiring lands: the one add a delegate may write is the copy.
  });

  test.todo('a non-copy add is refused outside dev mode, the refusal naming the same-copy rule, even with a delegate entry', () => {
    // Flipped when the refusal names the same-copy rule rather than the edit alone.
  });
});

// A team of two lead seats beside an ordinary one, and a home holding no registry record of it:
// the file's own declaration is the only record that stands, so what admits is read from it —
// `lead-a`, the orchestrator, is the declaration's `leads` (src/permissions/who.ts' declaration
// path), and `lead-b` is the operator's seat: a lead's own, by the same file.
const PROTECTED = `format: 1
project: acme
session: acme
coordinator: lead-a
operator: lead-b
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead-a
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: lead-b
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: builder
    name: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const leadA: Caller = { kind: 'seat', name: 'lead-a', pane: 'w1:p1', session: 'acme' };
const owner: Caller = { kind: 'owner' };

/** The file, trusted the way `addFile` writes trust, with `lead-a` where its launch recorded
 *  it: the gate's pane proof, not a door this scene tests. */
function protectedFile(place: Place): string {
  const text = PROTECTED.replace(
    'workspace:\n',
    `trust:\n  - ~/.config/team/lobby\n  - ${place.root}\nworkspace:\n`,
  );
  updateState(join(place.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats['lead-a'] = { stage: 'launched', pane: 'w1:p1' };
  });
  return text;
}

/** An idle session: no agent runs, so every refusal below is a gate's own. */
function removal(home: string): DownSources {
  return {
    home,
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    now: () => NOW,
  };
}

async function removed(place: Place, argv: string[], caller: Caller, sources: DownSources): Promise<Ran> {
  const io = testIo(place.root, caller);
  const code = await runRemove(argv, io, sources);
  return { code, out: io.out, err: io.err };
}

describe('the protected seats', () => {
  test("the operator's seat stays: a lead meets the clamp, the owner the file's own validation", async () => {
    const here = layout();
    writeFileSync(here.file, protectedFile(here));
    const before = readFileSync(here.file, 'utf8');
    // A lead that may remove every ordinary seat of its team is stopped here: the seat being
    // removed is the operator's, and the clamp admits only the owner's own call.
    const ran = await removed(here, ['lead-b'], leadA, removal(here.home));
    expect(ran.code).toBe(1);
    expect(ran.err).toBe("team remove: only the owner removes the orchestrator's or the operator's seat; this call is lead-a\n");
    expect(ran.out).toBe('');
    expect(readFileSync(here.file, 'utf8')).toBe(before);
    // The owner passes the clamp and meets the file's own validation: taking the seat out would
    // leave `operator:` naming nothing, so the edit is refused (exit 2) and nothing is written.
    const owned = await removed(here, ['lead-b'], owner, removal(here.home));
    expect(owned.code).toBe(2);
    expect(owned.err).toBe('team remove: line 5: operator "lead-b" names no declared seat\n');
    expect(owned.out).toBe('');
    expect(readFileSync(here.file, 'utf8')).toBe(before);
    // The control: the same owner, the ordinary seat — removed, so the refusal above is the
    // lead seat's, not the world's.
    const two = layout();
    writeFileSync(two.file, protectedFile(two));
    const ownedWorker = await removed(two, ['worker'], owner, removal(two.home));
    expect(ownedWorker.code).toBe(0);
    expect(ownedWorker.out).toBe('removed worker\n');
    expect(ownedWorker.err).toBe('');
  });
});
