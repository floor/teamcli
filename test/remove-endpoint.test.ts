// What `team remove` does with a managed Codex endpoint. A removal that stops the seat's CLI
// stops the endpoint its launch recorded — after the CLI exits, with the same proof `down`
// uses — and clears the record only once no process is left. A removal that leaves the pane
// running cannot keep the record anywhere, so a managed seat is left as it is. Nothing here
// starts a real server: the endpoint stop is injected, and every scene pins where it was
// called and what the state and the file held at that moment.
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { realSources as downSources, type DownLaunch } from '../src/commands/down.ts';
import { runRemove, type RemoveSources } from '../src/commands/remove.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { readState, emptySession, updateState } from '../src/state.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { EndpointStopRead } from '../src/launch/codex-endpoint.ts';
import { CLAUDE_IDLE, claudeBox, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-15T11:30:00Z');
const owner = { kind: 'owner' } as const;
const BINDING = 'prs_ab12cd34ef56';
const ENDPOINT = {
  url: 'unix:///tmp/acme/run/acme/worker/ab12cd34ef56.sock',
  binding: BINDING,
  pid: 4242,
  started_at: '2026-10-15T11:00:00Z',
};

type Place = { base: string; root: string; home: string; file: string; dir: string };

const LEAD = `  - role: coordinator
    name: lead
    label: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function workerLine(extra = ''): string {
  return `  - role: implementer
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${extra}`;
}

function teamText(workerExtra = ''): string {
  return `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
${LEAD}${workerLine(workerExtra)}`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
  });
}

function layout(workerExtra = ''): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-remove-endpoint-')));
  const root = join(base, 'acme');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'README.md'), 'acme\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  const file = join(root, '.agents', 'team.yaml');
  const text = teamText(workerExtra);
  writeFileSync(file, text);
  const loaded = loadTeamFile(root, { file, home });
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
  writeApproval(
    storePath(loaded.team.project, loaded.root, home),
    { approval: approvalOf(loaded.team, loaded.root, NOW), file: text },
    loaded.team.seats,
    home,
  );
  return { base, root, home, file, dir: join(root, '.agents') };
}

function seedEndpoint(place: Place, record = ENDPOINT): void {
  updateState(place.dir, (state) => {
    const session = (state.sessions.acme ??= emptySession());
    session.seats.worker = { stage: 'ready', pane: 'w1:p1', presence_binding: BINDING, codex_endpoint: { ...record } };
  });
}

const agent = (name: string, status = 'idle'): HerdrAgent => ({
  name, agent: 'claude', pane: 'w1:p1', workspace: 'w1', status, cwd: null,
});

function launchOf(over: Partial<DownLaunch> = {}): DownLaunch {
  return {
    typeText: () => true,
    sendKey: () => true,
    pressEnter: () => true,
    agentPanes: () => ['w1:p1'],
    closeWorkspace: () => true,
    stopSession: () => true,
    deleteSession: () => true,
    kill: () => true,
    sleep: async () => {},
    now: () => NOW,
    ...over,
  };
}

type StopSeen = { dir: string; session: string; seat: string; recordPresent: boolean };

function sourcesOf(
  place: Place,
  over: Partial<RemoveSources> = {},
  stop?: (seen: { dir: string; session: string; seat: string }) => EndpointStopRead,
): { sources: RemoveSources; calls: StopSeen[] } {
  const calls: StopSeen[] = [];
  const sources: RemoveSources = {
    ...downSources,
    home: place.home,
    sessionRunning: () => false,
    agents: () => [],
    screen: () => ({ kind: 'idle' }),
    screenText: () => undefined,
    status: () => 'idle',
    foreground: () => ['claude'],
    foregroundCwd: () => null,
    now: () => NOW,
    sleep: async () => {},
    ...(stop === undefined
      ? {}
      : {
          codexEndpoint: {
            stop: (seen) => {
              const recordPresent = readState(place.dir).sessions.acme?.seats?.worker?.codex_endpoint !== undefined;
              calls.push({ ...seen, recordPresent });
              return stop(seen);
            },
          },
        }),
    ...over,
  };
  return { sources, calls };
}

function stateSeat(place: Place) {
  return readState(place.dir).sessions.acme?.seats?.worker;
}

let places: Place[] = [];
function place(workerExtra = ''): Place {
  const made = layout(workerExtra);
  places.push(made);
  return made;
}
afterEach(() => {
  for (const made of places) rmSync(made.base, { recursive: true, force: true });
  places = [];
});

describe('a removal that stops the seat’s CLI', () => {
  test('it stops the recorded endpoint before the state record goes', async () => {
    const at = place();
    seedEndpoint(at);
    const { sources, calls } = sourcesOf(at, {}, () => ({ stopped: true }));
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker'], io, sources)).toBe(0);
    expect(calls).toEqual([{ dir: at.dir, session: 'acme', seat: 'worker', recordPresent: true }]);
    expect(stateSeat(at)).toBeUndefined();
    expect(readFileSync(at.file, 'utf8')).not.toContain('name: worker');
  });

  test('an endpoint that cannot be proven keeps its record and fails the removal', async () => {
    const at = place();
    seedEndpoint(at);
    const { sources } = sourcesOf(at, {}, () => ({
      stopped: false,
      why: 'the recorded process cannot be proven to serve this endpoint; it was not signalled',
    }));
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker'], io, sources)).toBe(1);
    expect(io.err).toContain('the recorded process cannot be proven');
    expect(io.err).toContain('left as it is');
    expect(stateSeat(at)?.codex_endpoint).toMatchObject({ pid: ENDPOINT.pid });
    expect(readFileSync(at.file, 'utf8')).toContain('name: worker');
  });

  test('the refusal carries the contract row under --json', async () => {
    const at = place();
    seedEndpoint(at);
    const { sources } = sourcesOf(at, {}, () => ({ stopped: false, why: 'not this process' }));
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker', '--json'], io, sources)).toBe(1);
    expect(JSON.parse(io.out).error.id).toBe('remove.endpoint');
    expect(stateSeat(at)?.codex_endpoint).toBeDefined();
  });

  test('a seat whose CLI already exited is stopped through the same proof', async () => {
    const at = place();
    seedEndpoint(at);
    const { sources, calls } = sourcesOf(at, { agents: () => [] }, () => ({ stopped: true }));
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker'], io, sources)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(stateSeat(at)).toBeUndefined();
  });

  test('a running CLI is exited first, and the endpoint stops after it', async () => {
    const at = place();
    seedEndpoint(at);
    let typed = '';
    let shelled = false;
    const { sources, calls } = sourcesOf(at, {
      sessionRunning: () => true,
      agents: () => [agent('worker')],
      screen: () => ({ kind: 'idle' }),
      screenText: () => (typed === '' ? CLAUDE_IDLE : claudeBox(typed)),
      foreground: () => (shelled ? ['zsh'] : ['claude']),
      launch: launchOf({
        typeText: (_session, _pane, text) => { typed = text; return true; },
        pressEnter: () => { shelled = true; return true; },
      }),
    }, () => {
      // The CLI's exit is confirmed before the endpoint is touched: the pane read as its shell.
      expect(shelled).toBe(true);
      return { stopped: true };
    });
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker'], io, sources)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(stateSeat(at)).toBeUndefined();
  });
});

describe('a removal that leaves the pane running', () => {
  test('a managed seat is left as it is: its record cannot outlive the seat', async () => {
    const at = place('    human: true\n');
    seedEndpoint(at);
    const { sources, calls } = sourcesOf(at, {
      sessionRunning: () => true,
      agents: () => [agent('worker')],
    }, () => ({ stopped: true }));
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker'], io, sources)).toBe(1);
    expect(io.err).toContain('records a managed Codex endpoint');
    expect(io.err).toContain('left as it is');
    expect(calls).toEqual([]);
    expect(stateSeat(at)?.codex_endpoint).toBeDefined();
    expect(readFileSync(at.file, 'utf8')).toContain('name: worker');
  });

  test('a human seat with no endpoint is removed as before, its pane left running', async () => {
    const at = place('    human: true\n');
    const { sources, calls } = sourcesOf(at, {
      sessionRunning: () => true,
      agents: () => [agent('worker')],
    }, () => ({ stopped: true }));
    const io = testIo(at.root, owner);
    expect(await runRemove(['worker'], io, sources)).toBe(0);
    expect(calls).toEqual([]);
    expect(stateSeat(at)).toBeUndefined();
    expect(readFileSync(at.file, 'utf8')).not.toContain('name: worker');
  });
});
