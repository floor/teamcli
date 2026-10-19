// `team add <name> --like <seat>` without `--temporary` writes one declared entry that copies the
// source and starts it. These scenes pin what the entry is and what it is not: the copy carries
// the source's fields and no comments, the file's other entries, notes and blank lines stay where
// they were, the approval record keeps its bytes, and the written file is doctor-clean. A name the
// file already declares — including one a counted entry expands to — is refused before any write,
// and so are the flag combinations the copy does not accept. A delegate's copy is admitted only
// when the record holds the source hash for hash, and the edit it writes is the copy the live text
// makes. A launch that fails after the write leaves the entry declared, and the declared seat can
// be started again by name.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAdd, USAGE, type AddSources } from '../src/commands/add.ts';
import { runDoctor, type DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { copySeat, seatIsStopped, takeOut } from '../src/file/lines.ts';
import { readState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T06:10:00Z');
const owner = { kind: 'owner' } as const;
const IDLE = CLAUDE_IDLE;
const DELEGATE_REFUSAL = 'team add: the approved delegate adds only a same-copy seat: the live file\'s own stanza, hash for hash; a missing, stopped or changed seat is the owner\'s\n';

let base: string;
let project: string;
let home: string;

function teamText(): string {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  return `format: 1
# the team file this suite edits
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobby
  - ${trustPath}
  - ${join(home, 'worktrees')}
workspace:
  mode: shared
  base: main
seats:
  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    # builder's own note: a copy leaves it with the source
    stopped: true

  # spare keeps its label and the note after its entry
  - role: implementer
    name: spare
    label: spare
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: runner
    label: runner
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: implementer
    name: scribe
    cli: codex
    vendor: openai
    model: GPT Sol
    version: "6"
    launch: codex -m gpt-6-sol
    human: true
  - role: implementer
    name: skipper
    label: skipper
    nickname: skip
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
  - role: implementer
    name: row
    label: row
    count: 3
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
`;
}

const DELEGATES = `delegates:
  - pane: main/w2:p1
    commands: [add, remove]
`;
const pilot = { kind: 'seat' as const, name: 'pilot', pane: 'w2:p1', session: 'main' };
const passed = { kind: 'passed' as const, pane: 'main/w2:p1' };

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, stdio: 'ignore', env: gitEnv(),
  });
}

function teamPath(): string {
  return join(project, '.agents', 'team.yaml');
}

function approve(text: string = teamText()): void {
  writeFileSync(teamPath(), text);
  const loaded = loadTeamFile(project, { home });
  if (!loaded.ok) throw new Error(loaded.errors.map((problem) => problem.message).join('; '));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
    NOW,
  );
}

function doctor(): DoctorSources {
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

type Made = {
  launch: Launch;
  creates: string[];
  renames: string[];
  commands: string[];
  session: 'absent' | 'running';
};

/** A world whose launches reach an idle prompt unless `fail` is set: then no workspace is ever
 *  created and the seat is left out of the run. */
function world(opts: { fail?: boolean } = {}): Made {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made: Made = { launch: {} as Launch, creates: [], renames: [], commands: [], session: 'absent' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      if (opts.fail) return null;
      n += 1;
      panes.set(`w${n}:p1`, { text: IDLE, agent: false });
      made.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      made.commands.push(command);
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, _pane, name) {
      made.renames.push(name);
      return true;
    },
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    workspacePanes: (_session, workspace) => {
      const found = [...panes.keys()].filter((pane) => pane.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

function sources(made: Made, extra: Partial<AddSources> = {}): AddSources {
  return {
    home,
    sessionState: () => made.session,
    agents: () => [],
    workspaces: () => [],
    doctor: doctor(),
    now: () => NOW,
    launch: made.launch,
    ...extra,
  };
}

function recordBytes(): string {
  return readFileSync(join(storePath('acme', project, home), 'approval.json'), 'utf8');
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-like-')));
  home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  project = join(home, 'acme');
  mkdirSync(join(project, '.agents'), { recursive: true });
  const remote = join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'acme\n');
  git(project, 'add', 'README.md');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'remote', 'add', 'origin', remote);
  git(project, 'push', '-q', '-u', 'origin', 'main');
  approve();
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('a declared copy writes one entry and leaves the rest', () => {
  test('a stopped, commented source copies into a new titled entry that starts', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const record = recordBytes();
    const made = world();
    const io = testIo(project, owner);

    expect(await runAdd(['apprentice', '--like', 'builder'], io, sources(made)), io.out + io.err).toBe(0);

    // The new entry is the source's fields under its own name, with a label the source had
    // none of, no `stopped`, and none of the source's comments.
    const text = readFileSync(teamPath(), 'utf8');
    expect(text).toContain('    name: apprentice\n    label: apprentice\n    cli: claude-code\n'
      + '    vendor: anthropic\n    model: Claude Opus\n    version: "5.5"\n'
      + '    launch: claude --model claude-opus-5-5\n');
    // The source keeps its mark and its note; the note and blank line after its entry stay
    // where they were, and taking the copy back out gives the file the run started from.
    expect(seatIsStopped(text, 'builder')).toBe(true);
    expect(seatIsStopped(text, 'apprentice')).toBe(false);
    expect(text).toContain("# builder's own note: a copy leaves it with the source");
    expect(text).toContain('# spare keeps its label and the note after its entry');
    expect(takeOut(text, 'apprentice')).toBe(before);
    // The new entry validates and the roster edit is not the record's: the approval keeps its
    // bytes.
    expect(loadTeamFile(project, { home }).ok).toBe(true);
    expect(recordBytes()).toBe(record);
    // The seat is launched and titled under its own name.
    expect(made.creates).toEqual(['apprentice']);
    expect(made.renames).toEqual(['apprentice']);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.apprentice?.stage).toBe('ready');
  });

  test('the file a copy writes is doctor-clean', async () => {
    expect(await runAdd(['apprentice', '--like', 'builder'], testIo(project, owner), sources(world()))).toBe(0);
    const after = testIo(project, owner);
    expect(await runDoctor(['--file', teamPath()], after, doctor()), after.out + after.err).toBe(0);
  });

  test('a model override shapes this launch only, never the entry', async () => {
    const made = world();
    const io = testIo(project, owner);

    expect(await runAdd(['apprentice', '--like', 'runner', '--model', 'claude-opus-5-5'], io, sources(made)), io.out + io.err).toBe(0);

    // The launch runs the override; the file keeps the source's model and launch line.
    expect(made.commands).toHaveLength(1);
    expect(made.commands[0]).toContain('--model claude-opus-5-5');
    const text = readFileSync(teamPath(), 'utf8');
    expect(text).toContain('    name: apprentice\n    label: apprentice\n    cli: claude-code\n'
      + '    vendor: anthropic\n    model: Claude Sonnet\n    version: "5.5"\n'
      + '    launch: claude --model claude-sonnet-5-5\n');
    const entry = text.slice(text.indexOf('name: apprentice'), text.indexOf('name: apprentice') + 400);
    expect(entry).not.toContain('claude-opus');
  });
});

describe('a copy onto a name the file already declares is refused before any write', () => {
  test('a declared name', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['builder', '--like', 'spare'], io, sources(made))).toBe(1);
    expect(io.err).toBe('team add: the file already declares "builder"; --like adds a copy under a new name\n');
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
    expect(made.creates).toEqual([]);
  });

  test('a name one counted entry expands to', async () => {
    // `row` is declared with `count: 3`: `row-2` is a seat of the file, though no entry writes
    // its name on a line of its own.
    const before = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['row-2', '--like', 'spare'], io, sources(made))).toBe(1);
    expect(io.err).toBe('team add: the file already declares "row-2"; --like adds a copy under a new name\n');
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
    expect(made.creates).toEqual([]);
  });

  test('the reserved lead name, when the file declares no such seat', async () => {
    const variant = teamText()
      .replace('coordinator: lead\noperator: lead\n', 'coordinator: foreman\noperator: foreman\n')
      .replace('    name: lead\n    label: lead\n', '    name: foreman\n    label: foreman\n');
    approve(variant);
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['lead', '--like', 'spare'], io, sources(made))).toBe(2);
    expect(io.err).toBe(`team add: "lead" is reserved: lead@<team> addresses the team's lead, so no new seat takes it as a name\n${USAGE}`);
    expect(readFileSync(teamPath(), 'utf8')).toBe(variant);
    expect(made.creates).toEqual([]);
  });

  test('a copy that would repeat the source nickname is refused by the file check', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'skipper'], io, sources(made))).toBe(2);
    expect(io.err).toContain('two seats have the nickname "skip"');
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
    expect(made.creates).toEqual([]);
  });

  test('a copy of a human seat is refused: nothing is launched over a person', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'scribe'], io, sources(made))).toBe(1);
    expect(io.err).toBe("team add: scribe is a human's pane: nothing is typed into it or launched over it; left as it is\n");
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
    expect(made.creates).toEqual([]);
  });

  test('a source the file does not declare', async () => {
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'missing'], io, sources(made))).toBe(1);
    expect(io.err).toBe('team add: the file has no seat "missing"\n');
    expect(made.creates).toEqual([]);
  });
});

describe('the flags a declared copy accepts', () => {
  test('--like needs a value', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like'], io, sources(world()))).toBe(2);
    expect(io.err.startsWith('team add: --like needs a value\nUsage: team add')).toBe(true);
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
  });

  test('--until still needs --temporary', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'spare', '--until', 'result:notes/result.md'], io, sources(world()))).toBe(2);
    expect(io.err).toBe('team add: --until and --worktree are for --temporary\n');
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
  });

  test('--worktree still needs --temporary', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'spare', '--worktree', 'task-1'], io, sources(world()))).toBe(2);
    expect(io.err).toBe('team add: --until and --worktree are for --temporary\n');
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
  });
});

describe('a delegated copy writes the live source and nothing else', () => {
  function delegateFile(): string {
    return teamText() + DELEGATES;
  }

  test('the admitted copy is the live text\'s own copy, and the record keeps its bytes', async () => {
    approve(delegateFile());
    const before = readFileSync(teamPath(), 'utf8');
    const record = recordBytes();
    const made = world();
    const io = testIo(project, pilot);

    const code = await runAdd(['apprentice', '--like', 'spare'], io, sources(made, { delegateGate: () => passed }));
    expect(code, io.out + io.err).toBe(0);

    // The entry written is exactly what copying the live source produces; the source's stanza
    // was the record's, hash for hash.
    const text = readFileSync(teamPath(), 'utf8');
    expect(text).toBe(copySeat(before, 'spare', 'apprentice'));
    expect(takeOut(text, 'apprentice')).toBe(before);
    expect(recordBytes()).toBe(record);
    expect(made.creates).toEqual(['apprentice']);
    // The act is logged at the effects boundary, naming the delegate pane and the command.
    const log = readFileSync(join(project, '.agents', 'team.log'), 'utf8');
    expect(log.startsWith(`${NOW.toISOString()} delegate`)).toBe(true);
    expect(log).toContain('main/w2:p1 add\n');
  });

  test('a delegated dry run plans the copy and writes nothing', async () => {
    approve(delegateFile());
    const before = readFileSync(teamPath(), 'utf8');
    const record = recordBytes();
    const made = world();
    const io = testIo(project, pilot);

    const code = await runAdd(['apprentice', '--like', 'spare', '--dry-run'], io, sources(made, { delegateGate: () => passed }));
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toContain('apprentice');
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
    expect(recordBytes()).toBe(record);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    expect(made.creates).toEqual([]);
  });

  test('a copy of a human source is refused before the gate\'s edit check', async () => {
    approve(delegateFile());
    const before = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, pilot);
    expect(await runAdd(['apprentice', '--like', 'scribe'], io, sources(made, { delegateGate: () => passed }))).toBe(1);
    expect(io.err).toBe("team add: scribe is a human's pane: nothing is typed into it or launched over it; left as it is\n");
    expect(readFileSync(teamPath(), 'utf8')).toBe(before);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    expect(made.creates).toEqual([]);
  });

  test('a source the record no longer holds hash for hash is the owner\'s', async () => {
    approve(delegateFile());
    // The live file's source changed after the record was signed: its label differs.
    const live = readFileSync(teamPath(), 'utf8').replace('label: spare', 'label: spare-2');
    writeFileSync(teamPath(), live);
    const made = world();
    const io = testIo(project, pilot);
    expect(await runAdd(['apprentice', '--like', 'spare'], io, sources(made, { delegateGate: () => passed }))).toBe(1);
    expect(io.err).toBe(DELEGATE_REFUSAL);
    expect(readFileSync(teamPath(), 'utf8')).toBe(live);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    expect(made.creates).toEqual([]);
  });

  test('a source the record never held is the owner\'s', async () => {
    approve(delegateFile());
    // A seat added to the live file after the approval: the record has no stanza to compare.
    const live = readFileSync(teamPath(), 'utf8').replace('delegates:\n', `  - role: implementer
    name: fresh
    label: fresh
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude --model claude-sonnet-5-5
delegates:
`);
    writeFileSync(teamPath(), live);
    const made = world();
    const io = testIo(project, pilot);
    expect(await runAdd(['apprentice', '--like', 'fresh'], io, sources(made, { delegateGate: () => passed }))).toBe(1);
    expect(io.err).toBe(DELEGATE_REFUSAL);
    expect(readFileSync(teamPath(), 'utf8')).toBe(live);
    expect(existsSync(join(project, '.agents', 'team.log'))).toBe(false);
    expect(made.creates).toEqual([]);
  });
});

describe('a launch that fails after the write', () => {
  test('leaves the entry declared and the run an error', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const record = recordBytes();
    const made = world({ fail: true });
    const io = testIo(project, owner);

    expect(await runAdd(['apprentice', '--like', 'builder'], io, sources(made)), io.out + io.err).toBe(1);
    expect(io.out + io.err).toContain('its workspace was not created');
    expect(made.creates).toEqual([]);

    // The write came before the launch and is not undone: the entry is declared, validates, and
    // is the only change; the record keeps its bytes.
    const text = readFileSync(teamPath(), 'utf8');
    expect(takeOut(text, 'apprentice')).toBe(before);
    expect(loadTeamFile(project, { home }).ok).toBe(true);
    expect(recordBytes()).toBe(record);
    const state = readState(join(project, '.agents')).sessions.acme?.seats.apprentice;
    expect(state).toMatchObject({ stage: 'launched' });
    expect(state?.pane).toBeUndefined();
  });

  test('the declared seat starts by name on the next run, with no second entry', async () => {
    expect(await runAdd(['apprentice', '--like', 'builder'], testIo(project, owner), sources(world({ fail: true })))).toBe(1);
    const afterFail = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, owner);

    expect(await runAdd(['apprentice'], io, sources(made)), io.out + io.err).toBe(0);
    expect(made.creates).toEqual(['apprentice']);
    // It is a declared seat now, so the restart writes no second entry and no edit at all.
    expect(readFileSync(teamPath(), 'utf8')).toBe(afterFail);
    expect(readState(join(project, '.agents')).sessions.acme?.seats.apprentice?.stage).toBe('ready');
  });
});
