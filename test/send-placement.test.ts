// A placed pane keeps its own team when the shell sits in another team's bound root.
// The folder decides only when the pane places nobody. Names here are synthetic.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CallerSources } from '../src/caller.ts';
import { runSend, type SendHost } from '../src/commands/send.ts';
import { lobbyDir } from '../src/lobby/gate.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { NativePane } from '../src/send/native.ts';
import type { SendOutcome } from '../src/send/uds.ts';
import { updateState } from '../src/state.ts';
import { recordBody, testIo } from './helpers.ts';

const NOW = new Date('2026-10-05T04:00:00.000Z');
const PANE_LEAD = 'pane-lead';
const PANE_SCRIBE = 'pane-scribe';
const PANE_BLANK = 'pane-blank';

let base = '';

afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  base = '';
});

function teamYaml(root: string, project: string, session: string, lead: string, other: string): string {
  const lobby = lobbyDir(join(base, 'home'));
  return `format: 1
project: ${project}
coordinator: ${lead}
operator: ${lead}
session: ${session}
workspace:
  mode: shared
trust:
  - ${lobby}
  - ${root}
seats:
  - role: coordinator
    name: ${lead}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
  - role: implementer
    name: ${other}
    cli: claude-code
    vendor: test
    model: Test
    version: "1"
    launch: claude
delivery_order: [mcp-inbox, typed]
`;
}

function plant(root: string, project: string, session: string, lead: string, other: string): void {
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, '.agents', 'team.yaml'), teamYaml(root, project, session, lead, other));
}

function agentFile(seat: string, team: string, session: string, pane: string): string {
  const id = `agt_${Buffer.from(seat).toString('hex').slice(0, 12).padEnd(12, '0')}`;
  const file = join(base, 'home', '.config', 'team', 'agents', `${id}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `id: "${id}"`,
      `name: "${seat}"`,
      'signing:',
      '  model: "Test"',
      '  version: "1"',
      '  role: "coordinator"',
      'lab: "test"',
      'cli: "claude-code"',
      'launcher: null',
      'launch: "claude"',
      'reach:',
      `  team: "${team}"`,
      `  seat: "${seat}"`,
      `  session: "${session}"`,
      `  pane: "${pane}"`,
      '  address: null',
      'mcp: []',
      'skills: []',
      'lifecycle: "running"',
      'provenance:',
      '  registered_by: "team up"',
      '  registered_at: "2026-10-05T04:00:00.000Z"',
      '  updated_at: "2026-10-05T04:00:00.000Z"',
      '',
    ].join('\n'),
  );
  return id;
}

/** Two teams. Alpha records lead on pane-lead. Beta's root is the shell's cwd. */
function world(): { home: string; alpha: string; beta: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-send-place-')));
  const home = join(base, 'home');
  const alpha = join(base, 'alpha');
  const beta = join(base, 'beta');
  mkdirSync(lobbyDir(home), { recursive: true });
  plant(alpha, 'alpha', 'alpha', 'lead', 'scribe');
  plant(beta, 'beta', 'beta', 'other', 'spare');
  const alphaId = teamIdOf(alpha);
  const leadAgent = agentFile('lead', alphaId, 'alpha', PANE_LEAD);
  const scribeAgent = agentFile('scribe', alphaId, 'alpha', PANE_SCRIBE);
  upsertTeam(home, alphaId, {
    project: 'alpha',
    entity: 'alpha',
    session: 'alpha',
    root: alpha,
    lobby: lobbyDir(home),
    roster: [
      { agent: leadAgent, seat: 'lead', role: 'coordinator', leads: true },
      { agent: scribeAgent, seat: 'scribe', role: 'implementer', leads: false },
    ],
    lifecycle: 'running',
    by: 'test',
  });
  upsertTeam(home, teamIdOf(beta), {
    project: 'beta',
    entity: 'beta',
    session: 'beta',
    root: beta,
    lobby: lobbyDir(home),
    roster: [{ agent: agentFile('other', teamIdOf(beta), 'beta', PANE_BLANK), seat: 'other', role: 'coordinator', leads: true }],
    lifecycle: 'running',
    by: 'test',
  });
  updateState(join(alpha, '.agents'), (state) => {
    state.sessions.alpha = {
      seats: { lead: { stage: 'launched', pane: PANE_LEAD, workspace: 'alpha' } },
      worktrees: {},
    };
  });
  return { home, alpha, beta };
}

function sources(named: boolean): CallerSources {
  const pane = named ? PANE_LEAD : PANE_BLANK;
  return {
    ancestors: () => [{ pid: 10, name: 'zsh' }, { pid: 2, name: 'herdr' }, { pid: 1, name: 'launchd' }],
    agents: () => [{
      name: named ? 'lead' : null,
      pane,
      agent: named ? 'claude' : null,
      workspace: 'ws-lead',
      status: 'idle',
      cwd: null,
    }],
    paneRootPid: (id) => (id === pane ? 10 : null),
    env: {},
    stdinIsTTY: false,
  };
}

function hostOf(home: string): SendHost {
  const native: NativePane = {
    typeText: () => false,
    pressEnter: () => false,
    status: () => 'idle',
    wait: async () => {},
  };
  return {
    agents: () => [
      { name: 'lead', pane: PANE_LEAD },
      { name: 'scribe', pane: PANE_SCRIBE },
    ],
    processInfo: () => ({ shell: 111, foreground: [222] }),
    socketsDir: join(base, 'sockets'),
    deliver: async (): Promise<SendOutcome> => ({ ok: true }),
    native,
    now: () => NOW,
    home,
  };
}

describe('send placement follows the pane', () => {
  test('a lead recorded on its pane is admitted from another team\'s folder', async () => {
    const { home, alpha, beta } = world();
    mkdirSync(join(base, 'sockets'), { recursive: true });
    const io = testIo(beta);
    io.callerSources = (session) => sources(session === 'alpha');

    const code = await runSend(['scribe', 'a note'], io, hostOf(home));

    expect(code).toBe(0);
    expect(io.out).toContain('team alpha, session "alpha"');
    const drops = join(alpha, '.agents', 'send-drops', 'alpha', 'scribe');
    const name = readdirSync(drops).find((one) => !one.includes('.'));
    expect(recordBody(join(drops, name as string))).toMatch(
      /^from (the file's seat )?lead — admitted by: .+\n\na note$/,
    );
  });

  test('an unnamed pane in another team\'s folder is still judged by that folder', async () => {
    const { home, alpha, beta } = world();
    mkdirSync(join(base, 'sockets'), { recursive: true });
    const io = testIo(beta);
    io.callerSources = () => sources(false);

    const code = await runSend(['scribe', 'a note'], io, hostOf(home));

    expect(code).toBe(1);
    expect(io.err).toContain(`it runs in pane ${PANE_BLANK}, whose agent has no herdr name`);
    expect(io.out).not.toContain('team alpha');
    expect(io.err).not.toContain('from lead');
    const drops = join(alpha, '.agents', 'send-drops', 'alpha', 'scribe');
    expect(() => readdirSync(drops)).toThrow();
  });
});
