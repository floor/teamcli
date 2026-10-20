// The project lead's reach is comms, and nothing else. The registry names it — `registerLaunch`,
// the writer `up` itself uses, is what writes the project's `lead` — and every command that
// starts, stops or changes a running team judges the caller by the target team's own file: the
// seat its `coordinator:` names, the seat its `operator:` names, or the owner. `up` and `grant`
// are the owner's alone. So the lead of one team of a project is refused on another team of the
// same project, by its own name, and the one thing that holds is admission: `team send` admits
// the project lead to a lead of its teams by the project rule, and a plain seat of another team
// of its entity by the entity's seat rule. Every sentence here is a
// command's own, from runs this test makes against the real registries the launch writes.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DoctorSources } from '../src/commands/doctor.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import { runDown, type DownSources } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readAgents, type Agent } from '../src/registry/agents.ts';
import { readProjects } from '../src/registry/projects.ts';
import { readTeams, teamIdOf } from '../src/registry/teams.ts';
import { registerLaunch } from '../src/registry/sync.ts';
import { admitSend, ENTITY_RULE, type AdmitContext } from '../src/send/admit.ts';
import type { NativePane } from '../src/send/native.ts';
import { emptySession, updateState } from '../src/state.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T09:00:00Z');
const PROJECT = 'acme';
// Both files name the entity's one session, so the walk places the caller in the session each
// command judges: a caller of another session is refused before its seat is even read, and this
// is the lead that is asked about, refused by name.
const SESSION = 'acme';
const LEAD_PANE = 'w1:p1';
const LEAD_ROOT = 4242;

let base: string;
let home: string;
let lobby: string;
let alphaRoot: string;
let bravoRoot: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, stdio: 'ignore', env: gitEnv(),
  });
}

function seat(name: string, role: string): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    '    model: Claude Opus',
    '    version: "5.5"',
    '    launch: claude --model claude-opus-5-5',
  ].join('\n');
}

/** The team that leads the project: `project_lead: true` is what makes the registry's project
 *  record name this team's coordinator as the project's lead. */
function alphaText(): string {
  return `format: 1
project: alpha
entity: ${PROJECT}
in_project: ${PROJECT}
project_lead: true
coordinator: lead
operator: helper
session: ${SESSION}
trust:
  - ${lobby}
  - ${alphaRoot}
workspace:
  mode: shared
seats:
${seat('lead', 'coordinator')}
${seat('helper', 'builder')}
`;
}

/** Another team of the same project: it leads nothing, and its own file names its own leads. */
function bravoText(): string {
  return `format: 1
project: bravo
entity: ${PROJECT}
in_project: ${PROJECT}
coordinator: chief
operator: pilot
session: ${SESSION}
trust:
  - ${lobby}
  - ${bravoRoot}
workspace:
  mode: shared
seats:
${seat('chief', 'coordinator')}
${seat('pilot', 'operator')}
${seat('helper', 'builder')}
`;
}

/** The registry, written the way `up` writes it: every seat registered at its launch, which is
 *  what makes the project record name the lead and the team records carry both rosters. */
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'pls-')));
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobbies', PROJECT);
  mkdirSync(lobby, { recursive: true });
  alphaRoot = join(base, 'alpha');
  bravoRoot = join(base, 'bravo');
  let pane = 0;
  for (const [root, text] of [[alphaRoot, alphaText()], [bravoRoot, bravoText()]] as const) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const loaded = loadTeamFile(root, { home });
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    for (const one of loaded.team.seats) {
      pane += 1;
      const made = registerLaunch({ home, team: loaded.team, root: loaded.root, by: 'team up' }, one, `w1:p${String(pane)}`);
      if ('note' in made) throw new Error(made.note);
    }
  }
  // The lead seat runs: the state records its pane in the session, so the one caller judged where
  // it stands is placed on the pane the state holds for it — never on a name alone.
  updateState(join(alphaRoot, '.agents'), (file) => {
    file.sessions[SESSION] = {
      ...emptySession(),
      seats: { lead: { stage: 'ready', pane: LEAD_PANE, workspace: 'lead-ws' } },
    };
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The caller: the lead seat of `alpha`, standing in the session both files name, on the pane its
 *  record was launched on. The placement is the real walk — herdr above the caller, the pane root
 *  among its ancestors, the agent list answering for the session asked — and the sessionless read
 *  answers for the machine's default session, which is this one: the same caller `up` reads with
 *  no session named, and the one `walkCaller` cannot place at all. */
function leadIo(cwd: string): ReturnType<typeof testIo> {
  const io = testIo(cwd);
  io.callerSources = (asked?: string) => {
    const here = asked === undefined || asked === SESSION;
    return {
      ancestors: () => [{ pid: LEAD_ROOT, name: 'zsh' }, { pid: 1, name: 'herdr' }],
      agents: () => (here ? [{ pane: LEAD_PANE, name: 'lead', agent: null, workspace: '', status: '', cwd }] : []),
      paneRootPid: (pane: string) => (here && pane === LEAD_PANE ? LEAD_ROOT : null),
      env: io.env,
      stdinIsTTY: false,
    };
  };
  return io;
}

function quietDoctor(): DoctorSources {
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

/** A launcher whose every effect would be recorded; a refused caller must leave it untouched. */
function quietLaunch(): Launch {
  return {
    sessionState: () => 'absent',
    startServer: () => true,
    sessionUp: () => false,
    createWorkspace: () => null,
    paneRun: () => true,
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => [],
    sleep: async () => {},
    now: () => NOW,
  };
}

function upSources(): UpSources {
  return {
    sessionRunning: () => true,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    home,
    standing: () => ({ kind: 'none' }),
    now: () => NOW,
  };
}

function downSources(): DownSources {
  return {
    sessionRunning: () => true,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => [],
    now: () => NOW,
    home,
  };
}

function addSources(): AddSources {
  return {
    home,
    sessionState: () => 'running',
    agents: () => [],
    workspaces: () => [],
    doctor: quietDoctor(),
    now: () => NOW,
    launch: quietLaunch(),
  };
}

function removeSources(): RemoveSources {
  return { ...downSources(), foreground: () => [] };
}

/** The seat's agent record, as the registry holds it. */
function agentOf(seatName: string, root: string): Agent {
  const found = readAgents(home).find((one) => one.reach.seat === seatName && one.reach.team === teamIdOf(root));
  if (!found) throw new Error(`no record for ${seatName} in ${root}`);
  return found;
}

function sendHost(): SendHost {
  const native: NativePane = { typeText: () => false, pressEnter: () => false, status: () => null, wait: async () => {} };
  return {
    agents: () => [],
    processInfo: () => null,
    socketsDir: join(base, 'sockets'),
    deliver: async () => ({ ok: true }),
    native,
    now: () => NOW,
    home,
  };
}

describe('the project lead changes nothing outside its own team', () => {
  test('the registry names this caller the project lead of its project', () => {
    const lead = agentOf('lead', alphaRoot);
    const project = readProjects(home)[PROJECT];
    expect(project?.lead).toBe(lead.id);
    expect([...(project?.teams ?? [])].sort()).toEqual([teamIdOf(alphaRoot), teamIdOf(bravoRoot)].sort());
  });

  test('up is the owner\'s: the dry run refuses the project lead by its own name', async () => {
    const io = leadIo(bravoRoot);
    const code = await runUp(['--dry-run'], io, upSources());
    expect(code).toBe(1);
    expect(io.out).toContain('! up would refuse: only the owner or `leads` starts the team; this call is lead\n');
  });

  test('down refuses the project lead on another team of its project', async () => {
    const io = leadIo(bravoRoot);
    const code = await runDown(['--dry-run'], io, downSources());
    expect(io.err).toBe('');
    expect(io.out).toContain('! down would refuse: only the owner or `leads` stops the team; this call is lead\n');
    expect(code).toBe(1);
  });

  test('add refuses the project lead on another team of its project', async () => {
    const io = leadIo(bravoRoot);
    const code = await runAdd(['helper'], io, addSources());
    expect(io.err).toBe('team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is lead\n');
    expect(code).toBe(1);
  });

  test('remove refuses the project lead on another team of its project', async () => {
    const io = leadIo(bravoRoot);
    const code = await runRemove(['helper'], io, removeSources());
    expect(io.err).toBe('team remove: only the owner or `leads` removes a seat; this call is lead\n');
    expect(code).toBe(1);
  });

  test('grant is the owner\'s: the refusal reads no session at all', async () => {
    const io = leadIo(bravoRoot);
    const code = await runGrant(['helper', '--scope', 'send'], io, { home });
    expect(io.err).toBe('team grant: only the owner runs this, from a terminal outside herdr; this call is unplaced (it runs under herdr)\n');
    expect(code).toBe(1);
  });

  test('and the same caller on its own team is still its own leads\' business', async () => {
    // The refusal is the caller's place in the chain, not its name: on `alpha` the very same seat
    // is the team's own coordinator, and a dry run of `down` then plans the stop.
    const io = leadIo(alphaRoot);
    const code = await runDown(['--dry-run'], io, downSources());
    expect(io.err).toBe('');
    expect(io.out).not.toContain('would refuse');
    expect(code).toBe(0);
  });
});

describe('the project lead reaches the leads of its teams — by admission alone', () => {
  const context = (): AdmitContext => ({ projects: readProjects(home), crossTeams: {} });

  test('admission admits the project lead to a lead by the project rule, and to a plain seat by the entity rule', () => {
    const records = readTeams(home);
    expect(admitSend(agentOf('lead', alphaRoot), agentOf('chief', bravoRoot), records, undefined, context())).toEqual({
      ok: true,
      rule: 'the project lead and the leads of its teams',
    });
    // The plain seat is no project pair: the project rules never name it. Both teams are one
    // entity's, so the entity's seat rule admits it, in its own name.
    const plain = admitSend(agentOf('lead', alphaRoot), agentOf('helper', bravoRoot), records, undefined, context());
    expect(plain).toEqual({ ok: true, rule: ENTITY_RULE });
  });

  test('team send admits it to that lead: a dry run, exit 0', async () => {
    const io = leadIo(alphaRoot);
    const code = await runSend(['chief@bravo', 'the brief', '--dry-run'], io, sendHost());
    expect(io.err).toBe('');
    expect(io.out).toContain('chief: dry-run:');
    expect(io.out).toContain('nothing was written');
    expect(code).toBe(0);
  });

  test('and the same command reaches a plain seat of that team by the entity rule', async () => {
    const io = leadIo(alphaRoot);
    const code = await runSend(['helper@bravo', 'the brief', '--dry-run'], io, sendHost());
    expect(io.err).toBe('');
    expect(io.out).toContain('helper: dry-run:');
    expect(code).toBe(0);
  });
});
