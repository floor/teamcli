// The general door's scope, measured on synthetic homes: a grant that lists entities admits only
// the teams of those entities, whatever option or positional names the team the line acts on, and
// the op the door checks is the one the line reaches — `down --abandon` is `abandon`, not `down`,
// and `seat add` is `add`, not `seat`. A wildcard grant is unchanged: it admits every line it
// admitted before. Targets are read from the same sources the commands read them from (`--file`,
// `--root`, the registry, the pause and resume resolver), never from the folder the door happens
// to run in.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Door, generalDoor } from '../src/client/general-door.ts';
import { GENERAL_OPS, issueOwnerGeneralGrant, type GrantOp } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { commands, main } from '../src/cli.ts';
import { runConfig } from '../src/commands/config.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { type DownSources, runDown } from '../src/commands/down.ts';
import { runUp, type UpSources } from '../src/commands/up.ts';
import type { ServiceManager, ServiceProgram } from '../src/daemon/service.ts';
import type { Io } from '../src/io.ts';
import { projectIdOf, upsertProject } from '../src/registry/projects.ts';
import { readStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { gitEnv } from './helpers.ts';
import { intoRegistry } from './helpers/registry-team.ts';

// Read by the door, the grants and the commands alike, so a grant this run issues is live for
// every one of them (an own-door command, `up` and `config`, reads the real clock).
const NOW = new Date();
const base = realpathSync(mkdtempSync(join(process.cwd(), '.gg-scope-')));
const home = join(base, 'home');
const ROOT_NAMES = ['alpha', 'beta', 'gamma', 'delta'] as const;
const roots = Object.fromEntries(ROOT_NAMES.map((name) => [name, join(base, name)])) as Record<(typeof ROOT_NAMES)[number], string>;
const files = Object.fromEntries(ROOT_NAMES.map((name) => [name, join(roots[name], '.agents', 'team.yaml')])) as Record<(typeof ROOT_NAMES)[number], string>;
/** A team file outside the registry, with no entity, for the listed-grant refusal it always had. */
const soloFile = join(base, 'solo-root', '.agents', 'team.yaml');
let client: { pub: string; path: string };

function teamText(project: string, entity: string | null): string {
  return `format: 1
project: ${project}
${entity === null ? '' : `entity: ${entity}\n`}coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

function register(name: keyof typeof roots, entity: string | null): void {
  const root = roots[name];
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(files[name], teamText(name, entity));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  intoRegistry(root, home);
  // The machine-wide and registry-keyed surfaces read the team registry (teams.yaml); the migrate
  // helper writes the team's config record only, so the record a real `team add`/`up` leaves is
  // written here too. `status --project` reads the project registry, which names the same team.
  upsertTeam(home, teamIdOf(root), { project: name, entity, session: name, root, roster: [], lifecycle: 'running', by: 'scene' });
  upsertProject(home, projectIdOf(name), { name, entity, teams: [teamIdOf(root)], by: 'scene' });
}

let alphaGrant: string;
let betaGrant: string;
let allGrant: string;
let alphaDownGrant: string;
let alphaAbandonGrant: string;
let wildcard: string;

function grantOf(entities: string[], ops: GrantOp[]): string {
  const issued = issueOwnerGeneralGrant(home, { clientId: 'client-a', publicKey: client.pub, entities, ops, mayIssue: false, expires: new Date(NOW.getTime() + 86_400_000) }, NOW);
  if (!issued.ok) throw new Error(issued.why);
  return issued.path;
}

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
  const pair = newClientKeyPair();
  const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-a'), pair);
  if (!written.ok) throw new Error(written.why);
  client = { pub: pair.publicKey, path: written.keyPath };
  register('alpha', 'alpha');
  register('beta', 'beta');
  register('gamma', 'gamma');
  register('delta', 'alpha');
  mkdirSync(join(base, 'solo-root', '.agents'), { recursive: true });
  writeFileSync(soloFile, teamText('solo', null));
  alphaGrant = grantOf(['alpha'], ['*']);
  betaGrant = grantOf(['beta'], ['*']);
  allGrant = grantOf(['alpha', 'beta', 'gamma'], ['*']);
  alphaDownGrant = grantOf(['alpha'], ['down']);
  alphaAbandonGrant = grantOf(['alpha'], ['abandon']);
  wildcard = grantOf(['*'], ['*']);
  // One seat name on two teams, the shape `team mcp serve` places by when no `--file` is given:
  // the roster line names the team, and `--session` narrows between the two.
  upsertTeam(home, teamIdOf(roots.beta), { roster: [{ agent: 'agent-b', seat: 'builder-7', role: 'builder' }] });
  upsertTeam(home, teamIdOf(roots.gamma), { roster: [{ agent: 'agent-g', seat: 'builder-7', role: 'builder' }] });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

type Env = { cwd?: string; caller?: Io['caller'] };

function door(name: string, words: string[], grantPath: string, env: Env = {}): Door {
  const io: Io = {
    stdout: () => {},
    stderr: () => {},
    cwd: env.cwd ?? roots.alpha,
    env: { HOME: home },
    stdinIsTTY: false,
    ...(env.caller === undefined ? {} : { caller: env.caller }),
  };
  return generalDoor(name, [...words, '--general', grantPath, '--key', client.path], io, NOW);
}

function whyOf(d: Door): string {
  return 'why' in d ? `: ${d.why}` : '';
}

function refused(d: Door, needle: string): void {
  if (d.kind !== 'refused') throw new Error(`expected refused, got ${d.kind}${whyOf(d)}`);
  expect(d.why).toContain(needle);
}

function admitted(d: Door): void {
  if (d.kind !== 'admitted') throw new Error(`expected admitted, got ${d.kind}${whyOf(d)}`);
}

function targetRefused(d: Door, needle = 'be resolved'): void {
  if (d.kind !== 'target') throw new Error(`expected target, got ${d.kind}${whyOf(d)}`);
  expect(d.why).toContain(needle);
}

const seat = { kind: 'seat', name: 'builder-5', pane: 'pane1' } as const;

// P1-1, the operator's first proof: a down scoped to alpha admits a beta file unless the door
// reads the file the line names. Both proofs run from alpha's folder, as a seat.
test('down --file: another entity\'s team file is refused for a seat under an alpha grant', () => {
  refused(door('down', ['--dry-run', '--file', files.beta], alphaGrant, { caller: seat }), 'does not cover entity "beta"');
});

test('down --abandon: a grant covering down does not admit the abandon op', () => {
  refused(door('down', ['--abandon'], alphaDownGrant, { caller: seat }), 'does not cover abandon');
});

test('down --abandon --file: the op is checked first, then the team the file names', () => {
  refused(door('down', ['--abandon', '--file', files.beta], alphaAbandonGrant, { caller: seat }), 'does not cover entity "beta"');
});

test('down --abandon: a grant covering abandon admits it', () => {
  admitted(door('down', ['--abandon'], alphaAbandonGrant, { caller: seat }));
});

test('down (no file): this folder\'s own team is the one checked, and a grant for it admits', () => {
  admitted(door('down', ['--dry-run'], alphaGrant));
  refused(door('down', ['--dry-run'], betaGrant), 'does not cover entity "alpha"');
});

// A session is a target too: the commands read the session the flag names, so its registered
// team is the one the run acts on — the same rule as `--file`.
test('down --session: the session names the team the run acts on', () => {
  refused(door('down', ['--dry-run', '--session', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('down', ['--dry-run', '--session', 'beta'], betaGrant));
  admitted(door('down', ['--dry-run', '--session', 'alpha'], alphaGrant));
  admitted(door('down', ['--dry-run', '--session', 'default'], alphaGrant));
  targetRefused(door('down', ['--dry-run', '--session', 'nowhere'], alphaGrant));
  admitted(door('down', ['--dry-run', '--session', 'beta'], wildcard));
});

// Every command whose own parser reads `--session` reaches the session by name, so each one is
// checked against the session's registered team, not the folder the door stands in.
test('--session: every command that reads one is checked against the session\'s team', () => {
  const withSession = ['add', 'answer', 'archive', 'brief', 'check', 'doctor', 'down', 'drops', 'mcp', 'register', 'remove', 'rename', 'restart', 'seat', 'watch', 'worktree'];
  for (const name of withSession) {
    refused(door(name, ['--session', 'beta'], alphaGrant), 'does not cover entity "beta"');
    admitted(door(name, ['--session', 'beta'], betaGrant));
  }
});

// P1-1, the effect: the admitted run acts on the file the door checked, not on this folder.
function downSources(): DownSources {
  return {
    sessionRunning: () => false,
    agents: () => [],
    alive: () => false,
    screen: () => ({ kind: 'idle' }),
    screenText: () => '',
    status: () => 'idle',
    foreground: () => ['zsh'],
    now: () => NOW,
    home,
  };
}

async function runThrough(name: string, words: string[], grantPath: string, sources: DownSources): Promise<{ kind: string; code?: number; out: string }> {
  let out = '';
  let err = '';
  const io: Io = { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, cwd: roots.alpha, env: { HOME: home }, stdinIsTTY: false };
  const d = generalDoor(name, [...words, '--general', grantPath, '--key', client.path], io, NOW);
  if (d.kind !== 'admitted') return { kind: d.kind, out: `${err}${out}` };
  const code = await runDown(d.argv, d.io, sources);
  return { kind: 'admitted', code, out: `${err}${out}` };
}

test('down --file: the run a beta grant admits acts on beta, and the alpha run acts on alpha', async () => {
  const beta = await runThrough('down', ['--dry-run', '--json', '--file', files.beta], betaGrant, downSources());
  expect(beta.kind).toBe('admitted');
  expect(beta.code).toBe(0);
  expect(JSON.parse(beta.out).project).toBe('beta');
  const alpha = await runThrough('down', ['--dry-run', '--json'], alphaGrant, downSources());
  expect(alpha.code).toBe(0);
  expect(JSON.parse(alpha.out).project).toBe('alpha');
});

test('down --abandon: the abandon grant runs the abandon line, and the door admits it', async () => {
  const ran = await runThrough('down', ['--dry-run', '--json', '--abandon'], alphaAbandonGrant, downSources());
  expect(ran.kind).toBe('admitted');
  expect(ran.code).toBe(0);
  expect(JSON.parse(ran.out).project).toBe('alpha');
});

// Every command that reads --file as the team file, one row each: another entity's file is
// refused under a listed grant, and the file's own team is admitted.
const FILE_ROWS: [string, string[]][] = [
  ['add', ['--file', files.beta]],
  ['answer', ['--file', files.beta]],
  ['archive', ['--file', files.beta]],
  ['brief', ['--file', files.beta]],
  ['check', ['--file', files.beta]],
  ['commits', ['--file', files.beta]],
  ['doctor', ['--file', files.beta]],
  ['down', ['--file', files.beta]],
  ['mcp', ['--file', files.beta]],
  ['policy', ['--file', files.beta]],
  ['pr', ['--file', files.beta]],
  ['release', ['--file', files.beta]],
  ['reload', ['--file', files.beta]],
  ['remove', ['--file', files.beta]],
  ['rename', ['--file', files.beta]],
  ['restart', ['--file', files.beta]],
  ['seat', ['--file', files.beta]],
  ['seats', ['--file', files.beta]],
  ['settings', ['--file', files.beta]],
  ['status', ['--file', files.beta]],
  ['swap', ['--file', files.beta]],
  ['watch', ['--file', files.beta]],
  ['worktree', ['--file', files.beta]],
];

test('the file table covers every command whose --file is the team file', () => {
  expect(FILE_ROWS.map(([name]) => name).sort()).toEqual([
    'add', 'answer', 'archive', 'brief', 'check', 'commits', 'doctor', 'down', 'mcp', 'policy', 'pr',
    'release', 'reload', 'remove', 'rename', 'restart', 'seat', 'seats', 'settings', 'status', 'swap',
    'watch', 'worktree',
  ]);
});

for (const [name, words] of FILE_ROWS) {
  test(`${name} --file: the file's own entity decides, not this folder's`, () => {
    refused(door(name, words, alphaGrant), 'does not cover entity "beta"');
    admitted(door(name, words, betaGrant));
  });
}

test('the --file=<path> form is read the same way', () => {
  refused(door('status', [`--file=${files.beta}`], alphaGrant), 'does not cover entity "beta"');
});

test('a team file that declares no entity is the listed-entities refusal it always was', () => {
  refused(door('status', ['--file', soloFile], allGrant), 'this team belongs to no entity');
  admitted(door('status', ['--file', soloFile], wildcard));
});

test('a --file the door cannot read refuses before the run, for a listed grant only', () => {
  targetRefused(door('down', ['--file', join(base, 'nowhere', 'team.yaml')], alphaGrant));
  admitted(door('down', ['--file', join(base, 'nowhere', 'team.yaml')], wildcard));
});

test('a value spelled like an option is a value, as the command\'s own parser reads it', () => {
  // `--session --file` makes `--file` the session's value; no file is named, so this folder's
  // team is the one checked: beta's grant does not cover it, alpha's does.
  refused(door('status', ['--session', '--file', 'x'], betaGrant), 'does not cover entity "alpha"');
  admitted(door('status', ['--session', '--file', 'x'], alphaGrant));
});

// send's --file is the message body, never a team: the address decides the team.
test('send: --file stays the message body, and a plain address is this folder\'s team', () => {
  admitted(door('send', ['lead', 'body text', '--file', 'note.txt'], alphaGrant));
  refused(door('send', ['lead', 'body text', '--file', 'note.txt'], betaGrant), 'does not cover entity "alpha"');
  refused(door('send', ['lead@beta', 'body text'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('send', ['lead@beta', 'body text'], betaGrant));
});

// Daemon roots are project folders, resolved as the command resolves them.
test('daemon --root: every root named is read, and the roots decide the entities', () => {
  refused(door('daemon', ['install', '--dry-run', '--root', roots.beta], alphaGrant), 'does not cover entity "beta"');
  admitted(door('daemon', ['install', '--dry-run', '--root', roots.beta], betaGrant));
  refused(door('daemon', ['install', '--dry-run', `--root=${roots.beta}`], alphaGrant), 'does not cover entity "beta"');
  refused(door('daemon', ['install', '--dry-run', '--root', roots.alpha, '--root', roots.beta], alphaGrant), 'does not cover entity "beta"');
  admitted(door('daemon', ['install', '--dry-run', '--root', roots.alpha, '--root', roots.delta], alphaGrant));
  admitted(door('daemon', ['install', '--dry-run'], alphaGrant));
  refused(door('daemon', ['install', '--dry-run'], betaGrant), 'does not cover entity "alpha"');
});

test('daemon --root: a root that cannot be read refuses before the run', () => {
  targetRefused(door('daemon', ['install', '--dry-run', '--root', join(base, 'nowhere')], alphaGrant));
});

// pause and resume resolve their targets the way the commands do.
test('pause and resume: the team they name decides, and --all names every registered team', () => {
  for (const name of ['pause', 'resume']) {
    refused(door(name, ['--team', 'beta'], alphaGrant), 'does not cover entity "beta"');
    admitted(door(name, ['--team', 'beta'], betaGrant));
    refused(door(name, ['beta'], alphaGrant), 'does not cover entity "beta"');
    admitted(door(name, ['beta'], betaGrant));
    refused(door(name, ['--all'], betaGrant), 'does not cover entity');
    admitted(door(name, ['--all'], allGrant));
    refused(door(name, ['--seat', 'lead'], betaGrant), 'does not cover entity "alpha"');
    admitted(door(name, ['--seat', 'lead'], alphaGrant));
    admitted(door(name, [], alphaGrant));
    refused(door(name, [], betaGrant), 'does not cover entity "alpha"');
  }
});

test('pause --team: a team that cannot be resolved refuses before the run', () => {
  targetRefused(door('pause', ['--team', 'nowhere'], alphaGrant), 'no team named');
  admitted(door('pause', ['--team', 'nowhere'], wildcard));
});

// Machine-wide listings read every registered team: a listed grant must cover every one.
test('status, seats, feed, list and usage: --all reads every team, so the grant must cover them', () => {
  for (const name of ['status', 'seats', 'feed', 'list', 'usage']) {
    refused(door(name, ['--all'], alphaGrant), 'does not cover entity');
    admitted(door(name, ['--all'], allGrant));
    admitted(door(name, ['--all'], wildcard));
  }
});

test('status --project: the project resolves through the registry', () => {
  refused(door('status', ['--project', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('status', ['--project', 'beta'], betaGrant));
  targetRefused(door('status', ['--project', 'nowhere'], alphaGrant), 'no project named');
});

// forget names registry records by id.
test('forget: the ids name registry records, and their entities decide', () => {
  refused(door('forget', [teamIdOf(roots.beta)], alphaGrant), 'does not cover entity "beta"');
  admitted(door('forget', [teamIdOf(roots.beta)], betaGrant));
  admitted(door('forget', [teamIdOf(roots.alpha)], alphaGrant));
  targetRefused(door('forget', ['000000000000'], alphaGrant));
});

// grant issues for a team or an entity; under a listed grant those must be inside it.
test('grant: --entity, --team, --grant-project and the @team word name the target of the issuance', () => {
  refused(door('grant', ['--entity', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('grant', ['--entity', 'alpha'], alphaGrant));
  refused(door('grant', ['--team', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('grant', ['--team', 'alpha'], alphaGrant));
  refused(door('grant', ['--grant-project', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('grant', ['--grant-project', 'alpha'], alphaGrant));
  refused(door('grant', ['@beta', '--capabilities', 'cli'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('grant', ['@alpha', '--capabilities', 'cli'], alphaGrant));
});

test('grant: a target that cannot be resolved refuses before the run', () => {
  targetRefused(door('grant', ['--team', 'nowhere'], alphaGrant));
  targetRefused(door('grant', ['--grant-project', 'nowhere'], alphaGrant));
});

// policy rules carry an entity or a project.
test('policy: --entity, --project and --file name the scope of the rule', () => {
  refused(door('policy', ['set', 'seat-numbering', 'width=2', '--entity', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('policy', ['set', 'seat-numbering', 'width=2', '--entity', 'alpha'], alphaGrant));
  refused(door('policy', ['set', 'seat-numbering', 'width=2', '--project', 'beta'], alphaGrant), 'does not cover entity "beta"');
  refused(door('policy', ['--file', files.beta], alphaGrant), 'does not cover entity "beta"');
  admitted(door('policy', ['--file', files.beta], betaGrant));
});

// import and migrate read the team file the record will hold.
test('import: the file it names declares the entity the record will hold', () => {
  refused(door('import', [files.beta], alphaGrant), 'does not cover entity "beta"');
  admitted(door('import', [files.beta], betaGrant));
  refused(door('import', [], betaGrant), 'does not cover entity "alpha"');
});

test('migrate: the team file at this folder declares the entity the record will hold', () => {
  refused(door('migrate', ['--dry-run'], betaGrant), 'does not cover entity "alpha"');
  admitted(door('migrate', ['--dry-run'], alphaGrant));
});

// sessions and list read the machine's sessions in every form.
test('sessions: the machine-wide listing needs a grant that covers every team', () => {
  refused(door('sessions', [], alphaGrant), 'does not cover entity');
  admitted(door('sessions', [], allGrant));
});

test('list: every form reads the machine\'s sessions, so every team is checked', () => {
  refused(door('list', [], alphaGrant), 'does not cover entity');
  refused(door('list', ['--all'], alphaGrant), 'does not cover entity');
  admitted(door('list', [], allGrant));
});

// delegate names a pane in a session outside this team: the session's team is the target.
test('delegate: the <session/pane> word names the session\'s team', () => {
  refused(door('delegate', ['beta/pane1', '--commands', 'send'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('delegate', ['beta/pane1', '--commands', 'send'], betaGrant));
  targetRefused(door('delegate', ['nowhere/pane1', '--commands', 'send'], alphaGrant));
});

// setup --roots names the folders the charter would cover: the teams under them are the target.
test('setup --roots: the teams under the roots decide', () => {
  refused(door('setup', ['--roots', roots.beta], alphaGrant), 'does not cover entity "beta"');
  admitted(door('setup', ['--roots', roots.beta], betaGrant));
  admitted(door('setup', ['--roots', roots.beta], wildcard));
});

// owner-seat setup --entity names the entity the owner seat is for, the same literal policy reads.
test('owner-seat --entity: the entity literal is checked against the grant', () => {
  refused(door('owner-seat', ['setup', '--team', 'owner', '--signer', 'touch-id', '--entity', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('owner-seat', ['setup', '--team', 'owner', '--signer', 'touch-id', '--entity', 'beta'], betaGrant));
});

// batch runs the batchable commands' own words: every piece's target is resolved as its own line.
test('batch --do: each piece\'s target is checked, the way its own line would be', () => {
  refused(door('batch', ['--request', '--do', 'down', '--dry-run', '--file', files.beta], alphaGrant), 'does not cover entity "beta"');
  admitted(door('batch', ['--request', '--do', 'down', '--dry-run', '--file', files.beta], betaGrant));
  refused(door('batch', ['--request', '--do', 'send', 'builder-6@beta'], alphaGrant), 'does not cover entity "beta"');
  targetRefused(door('batch', ['--request', '--do', 'down', '--session', 'nowhere'], alphaGrant));
});

// The seat lifecycle verbs run the top-level commands: the op and the target are theirs.
test('seat verbs: the op is the top-level command\'s, and the file option is the dispatched command\'s', () => {
  const addOnly = grantOf(['alpha'], ['add']);
  const seatOnly = grantOf(['alpha'], ['seat']);
  admitted(door('seat', ['add', 'builder-6'], addOnly));
  refused(door('seat', ['add', 'builder-6'], seatOnly), 'does not cover add');
  admitted(door('seat', ['add', 'builder-6', '--file', files.alpha], addOnly));
  refused(door('seat', ['add', 'builder-6', '--file', files.beta], addOnly), 'does not cover entity "beta"');
  admitted(door('seat', ['--file', files.alpha, 'builder-6'], seatOnly));
  refused(door('seat', ['--file', files.beta, 'builder-6'], seatOnly), 'does not cover entity "beta"');
  admitted(door('seat', ['--json', 'restart', 'builder-6'], grantOf(['alpha'], ['restart'])));
});

// up reads --general itself, and resolves --file before the entity check. Its own sources name
// the scene's home: the shipped command would read the machine's registry and owner key.
function upSources(): UpSources {
  return {
    sessionRunning: () => false,
    sessionState: () => 'absent',
    agents: () => [],
    home,
    now: () => NOW,
    doctor: { version: () => '2.1.288', onPath: () => true, loggedIn: () => true, herdrVersion: () => '0.7.1', sessionRunning: () => false, now: () => NOW, home },
  };
}

async function up(argv: string[], grantPath: string): Promise<{ code: number; err: string }> {
  let err = '';
  const io: Io = { stdout: () => {}, stderr: (text) => { err += text; }, cwd: roots.alpha, env: { HOME: home }, stdinIsTTY: false };
  const code = await runUp([...argv, '--general', grantPath, '--key', client.path], io, upSources());
  return { code, err };
}

test('up --file: the file it names decides, and a grant for its team admits', async () => {
  const refusedUp = await up(['--file', files.beta, '--dry-run'], alphaGrant);
  expect(refusedUp.code).toBe(1);
  expect(refusedUp.err).toContain('does not cover entity "beta"');
  const admittedUp = await up(['--file', files.beta, '--dry-run'], betaGrant);
  expect(admittedUp.err).toContain('admitted by general grant');
  expect(admittedUp.err).not.toContain('does not cover');
});

test('up: this folder\'s team is the one checked when no file is named', async () => {
  const alpha = await up(['--dry-run'], alphaGrant);
  expect(alpha.err).toContain('admitted by general grant');
  const beta = await up(['--dry-run'], betaGrant);
  expect(beta.code).toBe(1);
  expect(beta.err).toContain('does not cover entity "alpha"');
});

test('up --session: the session it launches into decides when no file is named', async () => {
  const other = await up(['--session', 'beta', '--dry-run'], alphaGrant);
  expect(other.code).toBe(1);
  expect(other.err).toContain('does not cover entity "beta"');
  const itsOwn = await up(['--session', 'beta', '--dry-run'], betaGrant);
  expect(itsOwn.err).toContain('admitted by general grant');
  const unknown = await up(['--session', 'nowhere', '--dry-run'], alphaGrant);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain('cannot be resolved');
});

// The wildcard grant the owner's machine grant is shaped like: unchanged admission.
function fakeService(): ServiceManager & { programs: ServiceProgram[] } {
  const programs: ServiceProgram[] = [];
  return {
    programs,
    kind: 'system-service-manager',
    unitPath: (homePath: string) => join(homePath, 'unit.plist'),
    plan: (homePath: string, program: ServiceProgram) => { programs.push(program); return { unitPath: join(homePath, 'unit.plist'), program: [program.execPath, program.entry, 'daemon', 'run'] }; },
    install: () => ({ ok: true, unitPath: join(home, 'unit.plist') }),
    uninstall: () => ({ ok: true, unitPath: join(home, 'unit.plist'), removed: true }),
  } as unknown as ServiceManager & { programs: ServiceProgram[] };
}

test('a wildcard grant still admits daemon install --dry-run with roots', async () => {
  let out = '';
  const io: Io = { stdout: (text) => { out += text; }, stderr: () => {}, cwd: roots.alpha, env: { HOME: home }, stdinIsTTY: false };
  const d = generalDoor('daemon', ['install', '--dry-run', '--root', roots.beta, '--general', wildcard, '--key', client.path], io, NOW);
  expect(d.kind).toBe('admitted');
  if (d.kind !== 'admitted') return;
  const code = await runDaemon(d.argv, d.io, { home, service: fakeService(), program: { execPath: '/bin/node', entry: '/x/cli.js' } });
  expect(code).toBe(0);
  expect(out).toContain('would install');
});

test('a wildcard grant still admits config set on this folder\'s team, and the write lands', async () => {
  let err = '';
  const io: Io = { stdout: () => {}, stderr: (text) => { err += text; }, cwd: roots.delta, env: { HOME: home }, stdinIsTTY: false };
  const code = await runConfig(['set', 'project', 'delta-two', '--general', wildcard, '--key', client.path], io, { home, env: { TEAM_CONFIG_SOURCE: 'registry' } });
  expect(code).toBe(0);
  expect(err).toContain('admitted by general grant');
  const stored = readStoredTeamConfig(home, teamIdOf(roots.delta));
  expect(stored?.text).toContain('project: delta-two');
});

test('a wildcard grant still admits down --abandon', () => {
  admitted(door('down', ['--abandon'], wildcard));
  admitted(door('status', ['--all'], wildcard));
  admitted(door('pause', ['--all'], wildcard));
});

// The target refusal has its own exit id and JSON face.
test('a target the door cannot resolve names its own exit id', async () => {
  let out = '';
  let err = '';
  const io: Io = { stdout: (text) => { out += text; }, stderr: (text) => { err += text; }, cwd: roots.alpha, env: { HOME: home }, stdinIsTTY: false };
  const code = await main(['status', '--all', '--json', '--general', betaGrant, '--key', client.path], io);
  expect(code).toBe(1);
  expect(JSON.parse(out).error.id).toBe('team.general-refused');
  out = '';
  const unresolvable = await main(['status', '--project', 'nowhere', '--json', '--general', alphaGrant, '--key', client.path], io);
  expect(unresolvable).toBe(1);
  expect(JSON.parse(out).error.id).toBe('team.general-target');
  expect(err).not.toContain('admitted');
});

// Commands with no team target keep the folder's entity, unchanged.
test('a command with no target option is still this folder\'s team', () => {
  refused(door('messages', [], betaGrant), 'does not cover entity "alpha"');
  admitted(door('messages', [], alphaGrant));
  admitted(door('workflow', ['check', 'x.yaml'], alphaGrant));
  admitted(door('batch', ['--request', '--do', 'status'], alphaGrant));
});

// The door reads a line with the command's own valued options; the contract says which they are,
// so an option added to a command cannot be read as a flag here without this going red. A
// command's subcommand forms carry their own flags in the contract, and the door sees one line,
// so the union over the command and its subcommands is the table it reads.
test('the door\'s valued-option table is the contract\'s, less --general and --key', async () => {
  type Flag = { name: string; takesValue: boolean };
  type Command = { name: string; hidden: boolean; flags: Flag[]; subcommands: Command[] };
  const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', 'contract', 'cli.json'), 'utf8')) as { commands: Command[] };
  const valuedOf = (flags: Flag[]): string[] => flags.filter((flag) => flag.takesValue).map((flag) => flag.name.replace(/^--/, ''));
  const expected = Object.fromEntries(
    contract.commands
      .filter((command) => !command.hidden)
      .map((command) => [
        command.name,
        [...valuedOf(command.flags), ...command.subcommands.flatMap((sub) => valuedOf(sub.flags))]
          .filter((name) => name !== 'general' && name !== 'key')
          .filter((name, index, all) => all.indexOf(name) === index)
          .sort(),
      ]),
  );
  // A dynamic import so this file still loads on a checkout where the table is not there yet.
  const held = Object.entries((await import('../src/client/general-door.ts')).VALUED ?? {}).map(([name, list]) => [name, [...list].sort()]);
  expect(Object.fromEntries(held)).toEqual(expected);
});

// The op a line reaches is the one mapping's: every op no command names is reached by a flag or a
// verb (today that is `abandon`, through `down --abandon`), and every mapped op is a known one.
test('the flag and verb op maps name known ops and leave no op unreachable', async () => {
  const grant = await import('../src/client/general-grant.ts');
  const flagOps = grant.FLAG_OPS ?? {};
  const verbOps = grant.VERB_OPS ?? {};
  const mapped = [...Object.values(flagOps).flatMap((entries) => Object.values(entries)), ...Object.values(verbOps).flatMap((entries) => Object.values(entries))];
  for (const op of mapped) expect(GENERAL_OPS as readonly string[]).toContain(op);
  const byName = new Set(Object.keys(commands));
  expect(GENERAL_OPS.filter((op) => !byName.has(op) && !mapped.includes(op))).toEqual([]);
});

test('a word another option consumes is a value, for the op as for the target', () => {
  // `--abandon` is the session's value, so the op stays `down` and the refusal names the session's
  // team, not the `abandon` op: the scan consumed the word the flag spelling would have made.
  targetRefused(door('down', ['--session', '--abandon'], alphaDownGrant));
  admitted(door('down', ['--approval', '--abandon'], alphaDownGrant));
});

// An option written twice is read one way by the door and another by the command: the parser keeps
// the last occurrence (`src/args.ts:29`), so a door that read the first would check a team the run
// never reaches. A grant that lists entities refuses the line; a wildcard grant is unchanged. The
// three spellings are `--name a --name b`, `--name=a --name b` and `--name a --name=b`.
function repeated(option: string, first: string, last: string): string[][] {
  return [
    [`--${option}`, first, `--${option}`, last],
    [`--${option}=${first}`, `--${option}`, last],
    [`--${option}`, first, `--${option}=${last}`],
  ];
}

test('down --file named twice: the line is refused rather than checked against one of the files', () => {
  // The granted team first, then another team's file: the command would act on the other team.
  for (const form of repeated('file', files.alpha, files.beta)) {
    targetRefused(door('down', ['--dry-run', ...form], alphaGrant), 'named more than once');
  }
  // The other order too: the door does not pick a value, so neither position decides the line.
  for (const form of repeated('file', files.beta, files.alpha)) {
    targetRefused(door('down', ['--dry-run', ...form], alphaGrant), 'named more than once');
  }
  // The same file twice names one team and is still refused: the option is what the command
  // reads once, not its value.
  targetRefused(door('down', ['--dry-run', '--file', files.alpha, '--file', files.alpha], alphaGrant), 'named more than once');
  // A grant that lists no entity resolves no target, exactly as before.
  admitted(door('down', ['--dry-run', '--file', files.alpha, '--file', files.beta], wildcard));
});

test('every command whose --file is the team file refuses it named twice', () => {
  for (const [name, words] of FILE_ROWS) {
    const path = words[1] as string;
    for (const form of repeated('file', files.alpha, path)) {
      targetRefused(door(name, form, alphaGrant), 'named more than once');
    }
  }
});

test('--session named twice: the command would take the last session, so the line is refused', () => {
  for (const name of ['add', 'brief', 'down', 'drops', 'mcp', 'watch', 'worktree']) {
    for (const form of repeated('session', 'alpha', 'beta')) {
      targetRefused(door(name, form, alphaGrant), 'named more than once');
    }
  }
  admitted(door('down', ['--dry-run', '--session', 'alpha', '--session', 'beta'], wildcard));
});

test('registry-key targets named twice are refused the same way', () => {
  targetRefused(door('status', ['--project', 'alpha', '--project', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('seats', ['--project', 'alpha', '--project', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('policy', ['set', 'seat-numbering', 'width=2', '--entity', 'alpha', '--entity', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('policy', ['set', 'seat-numbering', 'width=2', '--project', 'alpha', '--project', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('grant', ['--grant-team', 'alpha', '--grant-team', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('grant', ['--grant-entity', 'alpha', '--grant-entity', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('grant', ['--grant-project', 'alpha', '--grant-project', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('setup', ['--roots', roots.alpha, '--roots', roots.beta], alphaGrant), 'named more than once');
  targetRefused(door('owner-seat', ['setup', '--team', 'owner', '--signer', 'touch-id', '--entity', 'alpha', '--entity', 'beta'], alphaGrant), 'named more than once');
  // `--team` is a target option of its own on pause and resume, and of owner-seat's setup.
  targetRefused(door('pause', ['--team', 'alpha', '--team', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('resume', ['--team', 'alpha', '--team', 'beta'], alphaGrant), 'named more than once');
  targetRefused(door('pause', ['--seat', 'lead', '--seat', 'lead'], alphaGrant), 'named more than once');
  targetRefused(door('owner-seat', ['setup', '--team', 'alpha', '--team', 'beta', '--signer', 'touch-id'], alphaGrant), 'named more than once');
  // A wildcard grant still admits every one of them.
  admitted(door('status', ['--project', 'alpha', '--project', 'beta'], wildcard));
  admitted(door('grant', ['--grant-team', 'alpha', '--grant-team', 'beta'], wildcard));
});

test('pause --team twice: the last team is the one the command would pause, so the line is refused', () => {
  for (const form of repeated('team', 'alpha', 'beta')) {
    targetRefused(door('pause', form, alphaGrant), 'named more than once');
  }
  for (const form of repeated('team', 'beta', 'alpha')) {
    targetRefused(door('pause', form, alphaGrant), 'named more than once');
  }
  admitted(door('pause', ['--team', 'alpha'], alphaGrant));
});

// The one command that reads an option as a whole list: every `--root` is collected
// (`src/commands/daemon.ts:126`), so the door and the command read the same roots and a repeat
// names no second team. The check still covers every root named.
test('daemon --root twice: the command collects every root, so the door reads them the same way', () => {
  admitted(door('daemon', ['install', '--dry-run', '--root', roots.alpha, '--root', roots.delta], alphaGrant));
  refused(door('daemon', ['install', '--dry-run', '--root', roots.alpha, '--root', roots.beta], alphaGrant), 'does not cover entity "beta"');
  refused(door('daemon', ['install', '--dry-run', `--root=${roots.alpha}`, '--root', roots.beta], alphaGrant), 'does not cover entity "beta"');
});

// `down --abandon` is the op-changing flag: the command reads one op, and the `=` spelling is the
// parser's unknown option.
test('down --abandon named twice, or with a value: the op the door reads is the one the command reads', () => {
  refused(door('down', ['--abandon', '--abandon'], alphaAbandonGrant), 'named more than once');
  // The `=` spelling is read as a value of `down`, so a grant that covers `down` reaches the
  // refusal that names the spelling (a grant for `abandon` alone already refuses the op).
  refused(door('down', [`--abandon=true`], alphaDownGrant), 'takes no value');
  refused(door('down', ['--abandon', '--abandon=true'], alphaAbandonGrant), 'takes no value');
  admitted(door('down', ['--abandon'], alphaAbandonGrant));
  admitted(door('down', ['--abandon', '--abandon'], wildcard));
});

test('batch --do: a piece that names its target twice is refused the way its own line is', () => {
  targetRefused(door('batch', ['--request', '--do', 'down', '--dry-run', '--file', files.alpha, '--file', files.beta], alphaGrant), 'named more than once');
  targetRefused(door('batch', ['--request', '--do', 'down', '--dry-run', '--file', files.beta, '--file', files.alpha], alphaGrant), 'named more than once');
  refused(door('batch', ['--request', '--do', 'send', 'builder-6@beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('batch', ['--request', '--do', 'down', '--dry-run', '--file', files.alpha], alphaGrant));
});

// `team mcp serve` without `--file` places the seat by the registry record whose roster holds it,
// narrowed by `--session` (`src/mcp/serve.ts:605`): that record's team is the target.
test('mcp serve --seat: the registry record that holds the seat names the team', () => {
  // builder-7 is on beta's and gamma's rosters; the session narrows to one of them.
  refused(door('mcp', ['serve', '--seat', 'builder-7', '--session', 'beta'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('mcp', ['serve', '--seat', 'builder-7', '--session', 'beta'], betaGrant));
  refused(door('mcp', ['serve', '--seat', 'builder-7', '--session', 'gamma'], betaGrant), 'does not cover entity "gamma"');
  admitted(door('mcp', ['serve', '--seat', 'builder-7', '--session', 'gamma'], allGrant));
  // No session, or one no record names: the two holders stand, and the door cannot name one team.
  targetRefused(door('mcp', ['serve', '--seat', 'builder-7'], alphaGrant), 'pass --file');
  targetRefused(door('mcp', ['serve', '--seat', 'builder-7', '--session', 'nowhere'], alphaGrant), 'pass --file');
  // `--file` is the launch's own team file, and it decides ahead of the roster.
  admitted(door('mcp', ['serve', '--seat', 'builder-7', '--file', files.alpha, '--session', 'gamma'], alphaGrant));
  refused(door('mcp', ['serve', '--seat', 'builder-7', '--file', files.alpha, '--session', 'gamma'], betaGrant), 'does not cover entity "alpha"');
  targetRefused(door('mcp', ['serve', '--seat', 'no-such-seat'], alphaGrant), 'no registered team holds seat');
  targetRefused(door('mcp', ['serve', '--seat', 'builder-7', '--seat', 'lead'], alphaGrant), 'named more than once');
});

// owner-seat setup without `--entity` records the team name as the entity
// (`src/client/owner-seat.ts:196`), so that channel names the entity the grant must cover.
test('owner-seat setup --team: the record\'s entity is the team name when --entity is absent', () => {
  refused(door('owner-seat', ['setup', '--team', 'beta', '--signer', 'touch-id'], alphaGrant), 'does not cover entity "beta"');
  admitted(door('owner-seat', ['setup', '--team', 'beta', '--signer', 'touch-id'], betaGrant));
  admitted(door('owner-seat', ['setup', '--team', 'beta', '--signer', 'touch-id'], wildcard));
});

// `up` reads `--general` itself and resolves the file from the parse the launch runs on, so a
// repeated option is read the same way twice: the launch's team is the last one named.
test('up --file twice: the door checks the file the launch reads', async () => {
  const last = await up(['--file', files.alpha, '--file', files.beta, '--dry-run'], betaGrant);
  expect(last.err).toContain('admitted by general grant');
  const other = await up(['--file', files.alpha, '--file', files.beta, '--dry-run'], alphaGrant);
  expect(other.code).toBe(1);
  expect(other.err).toContain('does not cover entity "beta"');
});

test('a repeated target option names the target exit id', async () => {
  let out = '';
  const io: Io = { stdout: (text) => { out += text; }, stderr: () => {}, cwd: roots.alpha, env: { HOME: home }, stdinIsTTY: false };
  const code = await main(['down', '--dry-run', '--file', files.alpha, '--file', files.beta, '--json', '--general', alphaGrant, '--key', client.path], io);
  expect(code).toBe(1);
  expect(JSON.parse(out).error.id).toBe('team.general-target');
});


// The door decides on the values the command will act on after the command's own normalisation.
// These scenes hold the padded spellings of every target option next to the plain ones: a padding
// the command trims names the trimmed team, and a padding it does not trim names no team at all —
// never silently this folder's team.
test('a padded --file, --session, --root or registry key names no team', () => {
  // `--file` is resolved as written, by the same loader the command calls.
  targetRefused(door('down', ['--dry-run', '--file', ` ${files.beta} `], alphaGrant), 'cannot be resolved');
  // A session key is matched as written; a padded one names no team.
  targetRefused(door('down', ['--session', ' beta '], alphaGrant), 'session');
  // `--root` is resolved as written.
  targetRefused(door('daemon', ['run', '--root', ` ${roots.beta} `], alphaGrant), 'cannot be resolved');
  // A registry key is matched as written.
  targetRefused(door('status', ['--project', ' beta '], alphaGrant), 'can be resolved');
  // A `--roots` list is trimmed part by part, by the command and the door alike.
  admitted(door('setup', ['--signer', 'touch-id', '--roots', ` ${roots.alpha} `], alphaGrant));
  refused(door('setup', ['--signer', 'touch-id', '--roots', ` ${roots.alpha} `], betaGrant), 'does not cover entity "alpha"');
  // The comma lists of `grant` are trimmed the same way.
  refused(door('grant', ['--client', 'master', '--allow-grant', '--grant-team', ' beta '], alphaGrant), 'does not cover entity "beta"');
});

test('pause and resume: --team and --seat are read with the trim the commands apply', () => {
  admitted(door('pause', ['--team', ' alpha '], alphaGrant));
  refused(door('pause', ['--team', ' beta '], alphaGrant), 'does not cover entity "beta"');
  admitted(door('resume', ['--team', ' alpha '], alphaGrant));
  refused(door('resume', ['--team', ' beta '], alphaGrant), 'does not cover entity "beta"');
  admitted(door('pause', ['--seat', ' lead '], alphaGrant));
  refused(door('resume', ['--seat', ' lead '], betaGrant), 'does not cover entity "alpha"');
});

test('policy --entity and --project are read with the trim and the project id the command uses', () => {
  admitted(door('policy', ['set', 'entity', 'p', 'v', '--entity', ' alpha '], alphaGrant));
  refused(door('policy', ['set', 'entity', 'p', 'v', '--entity', ' beta '], alphaGrant), 'does not cover entity "beta"');
  admitted(door('policy', ['set', 'entity', 'p', 'v', '--project', ' beta '], betaGrant));
  refused(door('policy', ['set', 'entity', 'p', 'v', '--project', ' beta '], alphaGrant), 'does not cover entity "beta"');
  // The command keys the rule by `projectIdOf(name)`, so a differently-cased name is that record.
  refused(door('policy', ['set', 'entity', 'p', 'v', '--project', 'Beta'], alphaGrant), 'does not cover entity "beta"');
});

test('a send address is read by the command\'s own parse, padded or mistyped', () => {
  // A padded agent-id spelling is a plain seat to `parseSpec`, so it names this folder's team.
  admitted(door('send', [' agt_0123456789ab ', 'hi'], alphaGrant));
  refused(door('send', [' agt_0123456789ab ', 'hi'], betaGrant), 'does not cover entity "alpha"');
  // A mistyped id is refused by that parse before any team is named.
  targetRefused(door('send', ['agt_0123456789', 'hi'], alphaGrant), 'not an agent id');
  // A padded `seat@team` keeps its scope; the padding is not part of the team named.
  targetRefused(door('send', [' builder-6@beta ', 'hi'], alphaGrant), 'can be resolved');
  // A `@nickname` is a seat of this folder's team, padded or not.
  admitted(door('send', ['@builder-6 ', 'hi'], alphaGrant));
  refused(door('send', ['@builder-6 ', 'hi'], betaGrant), 'does not cover entity "alpha"');
});

test('mcp serve: a padded seat or session places no team, as the command reads them', () => {
  targetRefused(door('mcp', ['serve', '--seat', ' builder-7 '], alphaGrant), 'no registered team holds seat');
  // A padded session does not narrow the two holders, exactly as the command's comparison does not.
  targetRefused(door('mcp', ['serve', '--seat', 'builder-7', '--session', ' beta '], alphaGrant), 'pass --file');
  targetRefused(door('mcp', ['serve', '--seat', 'builder-7', '--file', ` ${files.beta} `], alphaGrant), 'cannot be resolved');
});
