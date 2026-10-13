// The rule the answer regression (a caller walk ahead of the `--session` refusal) drew: every
// command that accepts `--session` or `--file` and can reach herdr holds its flag gate ahead of
// any host call, or allows the flag to a non-owner on purpose. The commands that change a team
// are held by coordinator-session.test.ts's six-command battery; this file holds the pairs the
// battery does not reach — `answer` gets a direct test of each flag of its own (it is the
// command that regressed, and its battery coverage is parametrised, not named), and the
// read-and-report commands get their first non-owner `--session` tests at all. The pairs and
// their tests are tabulated in the pull request. `send --file` is not this flag (it names the
// message's file), and `approve`, `commits`, `pr` and `release` reach no herdr.
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf, verifiedOf } from '../../src/approve/approval.ts';
import type { CallerSources } from '../../src/caller.ts';
import type { AnswerHost } from '../../src/commands/answer.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import type { StatusSources } from '../../src/commands/status.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { emptySession, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { testIo } from '../helpers.ts';

// A reorder that reads the flagged file before refusing it changes no bytes and prints the same
// refusal, so the walk's empty call record alone cannot see it. The fs is therefore wrapped to
// record every touch (exists, lstat, realpath, read) under a directory a test points at — the
// --file refusal must not so much as look. The wrapper delegates everything to the real fs.
// bun binds a module's named imports as it loads, so the mock has to be registered before the
// command under test (and its load chain) is imported: the commands here are imported
// dynamically, in the beforeAll below; every static import above loads no command.
const realFs = await import('node:fs');
const touched: string[] = [];
let watching: string | undefined;
mock.module('node:fs', () => {
  const wrapped = Object.assign({}, realFs);
  for (const name of ['existsSync', 'lstatSync', 'realpathSync', 'readFileSync'] as const) {
    const real = realFs[name] as (...args: unknown[]) => unknown;
    Object.assign(wrapped, {
      [name]: (...args: unknown[]) => {
        if (watching !== undefined && String(args[0]).startsWith(watching)) {
          touched.push(`${name}(${String(args[0]).slice(watching.length)})`);
        }
        return real(...args);
      },
    });
  }
  return wrapped as typeof realFs;
});

let runAnswer: (typeof import('../../src/commands/answer.ts'))['runAnswer'];
let runDoctor: (typeof import('../../src/commands/doctor.ts'))['runDoctor'];
let runStatus: (typeof import('../../src/commands/status.ts'))['runStatus'];
beforeAll(async () => {
  ({ runAnswer } = await import('../../src/commands/answer.ts'));
  ({ runDoctor } = await import('../../src/commands/doctor.ts'));
  ({ runStatus } = await import('../../src/commands/status.ts'));
});

const NOW = new Date('2026-10-03T14:02:00Z');
const FILE = `format: 1
project: acme
session: acme-web
coordinator: worker
operator: worker
workspace:
  mode: shared
seats:
  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const fileText = () => `${FILE}trust:\n  - ~/.config/team/lobby\n  - ${root}\n`;

let base: string;
let root: string;
let home: string;
let stateFile: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-flag-gates-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents/team.yaml'), fileText());
  stateFile = join(root, '.agents', 'team.state.json');
});

/** The file as the owner approved it, in this home's store: the read commands' reports and
 *  `up`'s refusals then carry no approval noise of their own. */
function approveFile(): void {
  const text = fileText();
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(`fixture does not validate: ${JSON.stringify(checked.errors)}`);
  const team = checked.team;
  writeApproval(storePath(team.project, root, home), { approval: approvalOf(team, root), file: text }, team.seats, home);
}

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A caller the walk places under herdr: `unplaced` without a session read. Every herdr-reaching
 *  source records into `calls`, so a test asserting `calls` empty proves no host call ran. */
function underHerdr(calls: string[]): (asked: string | undefined) => CallerSources {
  return (asked) => ({
    ancestors: () => [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }],
    agents: () => {
      calls.push(`agents(${asked ?? 'no session'})`);
      return [];
    },
    paneRootPid: (pane) => {
      calls.push(`paneRootPid(${pane})`);
      return null;
    },
    env: {},
    stdinIsTTY: true,
  });
}

/** An answer host whose every herdr-reaching method records and returns nothing: any call on it
 *  lands in `calls`, so the pair of recordings covers both halves of the rule — the walk's
 *  reads and the command's own. */
function answerHost(calls: string[]): AnswerHost {
  return {
    version: () => null,
    agents: (session) => {
      calls.push(`host.agents(${session})`);
      return null;
    },
    pane: (session, pane) => {
      calls.push(`host.pane(${session}, ${pane})`);
      return undefined;
    },
    sendKey: (session, pane) => {
      calls.push(`host.sendKey(${session}, ${pane})`);
      return false;
    },
    rename: (session, pane) => {
      calls.push(`host.rename(${session}, ${pane})`);
      return false;
    },
    foreground: (session, pane) => {
      calls.push(`host.foreground(${session}, ${pane})`);
      return null;
    },
    foregroundCwd: (session, pane) => {
      calls.push(`host.foregroundCwd(${session}, ${pane})`);
      return null;
    },
    list: (dir) => {
      calls.push(`host.list(${dir})`);
      return null;
    },
    status: (session, pane) => {
      calls.push(`host.status(${session}, ${pane})`);
      return null;
    },
    type: (session, pane) => {
      calls.push(`host.type(${session}, ${pane})`);
      return false;
    },
    enter: (session, pane) => {
      calls.push(`host.enter(${session}, ${pane})`);
      return false;
    },
    processInfo: (session, pane) => {
      calls.push(`host.processInfo(${session}, ${pane})`);
      return null;
    },
    now: () => NOW,
    sleep: async () => {},
    home,
    standing: () => {
      calls.push('host.standing');
      return { kind: 'none' };
    },
  };
}

describe("answer: --file is the owner's — its own direct test", () => {
  test('a non-owner aiming --file at another project is refused before any host call', async () => {
    const flagged = join(base, 'flagged');
    mkdirSync(join(flagged, '.agents'), { recursive: true });
    const flaggedFile = join(flagged, '.agents/team.yaml');
    writeFileSync(flaggedFile, 'format: [\n');
    const calls: string[] = [];
    const io = testIo(root);
    io.callerSources = underHerdr(calls);
    // Every fs touch under the flagged project is recorded: the refusal must come before the
    // file is read, and a reorder that only reads first would leave every other pin standing.
    watching = flagged;
    touched.length = 0;
    const code = await runAnswer(['worker', 'trust', '--file', flaggedFile], io, answerHost(calls));
    watching = undefined;
    expect(code).toBe(1);
    expect(io.err).toBe(
      "team answer: --file is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n",
    );
    // No walk read and no command read: nothing asked herdr, nothing read the store.
    expect(calls).toEqual([]);
    // And nothing so much as looked at the flagged file: no exists, no lstat, no realpath, no read.
    expect(touched).toEqual([]);
    // The flagged file was never read: unparsable bytes, and no problem of its own is reported.
    expect(readFileSync(flaggedFile, 'utf8')).toBe('format: [\n');
    // And nothing written anywhere: no refusal log and no state, in either project.
    expect(existsSync(join(root, '.agents', 'team.log'))).toBe(false);
    expect(existsSync(join(flagged, '.agents', 'team.log'))).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    expect(existsSync(join(flagged, '.agents', 'team.state.json'))).toBe(false);
  });
});

describe("answer: --session is the owner's — its own direct test", () => {
  test('a non-owner aiming --session is refused at once, before that session is read', async () => {
    updateState(join(root, '.agents'), (state) => {
      state.sessions['acme-web'] = emptySession();
    });
    const beforeState = readFileSync(stateFile, 'utf8');
    const calls: string[] = [];
    const io = testIo(root);
    io.callerSources = underHerdr(calls);
    const code = await runAnswer(['worker', 'trust', '--session', 'elsewhere'], io, answerHost(calls));
    expect(code).toBe(1);
    expect(io.err).toBe(
      "team answer: --session is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n",
    );
    // The refusal is decided by the walk alone: the flagged session is never asked for.
    expect(calls).toEqual([]);
    // answer logs its caller refusals beside the team file: one line only, the refusal's own.
    const lines = readFileSync(join(root, '.agents', 'team.log'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('answer [unplaced] worker: refused trust: caller')).toBe(true);
    // And the state file is untouched.
    expect(readFileSync(stateFile, 'utf8')).toBe(beforeState);
  });
});

function verifiedStanding() {
  const text = fileText();
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error('fixture does not validate');
  return verifiedOf(checked.team, text, root, NOW);
}

describe('status: --session for a non-owner', () => {
  // A read was open to any caller.
  // The caller rule replaces it.
  test('a non-owner aiming --session is refused at once, before that session is read', async () => {
    updateState(join(root, '.agents'), (state) => {
      state.sessions['acme-web'] = emptySession();
    });
    const beforeState = readFileSync(stateFile, 'utf8');
    const calls: string[] = [];
    const sources: StatusSources = {
      live: (session) => {
        calls.push(`live(${session})`);
        return { running: true, agents: [], workspaces: [], screens: {} };
      },
      branch: () => {
        calls.push('branch');
        return 'main';
      },
      standing: () => {
        calls.push('standing');
        return verifiedStanding();
      },
      now: () => NOW,
      home,
    };
    const io = testIo(root);
    io.callerSources = underHerdr(calls);
    const code = await runStatus(['--session', 'team-test'], io, sources);
    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(
      "team status: --session is the owner's, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n",
    );
    expect(calls).toEqual([]);
    expect(readFileSync(stateFile, 'utf8')).toBe(beforeState);
  });
});

describe('doctor: --session for a non-owner', () => {
  test('reports the aimed session for any caller, and writes nothing', async () => {
    approveFile();
    const asked: string[] = [];
    const sources: DoctorSources = {
      version: () => '2.1.288',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: (session) => {
        asked.push(session);
        return false;
      },
      agentList: () => [],
      now: () => NOW,
      home,
    };
    const io = testIo(root, { kind: 'seat', name: 'worker', pane: 'w3:p1' });
    const code = await runDoctor(['--session', 'team-test'], io, sources);
    expect(code).toBe(0);
    // The aimed session is the one asked about, and the report names it.
    expect(asked).toEqual(['team-test']);
    expect(io.out).toContain('session team-test is not running');
    // Doctor writes nothing beside the file it read.
    expect(existsSync(stateFile)).toBe(false);
  });
});

