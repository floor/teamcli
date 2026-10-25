// Reaches the returns that fire only when a later check disagrees with the one just done.
// Run as its own process so the stand-in is in place before the commands load.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'bun:test';
import * as realValidate from '../src/file/validate.ts';

const id = process.argv[2] ?? '';
const originalValidate = realValidate.validateTeamFile;
const originalLabel = realValidate.defaultLabel;
const originalWatch = realValidate.defaultWatch;
const originalBudgets = realValidate.defaultBudgets;
const state = { failAt: 0, calls: 0, placedCalls: 0, failure: '' };

mock.module('../src/file/validate.ts', () => ({
  validateTeamFile(text: string) {
    state.calls += 1;
    if (state.failAt !== 0 && state.calls === state.failAt) {
      return { ok: false as const, errors: [{ line: 1, message: state.failure }] };
    }
    return originalValidate(text);
  },
  defaultLabel: originalLabel,
  defaultWatch: originalWatch,
  defaultBudgets: originalBudgets,
}));

const realLoad = await import('../src/file/load.ts');
const originalPlaced = realLoad.placedProblems;
if (id === 'approve.placed') {
  mock.module('../src/file/load.ts', () => ({
    TEAM_FILE: realLoad.TEAM_FILE,
    findRoot: realLoad.findRoot,
    loadTeamFile: realLoad.loadTeamFile,
    placedProblems(team: Parameters<typeof originalPlaced>[0], root: string) {
      state.placedCalls += 1;
      // The load just ran this check. The command's own call is the next one.
      if (state.placedCalls === 2) {
        return [{
          line: 0,
          message: 'trust: "../side" names the project\'s parent or a folder above it: it would trust every folder beside the project',
        }];
      }
      return originalPlaced(team, root);
    },
  }));
}

const { approvalOf } = await import('../src/approve/approval.ts');
const { runAdd } = await import('../src/commands/add.ts');
const { runApprove } = await import('../src/approve/command.ts');
const { storePath, writeApproval } = await import('../src/store/store.ts');
const { gitEnv, testIo } = await import('./helpers.ts');

const NOW = new Date('2026-10-04T09:00:00Z');
const TWO = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
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
    name: worker
    label: worker
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
    stopped: true
`;

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-exit-def-')));
const root = join(base, 'acme');
const home = join(base, 'home');
mkdirSync(join(root, '.agents'), { recursive: true });
mkdirSync(home);
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv(),
});
git('init', '-q', '-b', 'main');
writeFileSync(join(root, 'README.md'), 'acme\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'first');
const yaml = TWO.replace('coordinator: lead\n', `coordinator: lead\ntrust:\n  - ~/.config/team/lobby\n  - ${root}\n`);
const file = join(root, '.agents', 'team.yaml');
writeFileSync(file, yaml);
const loaded = realLoad.loadTeamFile(root, { file, home });
if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
writeApproval(
  storePath(loaded.team.project, loaded.root, home),
  { approval: approvalOf(loaded.team, loaded.root, NOW), file: yaml },
  loaded.team.seats,
  home,
  NOW,
);

// Counts are the command's own checks. Setup above is not part of the run.
state.calls = 0;
state.placedCalls = 0;
const plan: Record<string, { failAt: number; failure: string }> = {
  // declaredSeat's check of the restored text
  'add.not-restored': { failAt: 3, failure: 'edited text rejected' },
  // the prepared-edit check, after the seat was accepted
  'add.prepared': { failAt: 4, failure: 'the prepared edit does not validate' },
  // writeTeamFile's check, after the prepared edit validates
  'add.locked': { failAt: 5, failure: 'the locked edit does not validate' },
  // approve's second read of the text load just accepted
  'approve.revalidate': { failAt: 2, failure: 'the file does not validate' },
  'approve.placed': { failAt: 0, failure: '' },
};
const chosen = plan[id];
if (!chosen) throw new Error(`unknown ${id}`);
state.failAt = chosen.failAt;
state.failure = chosen.failure;

const sources = {
  home,
  sessionState: () => 'absent' as const,
  agents: () => [],
  workspaces: () => [],
  doctor: {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  },
  now: () => NOW,
  launch: {
    sessionState: () => 'absent' as const,
    startServer: () => false,
    sessionUp: () => false,
    createWorkspace: () => null,
    paneRun: () => false,
    renameAgent: () => false,
    closeWorkspace: () => false,
    agentPanes: () => [],
    agents: () => [],
    paneText: () => '',
    foreground: () => null,
    sleep: async () => {},
    now: () => NOW,
  },
};

const io = testIo(root, { kind: 'owner' });
let code: number;
if (id.startsWith('approve.')) {
  code = await runApprove(['--file', file], io, { ask: async () => '1', waiting: () => 'empty', now: () => NOW, home });
} else {
  code = await runAdd(['worker', '--file', file], io, sources);
}
console.log(JSON.stringify({ code, err: io.err, out: io.out, calls: state.calls }));
rmSync(base, { recursive: true, force: true });
