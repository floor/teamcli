// Acceptance for entity create-grant coverage: a record in `<home>/.config/team/grants/` covers
// only the paths it names itself (`paths`/`path`). A record that names an entity and omits paths
// covers only the roots that entity declares in TeamCLI configuration
// (`<home>/.config/team/entities.yaml`, `<entity>: { roots: [...] }`); with no declared roots it
// grants nothing. A path outside the declared roots is refused, and no entity has a built-in
// default root. Every path here is neutral: a temp tree, never a real user folder.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { grantsDir } from '../src/grant.ts';
import type { Terminal } from '../src/launch/terminal.ts';
import type { Machine } from '../src/watch/machine.ts';
import { gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-17T10:00:00Z');
const FUTURE = '2026-12-31T23:59:59Z';
const SESSION = 'dispatch';

const AMPLE: Machine = {
  loadPerCore: 0.2,
  memoryFree: 80,
  diskFree: 200e9,
  swapTotal: 10e9,
  swapFree: 9e9,
  swapUsed: 1e9,
};

const seatCaller = { kind: 'seat', name: 'worker-1', pane: 'pane-w1', session: SESSION } as const;

const seat = (role: string, name: string, leads = false) => `  - role: ${role}
    name: ${name}
    label: ${name}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5${leads ? '\n    leads: true' : ''}
`;

function teamFile(project: string, root: string, home: string): string {
  const lobby = join(home, '.config', 'team', 'lobbies', 'acme');
  return `format: 1
project: ${project}
entity: acme
operator: orchestrator
trust:
  - ${lobby}
  - ${root}
workspace:
  mode: shared
seats:
${seat('orchestrator', 'orchestrator', true)}${seat('builder', 'worker-1')}${seat('tester', 'tester-1')}`;
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'init', '-q', '-b', 'main'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
  writeFileSync(join(dir, 'README.md'), 'project\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', 'README.md'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'initial'], {
    cwd: dir,
    stdio: 'ignore',
    env: gitEnv(),
  });
}

/** A project with a three-seat team file, ready for a `up --dry-run`. */
function project(home: string, dir: string): string {
  initGitRepo(dir);
  mkdirSync(join(dir, '.agents'), { recursive: true });
  writeFileSync(join(dir, '.agents', 'team.yaml'), teamFile('acme-v1', dir, home));
  return dir;
}

function makeSandbox() {
  const base = realpathSync(mkdtempSync('/tmp/dr-'));
  const home = join(base, 'home');
  mkdirSync(grantsDir(home), { recursive: true });
  return { base, home };
}

function writeGrant(home: string, name: string, lines: string[]): void {
  mkdirSync(grantsDir(home), { recursive: true });
  writeFileSync(join(grantsDir(home), name), [
    `session: ${SESSION}`,
    'agent: worker-1',
    `expires: "${FUTURE}"`,
    ...lines,
    '',
  ].join('\n'));
}

/** The entity declarations file: `<entity>: { roots: [<path>, ...] }`. */
function writeEntities(home: string, entity: string, roots: string[]): void {
  const folder = join(home, '.config', 'team');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'entities.yaml'),
    `${entity}:\n  roots:\n${roots.map((root) => `    - ${root}`).join('\n')}\n`,
  );
}

function launching(): Launch {
  let n = 0;
  let session: 'absent' | 'running' = 'absent';
  const panes = new Map<string, { text: string; agent: boolean }>();
  return {
    sessionState: () => session,
    startServer() {
      session = 'running';
      return true;
    },
    sessionUp: () => session === 'running',
    createWorkspace() {
      n += 1;
      const pane = `seat-pane-${n}`;
      panes.set(pane, { text: '', agent: false });
      return { pane, workspace: `ws-${n}` };
    },
    paneRun(_session: string, pane: string) {
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent: () => true,
    closeWorkspace: () => true,
    agentPanes: () => [...panes].filter(([, pane]) => pane.agent).map(([id]) => id),
    agents: () => [],
    paneText: () => '',
    foreground: () => ['claude'],
    sleep: async () => {},
    now: () => NOW,
  };
}

function terminal(): Terminal {
  return {
    async key() {
      throw new Error('the pause read the terminal');
    },
    drain() {},
  };
}

function upSources(home: string): UpSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    home,
    now: () => NOW,
    machine: () => AMPLE,
    terminal: () => terminal(),
    launch: launching(),
  };
}

/** What the run said, for a failure message that never carries a path. */
function said(out: string, err: string): string {
  return `out=${JSON.stringify(out)} err=${JSON.stringify(err)}`;
}

/** The first line the run printed: enough to name a refusal without the plan under it. */
function head(text: string): string {
  return text.split('\n')[0] ?? '';
}

/** The entity a built-in default would cover, read from the code under test so this file never
 *  writes a real folder name. Null when the code carries no built-in roots at all. */
async function builtinEntity(): Promise<string | null> {
  const mod = (await import('../src/grant.ts')) as unknown as Record<string, unknown>;
  const map = mod.ENTITY_PATHS;
  if (!map || typeof map !== 'object') return null;
  const names = Object.keys(map as Record<string, unknown>);
  return names.length > 0 ? names[0]! : null;
}

describe('entity create-grant coverage: declared roots, never a built-in default', () => {
  test('1. an explicit path in the record is admitted', async () => {
    const sb = makeSandbox();
    try {
      const root = project(sb.home, join(sb.base, 'declared', 'v1'));

      writeGrant(sb.home, 'rec-1.yaml', ['paths:', `  - ${root}`]);
      const io = testIo(root, seatCaller);
      expect(await runUp(['--dry-run'], io, upSources(sb.home)), said(io.out, io.err)).toBe(0);
      expect(io.out).toContain('worker-1');

      writeGrant(sb.home, 'rec-1.yaml', [`path: ${root}`]);
      const singular = testIo(root, seatCaller);
      expect(await runUp(['--dry-run'], singular, upSources(sb.home)), said(singular.out, singular.err)).toBe(0);
      expect(singular.out).toContain('worker-1');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('2. an entity with declared roots is admitted inside them', async () => {
    const sb = makeSandbox();
    try {
      const declared = join(sb.base, 'declared');
      const root = project(sb.home, join(declared, 'v1'));
      writeEntities(sb.home, 'acme', [declared]);
      writeGrant(sb.home, 'rec-2.yaml', ['entity: acme']);

      const io = testIo(root, seatCaller);
      expect(await runUp(['--dry-run'], io, upSources(sb.home)), head(io.out)).toBe(0);
      expect(io.out).toContain('worker-1');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('3. an entity with no declared roots and no paths grants nothing', async () => {
    const sb = makeSandbox();
    try {
      // The record names no paths. The code under test may carry a built-in root for one
      // entity; this scene is built on that entity's name, read from the code rather than
      // written here, so a built-in default would cover a tree under this temp home.
      const builtin = await builtinEntity();
      const name = builtin ?? 'acme-undeclared';
      const root = project(sb.home, join(sb.home, 'Code', name, 'v1'));
      if (builtin !== null) mkdirSync(join(sb.home, 'Code', builtin), { recursive: true });
      // No entities file: nothing declares roots for this entity.
      writeGrant(sb.home, 'rec-3.yaml', [`entity: ${name}`]);

      const io = testIo(root, seatCaller);
      const code = await runUp(['--dry-run'], io, upSources(sb.home));
      // No output in this message: a failed run's plan may carry the built-in name.
      expect(code, 'a record naming no paths and no declared roots must not be admitted').toBe(1);
      expect(io.out).toContain('up would refuse');
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });

  test('4. a path outside the declared roots is refused', async () => {
    const sb = makeSandbox();
    try {
      const declared = join(sb.base, 'declared');
      const outside = project(sb.home, join(sb.base, 'elsewhere', 'v1'));
      mkdirSync(declared, { recursive: true });
      writeEntities(sb.home, 'acme', [declared]);
      writeGrant(sb.home, 'rec-4.yaml', ['entity: acme']);

      const io = testIo(outside, seatCaller);
      const code = await runUp(['--dry-run'], io, upSources(sb.home));
      expect(code, said(io.out, io.err)).toBe(1);
      expect(io.out).toContain('up would refuse');
      // The refusal carries a reason, not the bare word alone.
      const reason = io.out.split('\n').find((line) => line.startsWith('! up would refuse:'));
      expect(reason, said(io.out, io.err)).toBeDefined();
      expect(reason!.replace('! up would refuse:', '').trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(sb.base, { recursive: true, force: true });
    }
  });
});
