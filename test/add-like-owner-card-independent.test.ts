// Independent coverage of copying a declared seat with --like, and of the owner card a refused caller reaches.
// A registry-backed team whose seats are written on a bare dash is copied by --like, and the
// copy takes no nickname. A caller the ordinary verdict refuses writes nothing until the owner
// card, and a failing validation never reaches that card. Fakes only: a throwaway home, a fake
// launch, and a fake signer. No builder test is imported.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { registerOwnerSeat, type OwnerSeatKeyStore } from '../src/client/owner-seat.ts';
import { runAdd, type AddSources } from '../src/commands/add.ts';
import type { DoctorSources } from '../src/commands/doctor.ts';
import type { Launch } from '../src/commands/up.ts';
import { loadTeamFile } from '../src/file/load.ts';
import { takeOut } from '../src/file/lines.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import { readTeamText, writeTeamText } from '../src/file/team-text.ts';
import { storePath, writeApproval } from '../src/store/store.ts';
import { realRegistryTouched } from './helpers/real-registry.ts';
import { CLAUDE_IDLE, gitEnv, testIo } from './helpers.ts';

const NOW = new Date('2026-10-19T06:10:00Z');
const owner = { kind: 'owner' } as const;
// A seat the ordinary add verdict refuses: add is the owner's, and this caller is not a delegate.
const stranger = { kind: 'seat' as const, name: 'stranger', pane: 'pane-stranger', session: 'acme' };

let base: string;
let project: string;
let home: string;
let savedSource: string | undefined;

function teamText(): string {
  const trustPath = project.startsWith(home) ? project.replace(home, '~') : project;
  return `format: 1
# independent fixture
project: acme
coordinator: lead
operator: lead
session: acme
trust:
  - ~/.config/team/lobby
  - ${trustPath}
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
    label: builder
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: skipper
    label: skipper
    nickname: skip
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - # edited by config set
    role: implementer
    name: dash
    label: "dash · implementer"
    nickname: dash
    delivery_order:
      - typed
      - mcp-inbox
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, stdio: 'ignore', env: gitEnv(),
  });
}

function teamPath(): string {
  return join(project, '.agents', 'team.yaml');
}

function approve(text: string): void {
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

type Made = { launch: Launch; creates: string[]; commands: string[]; session: 'absent' | 'running' };

/** A launch that records what it was asked and never starts a real program. The session
 *  reports running only after this fake is asked to start it, and the pane shows an idle
 *  fixture so a copy that is allowed can finish. */
function world(): Made {
  const panes = new Map<string, { text: string; agent: boolean }>();
  let n = 0;
  let clock = NOW.getTime();
  const made: Made = { launch: {} as Launch, creates: [], commands: [], session: 'absent' };
  made.launch = {
    sessionState: () => made.session,
    startServer() {
      made.session = 'running';
      return true;
    },
    sessionUp: () => made.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n += 1;
      panes.set(`w${n}:p1`, { text: CLAUDE_IDLE, agent: false });
      made.creates.push(label);
      return { pane: `w${n}:p1`, workspace: `w${n}` };
    },
    paneRun(_session, pane, command) {
      made.commands.push(command);
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent() { return true; },
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

/** Every regular file under `home`, relative to it. Skips the fixture git directory. */
function filesOf(root: string): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.set(path.slice(root.length + 1), readFileSync(path));
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/** Paths added, removed, or rewritten between two readings. */
function diffFiles(before: Map<string, Buffer>, after: Map<string, Buffer>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  const changed: string[] = [];
  for (const name of names) {
    const left = before.get(name);
    const right = after.get(name);
    if (left === undefined || right === undefined || !left.equals(right)) changed.push(name);
  }
  return changed.sort();
}

const CARD_PREFIXES = [
  '.config/team/action-requests/',
  '.config/team/owner-seat/inbox/',
];

function cardOnly(changed: string[]): string[] {
  return changed.filter((name) => !CARD_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

type Spy = { store: OwnerSeatKeyStore; calls: number };

function spyStore(): Spy {
  const tracker: Spy = {
    calls: 0,
    store: {
      name: 'fake-signer',
      available: () => {
        tracker.calls += 1;
        return true;
      },
      create: () => {
        tracker.calls += 1;
        return { ok: true as const, publicKey: PUBLIC_KEY };
      },
      publicKey: () => {
        tracker.calls += 1;
        return { ok: true as const, publicKey: PUBLIC_KEY };
      },
      sign: () => {
        tracker.calls += 1;
        return { ok: false as const, why: 'not signed' };
      },
      pinSet: () => ({ ok: true as const }),
      pinGet: () => {
        tracker.calls += 1;
        return { ok: false as const, why: 'unused' };
      },
    },
  };
  const registered = registerOwnerSeat(home, { team: 'acme', signer: 'touch' }, tracker.store, NOW);
  if (!registered.ok) throw new Error(registered.why);
  tracker.calls = 0;
  return tracker;
}

const PUBLIC_KEY = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ type: 'spki', format: 'der' })
  .subarray(-65)
  .toString('hex');

function requestJson(): string[] {
  const folder = actionRequestsFolder(home);
  return existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.json')) : [];
}

beforeEach(() => {
  savedSource = process.env.TEAM_CONFIG_SOURCE;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-add-card-')));
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
  approve(teamText());
});

afterEach(() => {
  if (savedSource === undefined) delete process.env.TEAM_CONFIG_SOURCE;
  else process.env.TEAM_CONFIG_SOURCE = savedSource;
  rmSync(base, { recursive: true, force: true });
});

describe('--like copies a bare-dash registry seat and drops its nickname', () => {
  test('a registry-backed team with a bare-dash seat copies that seat and leaves the nickname behind', async () => {
    process.env.TEAM_CONFIG_SOURCE = 'registry';
    const registryText = teamText();
    const wrote = writeTeamText(teamPath(), registryText, { home, command: 'init', create: true, now: () => NOW });
    expect(wrote.ok).toBe(true);
    rmSync(teamPath());
    expect(existsSync(teamPath())).toBe(false);

    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'dash'], io, sources(made)), io.out + io.err).toBe(0);

    expect(existsSync(teamPath())).toBe(false);
    const stored = readTeamText(teamPath(), { home });
    expect(stored).toContain([
      '  -',
      '    role: implementer',
      '    name: apprentice',
      '    label: "apprentice"',
      '    delivery_order:',
      '      - typed',
      '      - mcp-inbox',
      '    cli: claude-code',
    ].join('\n'));
    expect(stored.match(/nickname: dash/g)).toHaveLength(1);
    expect(stored.match(/nickname: skip/g)).toHaveLength(1);
    expect(stored.match(/# edited by config set/g)).toHaveLength(1);
    expect(takeOut(stored, 'apprentice')).toBe(registryText);
    const loaded = readTeamConfig(project, { home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.source).toBe('registry');
      expect(loaded.team.seats.find((seat) => seat.name === 'dash')?.nickname).toBe('dash');
      expect(loaded.team.seats.find((seat) => seat.name === 'apprentice')?.nickname).toBeUndefined();
      expect(loaded.team.seats.find((seat) => seat.name === 'apprentice')?.deliveryOrder).toEqual(['typed', 'mcp-inbox']);
    }
    expect(made.creates).toEqual(['apprentice']);
    expect(realRegistryTouched()).toBe(false);
  });

  test('a nicknamed seat copied from the file takes no nickname of its own', async () => {
    const before = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, owner);
    expect(await runAdd(['apprentice', '--like', 'skipper'], io, sources(made)), io.out + io.err).toBe(0);
    const text = readFileSync(teamPath(), 'utf8');
    expect(text).toContain('    name: apprentice\n    label: apprentice\n    cli: claude-code\n');
    expect(text.match(/nickname: skip/g)).toHaveLength(1);
    expect(text).not.toContain('name: apprentice\n    label: apprentice\n    nickname:');
    expect(takeOut(text, 'apprentice')).toBe(before);
    const loaded = loadTeamFile(project, { home });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.team.seats.find((seat) => seat.name === 'skipper')?.nickname).toBe('skip');
      expect(loaded.team.seats.find((seat) => seat.name === 'apprentice')?.nickname).toBeUndefined();
    }
    expect(made.creates).toEqual(['apprentice']);
    expect(realRegistryTouched()).toBe(false);
  });
});

describe('the owner card is the only gate for a caller the ordinary verdict refuses', () => {
  const ORDINARY = 'team add: only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is stranger\n';

  test('without --request the ordinary verdict refuses and nothing is written', async () => {
    const spy = spyStore();
    const before = filesOf(home);
    const made = world();
    const io = testIo(project, stranger);
    expect(await runAdd(['apprentice', '--like', 'builder'], io, sources(made, { ownerSeatStore: spy.store }))).toBe(1);
    expect(io.err).toBe(ORDINARY);
    expect(io.out).toBe('');
    expect(diffFiles(before, filesOf(home))).toEqual([]);
    expect(requestJson()).toEqual([]);
    expect(spy.calls).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.commands).toEqual([]);
  });

  test('a missing source never reaches the card', async () => {
    const spy = spyStore();
    const before = filesOf(home);
    const made = world();
    const io = testIo(project, stranger);
    expect(await runAdd(['apprentice', '--like', 'missing', '--request'], io, sources(made, { present: true, ownerSeatStore: spy.store }))).toBe(1);
    expect(io.err).toBe('team add: the file has no seat "missing"\n');
    expect(io.out).toBe('');
    expect(diffFiles(before, filesOf(home))).toEqual([]);
    expect(requestJson()).toEqual([]);
    expect(spy.calls).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.commands).toEqual([]);
  });

  test('a name the file already declares never reaches the card', async () => {
    const spy = spyStore();
    const before = filesOf(home);
    const made = world();
    const io = testIo(project, stranger);
    expect(await runAdd(['builder', '--like', 'skipper', '--request'], io, sources(made, { present: true, ownerSeatStore: spy.store }))).toBe(1);
    expect(io.err).toBe('team add: the file already declares "builder"; --like adds a copy under a new name\n');
    expect(diffFiles(before, filesOf(home))).toEqual([]);
    expect(requestJson()).toEqual([]);
    expect(spy.calls).toBe(0);
    expect(made.creates).toEqual([]);
  });

  test('an unknown model, after the copy would otherwise be valid, never reaches the card', async () => {
    const spy = spyStore();
    const before = filesOf(home);
    const made = world();
    const io = testIo(project, stranger);
    expect(await runAdd(
      ['apprentice', '--like', 'builder', '--model', 'no-such-model', '--request'],
      io,
      sources(made, { present: true, ownerSeatStore: spy.store }),
    )).toBe(2);
    expect(io.err).toBe('team add: apprentice: unknown model "no-such-model" for claude-code\n');
    expect(io.out).toBe('');
    expect(diffFiles(before, filesOf(home))).toEqual([]);
    expect(requestJson()).toEqual([]);
    expect(spy.calls).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.commands).toEqual([]);
  });

  test('a valid --request records the card and nothing else', async () => {
    const spy = spyStore();
    const before = filesOf(home);
    const teamBefore = readFileSync(teamPath(), 'utf8');
    const made = world();
    const io = testIo(project, stranger);
    expect(await runAdd(
      ['apprentice', '--like', 'builder', '--request'],
      io,
      sources(made, { present: false, ownerSeatStore: spy.store }),
    ), io.out + io.err).toBe(0);
    expect(io.out).toContain('team add: owner-seat request oa_');
    expect(io.out).toContain('the owner answers it on the owner page');
    expect(readFileSync(teamPath(), 'utf8')).toBe(teamBefore);
    expect(requestJson()).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(actionRequestsFolder(home), requestJson()[0] ?? ''), 'utf8')) as {
      params?: { actions?: string[]; requested_by?: string };
    };
    expect(record.params?.actions).toEqual(['team-add']);
    expect(record.params?.requested_by).toBe('stranger');
    expect(cardOnly(diffFiles(before, filesOf(home)))).toEqual([]);
    expect(spy.calls).toBe(0);
    expect(made.creates).toEqual([]);
    expect(made.commands).toEqual([]);
    const loaded = loadTeamFile(project, { home });
    expect(loaded.ok && loaded.team.seats.some((seat) => seat.name === 'apprentice')).toBe(false);
  });
});
