// The model-mismatch line gained a trailing sentence where a profile records how its
// CLI is told its model. The builder's rows pin the codex side — the sentence present,
// word for word. These are the other sides: a profile with no record adds nothing and
// the line still ends at the file correction; the three lists that admit the new key
// stay in agreement, and the one shipped record is where a run showed it; and the up
// page's row carries both halves of the added sentence the template builds.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../src/commands/approve.ts';
import { runUp, type Launch, type UpSources } from '../src/commands/up.ts';
import { storePath } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8').replace('parked: true', 'stopped: true');
const NOW = new Date('2026-10-03T14:02:00Z');
const IDLE = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Opus 5.5\n`;
// The same idle box with another model on its status row: a screen the claude-code
// profile reads as Claude Sonnet 5.5 while the file says Claude Opus 5.5.
const SONNET = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n  main · Sonnet 5.5\n`;
const FILE = ['--file', '.agents/team.yaml'];
const COORDINATOR = 'claude-coordinator-acme · project coordinator';

function makeExample(basePath: string, rootPath: string): string {
  return EXAMPLE.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

function world(shown: (pane: string, label: string) => string): { launch: Launch; renames: string[]; session: 'absent' | 'running' } {
  const made = { launch: {} as Launch, renames: [] as string[], session: 'absent' as 'absent' | 'running' };
  const panes = new Map<string, { text: string; agent: boolean }>();
  let clock = NOW.getTime();
  let n = 0;
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `w${n}:p1`;
      panes.set(pane, { text: shown(pane, label), agent: false });
      return { pane, workspace: `w${n}` };
    },
    paneRun(_session, pane) {
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
    paneText: (_session, pane) => panes.get(pane)?.text ?? '',
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return made;
}

describe('the mismatch line without a recorded form', () => {
  test('a claude-code seat on another model is left out with the line ending at the file correction', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'model-form-')));
    const root = join(base, 'acme-web');
    const home = join(base, 'home');
    mkdirSync(join(root, '.agents'), { recursive: true });
    mkdirSync(home);
    try {
      writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root));
      const approved = testIo(root, { kind: 'owner' });
      expect(await runApprove(FILE, approved, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home })).toBe(0);
      const made = world((_pane, label) => (label === COORDINATOR ? SONNET : IDLE));
      const io = testIo(root, { kind: 'owner' });
      const sources: UpSources = {
        sessionRunning: () => made.session === 'running',
        agents: () => [],
        workspaces: () => [],
        home,
        now: made.launch.now,
        sleep: made.launch.sleep,
        launch: made.launch,
      };
      expect(await runUp(FILE, io, sources)).toBe(1);
      // The whole line, and nothing after the file correction: no record of how this CLI
      // is told its model exists for claude-code, so the line adds nothing.
      expect(io.out).toContain(
        'claude-coordinator-acme: left out: runs Claude Sonnet 5.5; the file says Claude Opus 5.5; '
          + 'left at launched, not named. Add --model <id> to its launch, '
          + "or correct the file's model and version and run `team approve`\n",
      );
      expect(io.out).not.toContain('This CLI is told its model with');
      expect(made.renames).not.toContain('claude-coordinator-acme');
      expect(made.renames).toContain('deepseek-acme');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('the lists that admit the new key', () => {
  const PROFILE_SRC = readFileSync(new URL('../src/profiles/profile.ts', import.meta.url), 'utf8');
  const SCREEN_FILE_SRC = readFileSync(new URL('../src/watch/screen-file.ts', import.meta.url), 'utf8');
  const SCHEMA = readFileSync(new URL('../src/profiles/profile.schema.json', import.meta.url), 'utf8');

  function list(source: string, at: string): string[] {
    const found = source.match(new RegExp(`${at}[\\s\\S]*?\\] as const`))?.[0] ?? '';
    return [...found.matchAll(/'([a-z_]+)'/g)].map((one) => one[1] ?? '');
  }

  test('the launch keys a snippet may name still cover the profile loader’s own', () => {
    const optional = list(PROFILE_SRC, 'const OPTIONAL_LAUNCH_KEYS');
    const required = list(PROFILE_SRC, 'const LAUNCH_KEYS');
    expect(optional, 'profile.ts lost its optional launch keys').toContain('model_form');
    expect(required.length, 'profile.ts lost its required launch keys').toBeGreaterThan(5);
    // The screen file allows the launch keys in a snippet; a key the profile loader
    // requires and the snippet refuses splits profile parsing from snippet parsing.
    const allowed = SCREEN_FILE_SRC.match(/only\(entries, \[([^\]]+)\]/)?.[1] ?? '';
    for (const key of required) {
      expect(allowed, `screen-file.ts no longer admits ${key}`).toContain(`'${key}'`);
    }
    expect(allowed, 'screen-file.ts admits model_form in the wrong company').toContain("'status_model', 'model_form'");
  });

  test('the schema knows the key, and the one shipped record is where a run showed it', () => {
    expect(SCHEMA).toContain('"model_form"');
    expect(SCHEMA).toContain('"minLength": 1');
    const names = ['claude-code', 'codex', 'cursor', 'antigravity', 'grok'] as const;
    const withForm: string[] = [];
    for (const name of names) {
      const yaml = readFileSync(new URL(`../src/profiles/${name}.yaml`, import.meta.url), 'utf8');
      const line = yaml.match(/^model_form: (.+)$/m)?.[1];
      if (line) withForm.push(name);
    }
    expect(withForm).toEqual(['codex']);
    expect(readFileSync(new URL('../src/profiles/codex.yaml', import.meta.url), 'utf8')).toContain("model_form: '-m <model id>'");
  });
});

describe('the up page row and the line the template builds', () => {
  const PAGE = readFileSync(new URL('../docs/internal/up.md', import.meta.url), 'utf8');
  const EXECUTE = readFileSync(new URL('../src/launch/execute.ts', import.meta.url), 'utf8');

  test('the row carries the sentence, and only where a record exists', () => {
    expect(PAGE).toContain('When the profile records how that CLI is told its model, the line says that form as well; a profile with no such record adds nothing');
    expect(PAGE).toContain('left at launched, not named. Add <flag> <id> to its launch, or correct the file\'s model and version and run team approve');
    // The template builds the sentence from the record, and an absent record appends
    // nothing: the guard is the record's own truthiness, not a list of profiles.
    expect(EXECUTE).toContain('const told = form ? `. This CLI is told its model with ${form}.` : \'\';');
    expect(EXECUTE).toContain('run \\`team approve\\`${told}');
  });
});
