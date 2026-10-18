// A drifted model or effort is closed only at an idle prompt, then launched again. A ready
// seat that `up` leaves alone keeps the launch record, including a lead.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runReload, USAGE, type ReloadSources } from '../src/commands/reload.ts';
import { generalBriefId } from '../src/launch/general-brief.ts';
import { RELOAD_OUTPUT_SCHEMA } from '../src/output/schema.ts';
import { readRecord } from '../src/send/record.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { findAgent } from '../src/registry/agents.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-14T09:00:00Z');
const IDLE = CLAUDE_IDLE;
const OWNER = { kind: 'owner' as const };
const LEAD = { kind: 'seat' as const, name: 'lead', pane: 'lead-pane', session: 'alpha' };

let base: string;
let root: string;
let dir: string;
let home: string;
let lobby: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function seat(name: string, role: string, effort: string, model = 'Claude Opus', version = '5.5'): string {
  return [
    `  - role: ${role}`,
    `    name: ${name}`,
    `    label: ${name}`,
    '    cli: claude-code',
    '    vendor: anthropic',
    `    model: ${model}`,
    `    version: "${version}"`,
    '    launch: claude --model claude-opus-5-5',
    `    effort: ${effort}`,
    '    mode: shared',
    '    cwd: .',
  ].join('\n');
}

function teamYaml(scope: string[], model = 'Claude Opus', version = '5.5'): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
session: alpha
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${seat('lead', 'coordinator', 'high', model, version)}
${seat('worker', 'implementer', 'high', model, version)}
grant:
  session: alpha
  seat: lead
  scope:
${scope.map((act) => `    - ${act}`).join('\n')}
`;
}

/** The same team with no `grant` section: the map's `reload` row is the only door. */
function withoutGrant(): string {
  const text = teamYaml(['reload']);
  return `${text.slice(0, text.indexOf('\ngrant:'))}\n`;
}

function approve(text = teamYaml(['reload'])): void {
  const path = join(dir, 'team.yaml');
  writeFileSync(path, text);
  const loaded = loadTeamFile(root, { file: path, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
}

function remember(name: string, effort: string | undefined, version = '5.5', model = 'Claude Opus'): void {
  updateState(dir, (file) => {
    const session = (file.sessions.alpha ??= emptySession());
    session.watch = { pid: 1, heartbeat: NOW.toISOString() };
    session.seats[name] = {
      stage: 'ready',
      pane: `${name}-pane`,
      workspace: `${name}-ws`,
      cli: 'claude-code',
      launched: { shell: 1, cli: [2] },
      model,
      version,
      launch_line: 'claude --model claude-opus-5-5',
      ...(effort === undefined ? {} : { effort }),
    };
  });
}

/** A launch record from before the record kept a model: ready, on its pane, with no model. */
function forget(name: string): void {
  updateState(dir, (file) => {
    (file.sessions.alpha ??= emptySession()).seats[name] = {
      stage: 'ready', pane: `${name}-pane`, workspace: `${name}-ws`, launched: { shell: 1, cli: [2] },
    };
  });
}

function logText(): string {
  try {
    return readFileSync(join(dir, 'team.log'), 'utf8');
  } catch {
    return '';
  }
}

function harness(options: { status?: string; text?: string; create?: boolean; present?: boolean; after?: string } = {}): {
  sources: ReloadSources;
  closed: string[];
  commands: string[];
} {
  const panes = new Map<string, string>();
  const closed: string[] = [];
  const commands: string[] = [];
  let clock = NOW.getTime();
  let n = 0;
  const text = options.text ?? IDLE;
  const launch: Launch = {
    sessionState: () => 'running',
    startServer: () => true,
    sessionUp: () => true,
    createWorkspace() {
      if (options.create === false) return null;
      n += 1;
      const pane = `made-${n}`;
      panes.set(pane, IDLE);
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session, pane, command) {
      commands.push(command);
      // The relaunched CLI draws its own model on the status row. `after` is the screen the new
      // pane shows instead — one no profile reads, for a relaunch that never comes back.
      if (options.after === undefined) panes.set(pane, command.includes('sonnet') ? IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5') : IDLE);
      else panes.set(pane, options.after);
      return true;
    },
    renameAgent: () => true,
    closeWorkspace(_session, workspace) {
      closed.push(workspace);
      return true;
    },
    agentPanes: () => [...panes.keys()],
    agents: () => options.present === false ? [] : [
      { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: options.status ?? 'idle', cwd: null },
      { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: options.status ?? 'idle', cwd: null },
    ] satisfies HerdrAgent[],
    workspacePanes(_session, workspace) {
      if (workspace === 'lead-ws') return ['lead-pane'];
      if (workspace === 'worker-ws') return ['worker-pane'];
      return [`made-${n}`];
    },
    paneText(_session, pane) {
      return panes.get(pane) ?? text;
    },
    foreground: () => ['claude'],
    processInfo: () => ({ shell: 1, foreground: [1, 2] }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { sources: { launch, home, now: () => new Date(clock) }, closed, commands };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-reload-')));
  root = join(base, 'acme');
  dir = join(root, '.agents');
  home = join(base, 'home');
  lobby = join(home, '.config', 'team', 'lobby');
  mkdirSync(dir, { recursive: true });
  mkdirSync(lobby, { recursive: true });
  chmodSync(lobby, 0o700);
  git(base, 'init', '-q', '--bare', '-b', 'main', join(base, 'remote.git'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  approve();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('team reload', () => {
  test('an effort-only edit at an idle prompt closes once and stores the new effort', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    const stored = readState(dir).sessions.alpha?.seats.worker;
    expect({ code, closed, effort: stored?.effort, model: stored?.model, line: logText() }).toEqual({
      code: 0,
      closed: ['worker-ws'],
      effort: 'high',
      model: 'Claude Opus',
      line: expect.stringContaining('reload [owner] worker: effort'),
    });
    expect(logText().match(/reload \[owner\] worker: effort/g)).toHaveLength(1);
  });

  test('model and effort together are one close and one line naming both', async () => {
    remember('worker', 'low', '5.4');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('reload [owner] worker: model; effort');
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ effort: 'high', version: '5.5' });
  });

  test('unsent text closes nothing and writes no log', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ text: claudeBox('draft') });
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(1);
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });

  test("a human seat is refused before anything is read, closed or launched", async () => {
    remember('worker', 'low');
    approve(teamYaml(['reload']).replace('    name: worker\n', '    name: worker\n    human: true\n'));
    const { sources, closed, commands } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toContain("worker is a human's pane: nothing is typed into it or launched over it; left as it is");
    expect(closed).toEqual([]);
    expect(commands).toEqual([]);
    // The record is untouched: no close, no relaunch, and the file's drift stays unread.
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
  });

  test('an installed version outside the tested range closes nothing', async () => {
    remember('worker', 'low');
    const { sources, closed, commands } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, { ...sources, version: () => '2.2.0' });
    expect(code).toBe(1);
    expect(closed).toEqual([]);
    expect(commands).toEqual([]);
    expect(io.err).toContain('claude 2.2.0 is newer than the tested 2.1.288 to 2.1.302; its ready screen may not be recognised, so nothing closed');
    // The record and the log are untouched: the seat is still the one the file's last run made.
    expect(readState(dir).sessions.alpha?.seats.worker?.effort).toBe('low');
    expect(logText()).toBe('');
  });

  test('a version that cannot be read refuses nothing', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, OWNER), { ...sources, version: () => null });
    expect(code).toBe(0);
    expect(closed).toEqual(['worker-ws']);
  });

  test('a relaunch that does not reach ready records the seat as stopped', async () => {
    remember('worker', 'low');
    // The new pane draws a screen no profile reads and herdr answers no status for it: the ready
    // wait times out, and the seat is left at "launched".
    const { sources, closed } = harness({ after: 'no prompt here' });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code).toBe(1);
    expect(closed).toEqual(['worker-ws']);
    expect(io.err).toContain('the close happened and the new launch did not reach ready');
    // The registry says down: the seat the run registered at its create step is stopped, and its
    // pane is cleared, because the relaunch it was handed to never reached ready.
    const record = findAgent(home, { team: teamIdOf(root), seat: 'worker' });
    expect({ lifecycle: record?.lifecycle, pane: record?.reach.pane }).toEqual({ lifecycle: 'stopped', pane: null });
  });

  test('a working seat closes nothing and writes no log', async () => {
    remember('worker', 'low');
    const { sources, closed } = harness({ status: 'working' });
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(1);
    expect(closed).toEqual([]);
    expect(logText()).toBe('');
  });

  test('a matching record exits 0 and writes nothing', async () => {
    remember('worker', 'high');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err, closed, log: logText() }).toEqual({ code: 0, err: '', closed: [], log: '' });
    expect(io.out).toContain('already running what the file declares');
  });

  test('a ready seat with no recorded model records what its screen shows and closes nothing', async () => {
    forget('worker');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err, closed }).toEqual({ code: 0, err: '', closed: [] });
    expect(io.out).toContain(
      'its launch record held no model; recorded Claude Opus 5.5 from its screen and effort high from the file; '
      + 'it is already running what the file declares',
    );
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ model: 'Claude Opus', version: '5.5', effort: 'high' });
  });

  test('a ready seat with no recorded model whose screen names none records the file, and says so', async () => {
    // A claude-code seat declared on another maker's model: its screen names no model this
    // profile can read, so the team file's values stand.
    approve(teamYaml(['reload'], 'DeepSeek Flash', '4.1'));
    forget('worker');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err, closed }).toEqual({ code: 0, err: '', closed: [] });
    expect(io.out).toContain(
      "its launch record held no model; recorded the file's DeepSeek Flash 4.1 and effort high, since its screen names none",
    );
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ model: 'DeepSeek Flash', version: '4.1', effort: 'high' });
  });

  test('a ready seat with no recorded model whose screen names another model reloads', async () => {
    forget('worker');
    const { sources, closed } = harness({ text: IDLE.replaceAll('Opus 5.5', 'Sonnet 5.5') });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(io.out).toContain('its launch record held no model; its screen shows Claude Sonnet 5.5 and effort high from the file; reloading');
    expect(readState(dir).sessions.alpha?.seats.worker).toMatchObject({ model: 'Claude Opus', version: '5.5', effort: 'high' });
  });

  test('a record spelling the same model in another word order is no drift', async () => {
    // The record holds the version inside the model name; the file writes the split spelling.
    // The words and the version are the same, so nothing is closed.
    remember('worker', 'high', '5.5', 'Opus 5.5 Claude');
    const { sources, closed } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err, closed, log: logText() }).toEqual({ code: 0, err: '', closed: [], log: '' });
    expect(io.out).toContain('already running what the file declares');
  });

  test('a record naming another model still drifts', async () => {
    remember('worker', 'high', '5.5', 'Claude Sonnet');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('reload [owner] worker: model');
    expect(logText()).not.toContain('effort');
    expect(readState(dir).sessions.alpha?.seats.worker?.model).toBe('Claude Opus');
  });

  test('the owner reloads a lead that up left ready', async () => {
    remember('lead', 'low');
    remember('worker', 'high');
    const closed: string[] = [];
    const up: UpSources = {
      sessionRunning: () => true,
      sessionState: () => 'running',
      agents: () => [
        { name: 'lead', agent: 'claude', pane: 'lead-pane', workspace: 'lead-ws', status: 'idle', cwd: null },
        { name: 'worker', agent: 'claude', pane: 'worker-pane', workspace: 'worker-ws', status: 'idle', cwd: null },
      ],
      alive: () => true,
      home,
      now: () => NOW,
      launch: {
        sessionState: () => 'running',
        startServer: () => false,
        sessionUp: () => true,
        createWorkspace: () => null,
        paneRun: () => false,
        renameAgent: () => false,
        closeWorkspace(_session, workspace) {
          closed.push(workspace);
          return true;
        },
        agentPanes: () => [],
        agents: () => [],
        paneText: () => IDLE,
        foreground: () => ['claude'],
        sleep: async () => {},
        now: () => NOW,
      },
    };
    const upCode = await runUp([], testIo(root, OWNER), up);
    expect(upCode).toBe(0);
    expect(closed).toEqual([]);
    expect(readState(dir).sessions.alpha?.seats.lead?.effort).toBe('low');
    const { sources, closed: reclosed } = harness();
    const code = await runReload(['lead'], testIo(root, OWNER), sources);
    expect(code).toBe(0);
    expect(reclosed).toEqual(['lead-ws']);
    expect(readState(dir).sessions.alpha?.seats.lead?.effort).toBe('high');
  });

  test('a granted reload of the caller is refused, and a grant of up does not include reload', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const self = harness();
    const selfIo = testIo(root, LEAD);
    expect(await runReload(['lead'], selfIo, self.sources)).toBe(1);
    expect(selfIo.err).toContain('does not close the caller\'s seat');
    expect(self.closed).toEqual([]);
    approve(teamYaml(['up']));
    const scope = harness();
    const scopeIo = testIo(root, LEAD);
    expect(await runReload(['worker'], scopeIo, scope.sources)).toBe(1);
    expect(scopeIo.err).toContain('does not list `reload`');
    expect(scope.closed).toEqual([]);
    expect(logText()).toBe('');
  });

  test('a granted reload runs the live file\'s edited launch line with no approval of the edit', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const line = 'claude --model claude-sonnet-5-5';
    const text = readFileSync(join(dir, 'team.yaml'), 'utf8')
      .replaceAll('model: Claude Opus', 'model: Claude Sonnet')
      .replaceAll('launch: claude --model claude-opus-5-5', `launch: ${line}`);
    writeFileSync(join(dir, 'team.yaml'), text);
    const { sources, closed, commands } = harness();
    const io = testIo(root, LEAD);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(line);
    expect(readState(dir).sessions.alpha?.seats.worker?.launch_line).toContain(line);
    expect(logText()).toContain('grant [grant] lead reload: worker model');
  });

  test('a relaunch names the seat\'s claude session the way up, add and restart do', async () => {
    remember('worker', 'low');
    const { sources, closed, commands } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker'], io, sources);
    expect(code, io.err).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(commands).toHaveLength(1);
    // The file's own launch line, with the seat's readable name appended: a session reloaded by
    // this command shows the same name in its prompt box and on the messages it receives that a
    // fresh `up` would have given it. The fixture's seat writes no nickname, so `auto` reads the
    // seat name.
    expect(commands[0]).toContain('--model claude-opus-5-5');
    expect(commands[0]).toContain('--name worker');
  });

  test('a granted reload of another seat logs the grant and the difference', async () => {
    remember('lead', 'low');
    remember('worker', 'low');
    const { sources, closed } = harness();
    const code = await runReload(['worker'], testIo(root, LEAD), sources);
    expect(code).toBe(0);
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('grant [grant] lead reload: worker effort');
    expect(logText()).not.toContain('reload [owner]');
  });

  test('a lead reloads through the map\'s row with no grant in the file', async () => {
    approve(withoutGrant());
    remember('lead', 'high');
    remember('worker', 'low');
    const { sources, closed } = harness();
    const io = testIo(root, LEAD);
    const code = await runReload(['worker'], io, sources);
    expect({ code, err: io.err, closed }).toEqual({ code: 0, err: '', closed: ['worker-ws'] });
    expect(logText()).toContain('reload [lead] worker: effort');
  });

  test('dev mode lifts the reload caller gate once, and a grant word stays a refusal', async () => {
    remember('lead', 'high');
    remember('worker', 'low');
    const helper = { kind: 'seat' as const, name: 'helper', pane: 'w9:p1', session: 'alpha' };
    const CALLER_LINE = 'only the seat the grant names runs this: this call is helper';

    // Unset: the grant's caller sentence refuses, and nothing closes.
    const bare = testIo(root, helper);
    const refused = harness();
    expect(await runReload(['worker'], bare, refused.sources)).toBe(1);
    expect(bare.err).toBe(`team reload: ${CALLER_LINE}\n`);
    expect(refused.closed).toEqual([]);

    // Set to exactly 1: the gate warns, logs, and the run continues past it.
    const io = testIo(root, helper);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const warned = harness();
    expect(await runReload(['worker'], io, warned.sources)).toBe(0);
    expect(io.err).toBe(`team reload: warning: ${CALLER_LINE}; dev mode continues\n`);
    expect(warned.closed).toEqual(['worker-ws']);
    expect(logText()).toContain(`reload [helper] warning: ${CALLER_LINE}; dev mode continues\n`);

    // A grant in the file that leaves `reload` out of its scope is a fourth gate, not the
    // caller's: dev mode leaves it where it is.
    approve(teamYaml(['up']));
    const scoped = testIo(root, LEAD);
    scoped.env = { TEAMCLI_DEV_MODE: '1' };
    const kept = harness();
    expect(await runReload(['worker'], scoped, kept.sources)).toBe(1);
    expect(scoped.err).toBe('team reload: the grant does not list `reload`\n');
    expect(kept.closed).toEqual([]);
  });

  test('dev mode lifts the omitted grant too, where the file grants nothing at all', async () => {
    approve(withoutGrant());
    remember('worker', 'low');
    const helper = { kind: 'seat' as const, name: 'helper', pane: 'w9:p1', session: 'alpha' };
    const io = testIo(root, helper);
    io.env = { TEAMCLI_DEV_MODE: '1' };
    const { sources, closed } = harness();
    expect(await runReload(['worker'], io, sources)).toBe(0);
    expect(io.err).toBe('team reload: warning: the file grants nothing; dev mode continues\n');
    expect(closed).toEqual(['worker-ws']);
    expect(logText()).toContain('reload [helper] warning: the file grants nothing; dev mode continues\n');
  });

  test('--json carries the action envelope under the registered schema', async () => {
    remember('worker', 'low');
    const { sources } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker', '--json'], io, sources);
    expect(code).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, RELOAD_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({
      schema: { name: 'team.reload', version: 1 },
      format: 1,
      dry_run: false,
      status: 'reloaded',
      action_summary: 'team reload: worker reloaded',
      project: 'acme',
      session: 'alpha',
      seat: 'worker',
    });
    expect(typeof doc.pane).toBe('string');
  });

  test('--json: a matching seat is status same, exit 0', async () => {
    remember('worker', 'high');
    const { sources } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker', '--json'], io, sources);
    expect(code).toBe(0);
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, RELOAD_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({ status: 'same', seat: 'worker', pane: 'worker-pane' });
    expect(doc.action_summary).toBe('team reload: worker is already running what the file declares');
  });

  test('--json: a matching seat is still a repair: the general brief is delivered and recorded', async () => {
    remember('worker', 'high');
    const { sources } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker', '--json'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, RELOAD_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({ status: 'same', seat: 'worker' });
    expect(doc).not.toHaveProperty('notes');
    // The drop is on disk and the session records the delivery: `team check`'s repair works
    // on a seat whose model, version and effort already match the file.
    const path = join(root, '.agents', 'send-drops', 'alpha', 'worker', generalBriefId());
    const looked = readRecord(path, generalBriefId());
    expect(looked.ok && looked.record?.payload).toMatchObject({ to: 'worker', session: 'alpha' });
    expect(readState(dir).sessions.alpha?.briefs?.worker).toEqual({ id: generalBriefId(), at: NOW.toISOString() });
  });

  test('--json: a brief that cannot be written is a note in the document', async () => {
    remember('worker', 'high');
    const path = join(root, '.agents', 'send-drops', 'alpha', 'worker', generalBriefId());
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path);
    const { sources } = harness();
    const io = testIo(root, OWNER);
    const code = await runReload(['worker', '--json'], io, sources);
    expect(code, io.out + io.err).toBe(0);
    expect(io.err).toBe('');
    const doc = assertMatchesOutputSchema<Record<string, unknown>>(io.out, RELOAD_OUTPUT_SCHEMA);
    expect(doc).toMatchObject({ status: 'same', seat: 'worker' });
    expect(doc.notes).toEqual([
      'worker: the general seat brief was not delivered (the record path is a folder)',
    ]);
    expect(logText()).toContain('worker: the general seat brief was not delivered');
  });

  test('--json: a refusal writes the team.error envelope on stdout, stderr empty', async () => {
    remember('worker', 'low');
    const { sources } = harness({ status: 'working' });
    const io = testIo(root, OWNER);
    const code = await runReload(['worker', '--json'], io, sources);
    expect(code).toBe(1);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'reload.working', messageContains: 'is working; nothing closed' });
  });

  test('--json: a bad invocation is the invocation row, with no usage in the document', async () => {
    const io = testIo(root, OWNER);
    const code = await runReload(['--bogus', '--json'], io, { ...harness().sources });
    expect(code).toBe(2);
    expect(io.err).toBe('');
    assertJsonErrorShape(io.out, { id: 'reload.invocation', messageContains: 'unknown option --bogus' });
    expect(USAGE).toContain('Exits 0 when the seat is reloaded');
  });
});
