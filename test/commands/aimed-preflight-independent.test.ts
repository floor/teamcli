// Independent scenes for the owner-preflight fix (install 1): a non-owner's aimed `--file` and
// `--session` are the owner's, and the refusal is decided before anything asks the terminal host
// or engages the owner-seat door — even when the aimed target's charter or approval state would
// have blocked or asked there. The own-team add stays admitted, so the fence narrows nothing
// inside the team. Every herdr-reaching source records into one calls list; a refusal scene
// asserting it empty proves no host read ran.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../../src/approve/approval.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { runAdd, type AddSources } from '../../src/commands/add.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import { loadTeamFile } from '../../src/file/load.ts';
import { emptySession, readState, updateState } from '../../src/state.ts';
import { storePath, writeApproval } from '../../src/store/store.ts';
import { CLAUDE_IDLE, recordRenames, testIo } from '../helpers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');
const SESSION = 'acme-web';
const LEAD = 'claude-lead-acme';
const PANE = 'synthetic-pane-lead';

let base: string;
let root: string;
let home: string;
let flaggedRoot: string;
let flaggedFile: string;

/** The team the lead belongs to: the lead is coordinator and operator, worker is the seat the
 *  positive control readies, and the approval is in force so nothing of the team's own would
 *  block a run that reached a gate. */
function teamText(): string {
  return `format: 1
project: acme
session: ${SESSION}
coordinator: ${LEAD}
operator: ${LEAD}
workspace:
  mode: shared
trust:
  - ~/.config/team/lobby
  - ${root}
seats:
  - role: coordinator
    name: ${LEAD}
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
  - role: implementer
    name: worker
    # This fixture pins authority or the recorded recipe, independently of the channel.
    channel: off
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
`;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-aimed-preflight-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamText());
  // The aimed project: a file nothing could approve, so a run that reached its charter or
  // approval door would block there — the refusal has to come first, or this file is read.
  flaggedRoot = join(base, 'flagged');
  flaggedFile = join(flaggedRoot, '.agents', 'team.yaml');
  mkdirSync(join(flaggedRoot, '.agents'), { recursive: true });
  writeFileSync(flaggedFile, 'format: [\n');
  // The team's own approval, in force.
  const loaded = loadTeamFile(root, { home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root), file: teamText() },
    loaded.team.seats,
    home,
    NOW,
  );
  // The lead is placed: a seat caller whose own team would admit it, so the aimed refusal is
  // the fence's, not a placement failure.
  updateState(join(root, '.agents'), (state) => {
    (state.sessions[SESSION] ??= emptySession()).seats[LEAD] = { stage: 'ready', pane: PANE };
  });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Every file under the synthetic home, so a refusal that wrote anything — an approval request,
 *  a log, a state — shows as a diff rather than passing unnoticed. */
function homeTree(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      out.push(join(prefix, entry.name));
      if (entry.isDirectory()) walk(join(dir, entry.name), join(prefix, entry.name));
    }
  };
  walk(home, '');
  return out.sort();
}

function placedLeadIo(calls: string[]): ReturnType<typeof testIo> {
  const io = testIo(root, { kind: 'seat', name: LEAD, pane: PANE, session: SESSION });
  // The caller is placed on io, so nothing should consult the sources; if a path does, it lands
  // in the same calls list the refusal scenes assert empty.
  io.callerSources = (asked) => {
    calls.push(`callerSources(${asked ?? 'none'})`);
    return {
      ancestors: () => {
        calls.push('ancestors');
        return [{ pid: 210, name: 'zsh' }, { pid: 200, name: 'claude' }, { pid: 10, name: 'herdr' }];
      },
      agents: () => {
        calls.push(`caller.agents(${asked ?? 'none'})`);
        return [];
      },
      paneRootPid: (pane) => {
        calls.push(`caller.paneRootPid(${pane})`);
        return null;
      },
      env: {},
      stdinIsTTY: true,
    };
  };
  return io;
}

function recordingDoctor(calls: string[]): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => {
      calls.push('doctor.herdrVersion');
      return '0.7.1';
    },
    sessionRunning: (session) => {
      calls.push(`doctor.sessionRunning(${session})`);
      return false;
    },
    now: () => NOW,
    home,
  };
}

/** The launch seam with every method recording; the positive control's pane world lives in the
 *  panes map, and every refusal scene expects this object untouched. */
function recordingLaunch(calls: string[]): { launch: Launch; creates: string[] } {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const creates: string[] = [];
  const launch: Launch = {
    sessionState: (session) => {
      calls.push(`launch.sessionState(${session})`);
      return 'running';
    },
    startServer: (session) => {
      calls.push(`launch.startServer(${session})`);
      return true;
    },
    sessionUp: (session) => {
      calls.push(`launch.sessionUp(${session})`);
      return true;
    },
    createWorkspace: (session, _cwd, label) => {
      calls.push(`launch.createWorkspace(${session}, ${label})`);
      n += 1;
      panes.set(`seat-pane-${n}`, { text: CLAUDE_IDLE, agent: false });
      creates.push(label);
      return { pane: `seat-pane-${n}`, workspace: `ws-${n}` };
    },
    paneRun: (session, pane) => {
      calls.push(`launch.paneRun(${session}, ${pane})`);
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: (session, pane, name) => {
      calls.push(`launch.renameAgent(${session}, ${pane}, ${name})`);
      return true;
    },
    closeWorkspace: (session, workspace) => {
      calls.push(`launch.closeWorkspace(${session}, ${workspace})`);
      return true;
    },
    agentPanes: (session) => {
      calls.push(`launch.agentPanes(${session})`);
      return [...panes].filter(([, pane]) => pane.agent).map(([id]) => id);
    },
    agents: (session) => {
      calls.push(`launch.agents(${session})`);
      return [];
    },
    workspacePanes: (session, workspace) => {
      calls.push(`launch.workspacePanes(${session}, ${workspace})`);
      return [`${workspace}:p1`];
    },
    paneText: (session, pane) => {
      calls.push(`launch.paneText(${session}, ${pane})`);
      return panes.get(pane)?.text ?? '';
    },
    foreground: (session) => {
      calls.push(`launch.foreground(${session})`);
      return ['claude'];
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { launch: recordRenames(launch), creates };
}

function upSources(calls: string[], launch: Launch): UpSources {
  return {
    sessionRunning: (session) => {
      calls.push(`sessionRunning(${session})`);
      return true;
    },
    sessionState: (session) => {
      calls.push(`sessionState(${session})`);
      return 'running';
    },
    agents: (session) => {
      calls.push(`agents(${session})`);
      return [];
    },
    workspaces: () => {
      calls.push('workspaces');
      return [];
    },
    home,
    now: () => NOW,
    sleep: async () => {},
    alive: () => false,
    doctor: recordingDoctor(calls),
    launch,
  };
}

function addSources(calls: string[], launch: Launch): AddSources {
  return {
    home,
    sessionState: (session) => {
      calls.push(`sessionState(${session})`);
      return 'running';
    },
    agents: (session) => {
      calls.push(`agents(${session})`);
      return [];
    },
    workspaces: () => {
      calls.push('workspaces');
      return [];
    },
    doctor: recordingDoctor(calls),
    now: () => NOW,
    launch,
  };
}

describe("a placed lead's aimed flags are refused before the terminal host is asked", () => {
  test('up --file at another project: the bare refusal, no host call, the aimed project untouched', async () => {
    const calls: string[] = [];
    const before = homeTree();
    const stateBefore = readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
    const io = placedLeadIo(calls);
    const code = await runUp(['--file', flaggedFile], io, upSources(calls, recordingLaunch(calls).launch));
    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('deny\n');
    // No host read ran: no session asked, no agent list, no launch seam, no doctor, no walk.
    expect(calls).toEqual([]);
    // The aimed project was never read or written: its bytes stand and nothing was made beside them.
    expect(readFileSync(flaggedFile, 'utf8')).toBe('format: [\n');
    expect(readdirSync(join(flaggedRoot, '.agents'))).toEqual(['team.yaml']);
    // And the run left no trace of its own anywhere: no request, no log, no state change.
    expect(homeTree()).toEqual(before);
    expect(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')).toBe(stateBefore);
  });

  test('up --session at another team: the bare refusal, no host call, nothing written', async () => {
    const calls: string[] = [];
    const before = homeTree();
    const stateBefore = readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
    const io = placedLeadIo(calls);
    const code = await runUp(['--session', 'elsewhere'], io, upSources(calls, recordingLaunch(calls).launch));
    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('deny\n');
    expect(calls).toEqual([]);
    expect(homeTree()).toEqual(before);
    expect(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')).toBe(stateBefore);
  });

  test("add --file at another project: the owner's sentence, no host call, the aimed project untouched", async () => {
    const calls: string[] = [];
    const before = homeTree();
    const stateBefore = readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
    const io = placedLeadIo(calls);
    const code = await runAdd(['--file', flaggedFile, 'worker'], io, addSources(calls, recordingLaunch(calls).launch));
    expect(code).toBe(1);
    expect(io.err).toBe(`team add: --file is the owner's, from a terminal outside herdr; this call is ${LEAD}\n`);
    expect(calls).toEqual([]);
    expect(readFileSync(flaggedFile, 'utf8')).toBe('format: [\n');
    expect(readdirSync(join(flaggedRoot, '.agents'))).toEqual(['team.yaml']);
    expect(homeTree()).toEqual(before);
    expect(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')).toBe(stateBefore);
  });

  test("add --session at another team: the owner's sentence, no host call, nothing written", async () => {
    const calls: string[] = [];
    const before = homeTree();
    const stateBefore = readFileSync(join(root, '.agents', 'team.state.json'), 'utf8');
    const io = placedLeadIo(calls);
    const code = await runAdd(['worker', '--session', 'elsewhere'], io, addSources(calls, recordingLaunch(calls).launch));
    expect(code).toBe(1);
    expect(io.err).toBe(`team add: --session is the owner's, from a terminal outside herdr; this call is ${LEAD}\n`);
    expect(calls).toEqual([]);
    expect(homeTree()).toEqual(before);
    expect(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')).toBe(stateBefore);
  });

  test('the own-team add is still admitted: worker is readied from the lead pane', async () => {
    // The fence only holds the aimed flags: inside its own team the lead's add runs as before —
    // the host is asked, the seat is made ready, and no warning is printed.
    const calls: string[] = [];
    const made = recordingLaunch(calls);
    const io = placedLeadIo(calls);
    const code = await runAdd(['worker'], io, addSources(calls, made.launch));
    expect(code, io.out + io.err).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toContain('worker: ready\n');
    expect(made.creates).toEqual(['worker']);
    expect(readState(join(root, '.agents')).sessions[SESSION]?.seats.worker?.stage).toBe('ready');
    expect(calls.length).toBeGreaterThan(0);
  });
});
