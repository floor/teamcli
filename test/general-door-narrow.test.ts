// 0.5.10's narrow door, measured on synthetic homes: a wildcard grant (entities `*`) admits the
// command as the owner, a grant that lists entities is refused with one sentence before anything
// runs, and the op checked is the one the line reaches — `down --abandon` is `abandon`, not
// `down`, and `seat add` is `add`, not `seat`. No team target is read: with the wildcard the only
// admitted shape, the command's own parser decides what it acts on. Synthetic homes and teams
// only: no real team, pane or registry is read.
import { afterAll, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Door, generalDoor, VALUED } from '../src/client/general-door.ts';
import { FLAG_OPS, GENERAL_OPS, GENERAL_REFUSED_COMMANDS, issueOwnerGeneralGrant, SCOPED_GRANT_REFUSAL, type GrantOp, VERB_OPS } from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import { actionRequestsFolder } from '../src/client/team-create.ts';
import { commands, main } from '../src/cli.ts';
import { runConfig } from '../src/commands/config.ts';
import { runDaemon } from '../src/commands/daemon.ts';
import { runDrops } from '../src/commands/drops.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runInit } from '../src/commands/init.ts';
import { plantRecord } from '../src/commands/messages.ts';
import { readTeamConfig } from '../src/file/team-config.ts';
import type { ServiceManager, ServiceProgram } from '../src/daemon/service.ts';
import type { Io } from '../src/io.ts';
import { readStoredTeamConfig } from '../src/registry/team-config-store.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { receiptFile } from '../src/send/record.ts';
import { installKey } from '../src/store/keys.ts';
import { gitEnv } from './helpers.ts';
import { seatOwner } from './helpers/owner-seat.ts';
import { intoRegistry } from './helpers/registry-team.ts';

const base = realpathSync(mkdtempSync(join(process.cwd(), '.gg-narrow-')));
const home = join(base, 'home');
const roots = { alpha: join(base, 'alpha'), beta: join(base, 'beta') };
const files = { alpha: join(roots.alpha, '.agents', 'team.yaml'), beta: join(roots.beta, '.agents', 'team.yaml') };
let client: { pub: string; path: string };
let wildcard: string;
let alphaGrant: string;

function teamText(project: string, entity: string): string {
  return `format: 1
project: ${project}
entity: ${entity}
coordinator: lead
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

function register(name: keyof typeof roots): void {
  const root = roots[name];
  mkdirSync(join(root, '.agents'), { recursive: true });
  writeFileSync(files[name], teamText(name, name));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
  intoRegistry(root, home);
  // The team registry record a real add/up leaves: the daemon's root and the config record both
  // read it.
  upsertTeam(home, teamIdOf(root), { project: name, entity: name, session: name, root, roster: [], lifecycle: 'running', by: 'scene' });
}

function grantOf(entities: string[], ops: GrantOp[]): string {
  const issued = issueOwnerGeneralGrant(home, { clientId: 'client-a', publicKey: client.pub, entities, ops, mayIssue: false, expires: new Date(Date.now() + 86_400_000) });
  if (!issued.ok) throw new Error(issued.why);
  return issued.path;
}

mkdirSync(home, { recursive: true });
installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));
const ownerStore = seatOwner(home);
const pair = newClientKeyPair();
const written = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-a'), pair);
if (!written.ok) throw new Error(written.why);
client = { pub: pair.publicKey, path: written.keyPath };
register('alpha');
// Beta's team file exists for the P1 proof's --file: the narrow door refuses the grant before it
// reads any file, so the scene proves the line is never checked against it.
mkdirSync(join(roots.beta, '.agents'), { recursive: true });
writeFileSync(files.beta, teamText('beta', 'beta'));
wildcard = grantOf(['*'], ['*']);
alphaGrant = grantOf(['alpha'], ['*']);
// A git repository with no team yet: `team init` writes its first record here, and a request
// would be recorded under this scene's own home (the owner seat above makes that possible).
const fresh = join(base, 'fresh');
mkdirSync(fresh, { recursive: true });
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh, env: gitEnv() });

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function io(cwd: string = roots.alpha, env: Record<string, string | undefined> = { HOME: home }): Io & { out: string; err: string } {
  const made = { out: '', err: '', stdout: (text: string) => { made.out += text; }, stderr: (text: string) => { made.err += text; }, cwd, env, stdinIsTTY: false };
  return made as Io & { out: string; err: string };
}

function door(name: string, words: string[], grantPath: string, env: Io = io()): Door {
  return generalDoor(name, [...words, '--general', grantPath, '--key', client.path], env);
}

function whyOf(result: Door): string {
  return 'why' in result ? `: ${result.why}` : '';
}

function admitted(result: Door): void {
  if (result.kind !== 'admitted') throw new Error(`expected admitted, got ${result.kind}${whyOf(result)}`);
}

function scopedRefusal(result: Door): void {
  if (result.kind !== 'target') throw new Error(`expected target, got ${result.kind}${whyOf(result)}`);
  expect(result.why).toBe(SCOPED_GRANT_REFUSAL);
}

test('the scoped-grant refusal is one sentence, word for word', () => {
  expect(SCOPED_GRANT_REFUSAL).toBe('scoped general grants arrive in 0.5.11; use a wildcard grant or the owner path');
});

// The door reads a line with the command's own valued options; the contract says which they are,
// so an option added to a command cannot be read as a flag here without this going red. A
// command's subcommand forms carry their own flags in the contract, and the door sees one line,
// so the union over the command and its subcommands is the table it reads.
test("the door's valued-option table is the contract's, less --general and --key", () => {
  type Flag = { name: string; takesValue: boolean };
  type Command = { name: string; hidden: boolean; flags: Flag[]; subcommands: Command[] };
  const contract = JSON.parse(readFileSync(join(import.meta.dir, '..', 'contract', 'cli.json'), 'utf8')) as { commands: Command[] };
  const valuedOf = (flags: Flag[]): string[] => flags.filter((flag) => flag.takesValue).map((flag) => flag.name.replace(/^--/, ''));
  const expected = Object.fromEntries(
    contract.commands
      .filter((command) => !command.hidden && !GENERAL_REFUSED_COMMANDS.has(command.name))
      .map((command) => [
        command.name,
        [...valuedOf(command.flags), ...command.subcommands.flatMap((sub) => valuedOf(sub.flags))]
          .filter((name) => name !== 'general' && name !== 'key')
          .filter((name, index, all) => all.indexOf(name) === index)
          .sort(),
      ]),
  );
  const held = Object.entries(VALUED).map(([name, list]) => [name, [...list].sort()]);
  expect(Object.fromEntries(held)).toEqual(expected);
});

for (const [spelling, id] of [
  ['space', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'],
  ['equals', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee6'],
] as const) {
  test(`a general grant cannot select another seat's drop by id (${spelling})`, async () => {
    const root = roots.alpha;
    const loaded = readTeamConfig(root, { home });
    if (!loaded.ok) throw new Error('the synthetic team could not be read');
    const seat = loaded.team.orchestrator;
    const body = 'inbox-id-guard-4a71';
    const record = plantRecord(home, root, loaded.team.session, seat, id, body, { at: new Date().toISOString(), from: seat });
    const bytes = readFileSync(record);
    const receipt = receiptFile(dirname(record), id, 'read');
    const replied = receiptFile(dirname(record), id, 'replied');
    const named = spelling === 'space' ? ['--id', id] : [`--id=${id}`];
    const words = ['--read', '--seat', seat, ...named];
    // The same named drop is available to the normal owner path, without settling it.
    const owner = io(root);
    owner.caller = { kind: 'owner' };
    expect(await runDrops(words, owner, { home }), owner.err).toBe(0);
    expect(owner.out).toContain(body);
    expect(existsSync(receipt)).toBe(false);
    const json = spelling === 'equals';
    const request = spawnSync(process.execPath, ['--no-env-file', join(import.meta.dir, '..', 'src', 'cli.ts'), 'drops', ...words, ...(json ? ['--json'] : []), '--general', wildcard, '--key', client.path], {
      cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20_000,
    });
    expect(request.error).toBeUndefined();
    expect(request.status, `${request.stdout}${request.stderr}`).toBe(1);
    if (json) expect(JSON.parse(request.stdout).error.id).toBe('team.general-refused');
    else {
      expect(request.stdout).toBe('');
      expect(request.stderr).toContain('--id takes no --general');
    }
    expect(`${request.stdout}${request.stderr}`).not.toContain(body);
    expect(readFileSync(record)).toEqual(bytes);
    expect(existsSync(receipt)).toBe(false);
    expect(existsSync(replied)).toBe(false);
  });
}

// The op a line reaches is the one mapping's: every op no command names is reached by a flag or a
// verb (today that is `abandon`, through `down --abandon`), and every mapped op is a known one.
test('the flag and verb op maps name known ops and leave no op unreachable', () => {
  const mapped = [...Object.values(FLAG_OPS).flatMap((entries) => Object.values(entries)), ...Object.values(VERB_OPS).flatMap((entries) => Object.values(entries))];
  for (const op of mapped) expect(GENERAL_OPS as readonly string[]).toContain(op);
  const byName = new Set(Object.keys(commands));
  expect(GENERAL_OPS.filter((op) => !byName.has(op) && !mapped.includes(op))).toEqual([]);
});

// A wildcard grant, shaped like the owner's machine grant: unchanged admission.
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
  const scene = io();
  const result = generalDoor('daemon', ['install', '--dry-run', '--root', roots.alpha, '--general', wildcard, '--key', client.path], scene);
  expect(result.kind).toBe('admitted');
  if (result.kind !== 'admitted') return;
  const code = await runDaemon(result.argv, result.io, { home, service: fakeService(), program: { execPath: '/bin/node', entry: '/x/cli.js' } });
  expect(code, `${scene.out}${scene.err}`).toBe(0);
  expect(scene.out).toContain('would install');
});

test('a wildcard grant still admits a config set on this folder\'s team, and the write lands', async () => {
  const scene = io(roots.alpha);
  const code = await runConfig(['set', 'project', 'alpha-two', '--general', wildcard, '--key', client.path], scene, { home, env: { TEAM_CONFIG_SOURCE: 'registry' } });
  expect(code, `${scene.out}${scene.err}`).toBe(0);
  expect(scene.err).toContain('admitted by general grant');
  const stored = readStoredTeamConfig(home, teamIdOf(roots.alpha));
  expect(stored?.text).toContain('project: alpha-two');
});

test('a wildcard grant still admits down --abandon', () => {
  admitted(door('down', ['--abandon'], wildcard));
});

// The send-grant form, met by this narrow door at the merge: `team grant --send` reads its pair
// from --from and --to (src/commands/grant.ts), so the door reads those two options as values the
// command consumes (VALUED.grant), never as flags. The wildcard grant admits the line as the
// `grant` op, the command's own parser plans the record with the pair, and a grant that lists
// entities is still refused before it is read. Admission here is the wildcard's; this change
// teaches the door the two valued options and widens no admission.
test("team grant --send's --from and --to are values, and the wildcard admits the line", async () => {
  const words = ['--send', '--from', 'lead@alpha', '--to', 'lead@beta', '--expires', '2027-06-01T00:00:00Z', '--dry-run'];
  const scene = io();
  const result = door('grant', words, wildcard, scene);
  admitted(result);
  if (result.kind !== 'admitted') return;
  // The pair reaches the command exactly as written: the door took only --general and --key off.
  expect(result.argv).toEqual(words);
  const code = await runGrant(result.argv, result.io, { home });
  expect(code, `${scene.out}${scene.err}`).toBe(0);
  expect(scene.out).toContain('would write the send grant');
  expect(scene.out).toContain('from lead@alpha to lead@beta');
  // The narrow door's rule still stands for this line: entities listed, refused.
  scopedRefusal(door('grant', words, alphaGrant));
  // And an op list without `grant` is still not admitted.
  const opRefusal = door('grant', words, grantOf(['*'], ['send']));
  expect(opRefusal.kind).toBe('refused');
  if (opRefusal.kind === 'refused') expect(opRefusal.why).toContain('does not cover grant');
});

// The listed-ops grant the orchestrator's scenes name: entities `*`, these ops only.
const listed = (): string => grantOf(['*'], ['config', 'restart', 'up', 'down', 'abandon', 'send', 'messages', 'reply']);

test('a grant whose entities are all and whose ops are listed admits exactly those ops', () => {
  admitted(door('send', ['lead', 'body'], listed()));
  admitted(door('messages', [], listed()));
  admitted(door('reply', ['r_1', 'pong'], listed()));
  admitted(door('restart', ['lead'], listed()));
  admitted(door('down', [], listed()));
  admitted(door('down', ['--abandon'], listed()));
  const status = door('status', [], listed());
  expect(status.kind).toBe('refused');
  if (status.kind === 'refused') expect(status.why).toContain('does not cover status');
});

test('a seat verb is the op of the command it dispatches to: seat add is add', () => {
  const addOnly = grantOf(['*'], ['add']);
  const seatOnly = grantOf(['*'], ['seat']);
  admitted(door('seat', ['add', 'builder-6'], addOnly));
  const refusedSeat = door('seat', ['add', 'builder-6'], seatOnly);
  expect(refusedSeat.kind).toBe('refused');
  if (refusedSeat.kind === 'refused') expect(refusedSeat.why).toContain('does not cover add');
  admitted(door('seat', ['restart', 'builder-6'], grantOf(['*'], ['restart'])));
});

test('down --abandon is the abandon op, not the down op', () => {
  const downOnly = door('down', ['--abandon'], grantOf(['*'], ['down']));
  expect(downOnly.kind).toBe('refused');
  if (downOnly.kind === 'refused') expect(downOnly.why).toContain('does not cover abandon');
  admitted(door('down', ['--abandon'], grantOf(['*'], ['abandon'])));
});

test('an op flag named twice, or with a value, is refused as the command would read it', () => {
  const twice = door('down', ['--abandon', '--abandon'], wildcard);
  expect(twice.kind).toBe('refused');
  if (twice.kind === 'refused') expect(twice.why).toContain('named more than once');
  const valued = door('down', ['--abandon=true'], wildcard);
  expect(valued.kind).toBe('refused');
  if (valued.kind === 'refused') expect(valued.why).toContain('takes no value');
  admitted(door('down', ['--abandon'], wildcard));
});

// P1-1 and P1-2, the two proofs the wide door was opened by, and the fourth bypass's line
// (`send --record`): each refuses on the grant alone, before the file, address or record is read.
test('a grant that lists entities is refused before anything runs, whatever the line names', () => {
  scopedRefusal(door('status', [], alphaGrant));
  scopedRefusal(door('down', ['--dry-run', '--file', files.beta], alphaGrant));
  scopedRefusal(door('send', ['lead@beta', 'body'], alphaGrant));
  scopedRefusal(door('send', ['--record', 'lead@beta', '--channel', 'native', '--ms', '1', '--dry-run', '--json'], alphaGrant));
});

test('a scoped grant is refused the same way for a repeated, padded or valued option', () => {
  scopedRefusal(door('down', ['--dry-run', '--file', files.alpha, '--file', files.beta], alphaGrant));
  scopedRefusal(door('down', ['--dry-run', '--file', ` ${files.beta} `], alphaGrant));
  scopedRefusal(door('send', ['lead', 'body', '--file', 'note.txt'], alphaGrant));
  scopedRefusal(door('daemon', ['install', '--dry-run', '--root', roots.beta], alphaGrant));
});

test('the scoped refusal is the dispatch exit id, and nothing runs', async () => {
  const scene = io();
  const code = await main(['status', '--general', alphaGrant, '--key', client.path], scene);
  expect(code).toBe(1);
  expect(scene.err).toContain(SCOPED_GRANT_REFUSAL);
  expect(scene.out).toBe('');
  const json = io();
  const refusedJson = await main(['status', '--json', '--general', alphaGrant, '--key', client.path], json);
  expect(refusedJson).toBe(1);
  expect(JSON.parse(json.out).error.id).toBe('team.general-target');
});

// operator-3's review: up, init and config read --general with their own admission, and their
// owner-seat branches ran first — a request was recorded, an approval listed, a signed edit
// written — so a grant that lists entities was never read. The dispatcher now reads a present
// --general before the command sees the line: the scoped refusal lands on every path, and
// nothing is recorded, asked or written.
function ownDoor(name: string, words: string[], grantPath: string, cwd: string = roots.alpha): Door {
  return generalDoor(name, [...words, '--general', grantPath, '--key', client.path], io(cwd));
}

test('the owner-seat branches do not get around the refusal: init --request, init --approvals, config set --request and config keys all refuse on the grant', () => {
  const recordBefore = readStoredTeamConfig(home, teamIdOf(roots.alpha))?.text;
  scopedRefusal(ownDoor('init', ['--request'], alphaGrant, fresh));
  scopedRefusal(ownDoor('init', ['--approvals'], alphaGrant, fresh));
  scopedRefusal(ownDoor('config', ['set', 'project', 'alpha-two', '--request'], alphaGrant));
  scopedRefusal(ownDoor('config', ['keys'], alphaGrant));
  expect(existsSync(actionRequestsFolder(home))).toBe(false);
  expect(existsSync(join(fresh, '.agents', 'team.yaml'))).toBe(false);
  expect(readStoredTeamConfig(home, teamIdOf(roots.alpha))?.text).toBe(recordBefore);
});

test('--general beside the owner-seat door is a usage error: a grant and a request are two doors', () => {
  const usage = (result: Door): void => {
    expect(result.kind).toBe('usage');
    if (result.kind === 'usage') expect(result.why).toContain('--general is its own door');
  };
  usage(ownDoor('init', ['--request'], wildcard, fresh));
  usage(ownDoor('init', ['--approvals'], wildcard, fresh));
  usage(ownDoor('init', ['--approve-as-owner-seat', 'tc_0123456789abcdef01234567', 'oui'], wildcard, fresh));
  usage(ownDoor('config', ['set', 'project', 'alpha-two', '--request'], wildcard));
  usage(ownDoor('config', ['set', 'project', 'alpha-two', '--approval', 'oa_nope'], wildcard));
  usage(ownDoor('up', ['--request'], wildcard));
  // The command never runs on any of these: the record is the one the earlier set left.
  expect(readStoredTeamConfig(home, teamIdOf(roots.alpha))?.text).toContain('project: alpha-two');
});

// operator-3's second review: with entities `*` and ops `send` only, config keys and init
// --approval-modes both ran (exit 0): ownGeneral checked the entity shape, and those bodies
// never reach admitGeneral. Neither command is owner-gated — config keys lists the static
// settings registry (src/commands/config.ts:83, with no callerOf on that path) and init
// --approval-modes lists the approval-mode records (src/commands/init.ts:298, before the
// actionOutcome return at src/commands/init.ts:343) — so any caller runs them and a grant adds
// nothing. `--general` on either is now a usage error rather than silently ignored.
test('without --general a seat runs config keys and init --approval-modes: neither reads a grant', async () => {
  const seat = { kind: 'seat' as const, name: 'probe', pane: 'pane1', session: 'acme' };
  const keys = io(roots.alpha);
  keys.caller = seat;
  expect(await runConfig(['keys'], keys, { home, env: { TEAM_CONFIG_SOURCE: 'registry' } })).toBe(0);
  const modes = io(fresh);
  modes.caller = seat;
  const code = await runInit(['--approval-modes'], modes, home, undefined, { loggedIn: () => true, ownerSeatStore: ownerStore, now: () => new Date() });
  expect(code, `${modes.out}${modes.err}`).toBe(0);
  expect(modes.out).toContain('team init: approval modes');
});

test('a grant whose ops do not cover them is not silently ignored: config keys and init --approval-modes take no --general', async () => {
  const sendOnly = grantOf(['*'], ['send']);
  const keys = door('config', ['keys'], sendOnly);
  expect(keys.kind).toBe('usage');
  if (keys.kind === 'usage') expect(keys.why).toContain('takes no --general');
  const modes = door('init', ['--approval-modes'], sendOnly, io(fresh));
  expect(modes.kind).toBe('usage');
  if (modes.kind === 'usage') expect(modes.why).toContain('takes no --general');
  // The dispatcher stops the line, so the command prints nothing and exits 2.
  const scene = io();
  expect(await main(['config', 'keys', '--general', sendOnly, '--key', client.path], scene)).toBe(2);
  expect(scene.err).toContain('takes no --general');
  expect(scene.out).toBe('');
});

// init's singular --approval-mode and --revoke-approval branches run before the
// command's own --general admission, so a readable grant on either would be taken and silently
// ignored. Both are refused as usage instead.
test('a grant does not reach init --approval-mode or init --revoke-approval: both take no --general', async () => {
  const sendOnly = grantOf(['*'], ['send']);
  const forms = [['--approval-mode', 'per-action', '--scope', '.'], ['--revoke-approval', `tc_${'ab'.repeat(12)}`]];
  for (const words of forms) {
    const result = door('init', words, sendOnly, io(fresh));
    expect(result.kind, whyOf(result)).toBe('usage');
    if (result.kind === 'usage') expect(result.why).toContain('takes no --general');
  }
  // The dispatcher stops the line, so the command prints nothing and exits 2.
  const scene = io(fresh);
  expect(await main(['init', '--approval-mode', 'per-action', '--scope', '.', '--general', sendOnly, '--key', client.path], scene)).toBe(2);
  expect(scene.err).toContain('takes no --general');
  expect(scene.out).toBe('');
});

// The exact line operator-3 ran: an owner seat is registered, and `team init --request` with a
// grant that lists entities recorded a request and exited 0. In a child whose HOME is the
// scene's own, it now stops at the dispatcher: exit 1, the one sentence, no request file.
test('team init --request under a grant that lists entities records nothing', () => {
  const run = spawnSync(process.execPath, [join(import.meta.dir, '..', 'src', 'cli.ts'), 'init', '--request', '--general', alphaGrant, '--key', client.path], {
    cwd: fresh,
    env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
    encoding: 'utf8',
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(1);
  expect(run.stderr).toContain(SCOPED_GRANT_REFUSAL);
  expect(run.stdout).toBe('');
  expect(existsSync(actionRequestsFolder(home))).toBe(false);
  expect(existsSync(join(fresh, '.agents', 'team.yaml'))).toBe(false);
});
