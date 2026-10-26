// The who-may-run row the contract carries per command: one row per command, its gate read
// from the gate map rather than restated, and a guard that fails when a gate changes and the
// checked-in contract does not. The generation proof runs the real check script over a copy of
// the tree whose map carries one changed gate, with the tree's own contract files in place, so
// a difference in the answer can only come from the gate the map now holds.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller, SeatStanding } from '../../src/caller.ts';
import { commands } from '../../src/cli.ts';
import { COMMAND_GATES, type Gate } from '../../src/permissions/map.ts';
import { resolvePermission, type CallerRecord } from '../../src/permissions/resolve.ts';
import { resolveCaller, type BridgeTeam } from '../../src/permissions/who.ts';

type Who = { gate: string; why: string; terminal?: { who: string; where: string } };
type Node = { name: string; hidden: boolean; who?: Who; subcommands?: Node[] };

const root = join(import.meta.dir, '..', '..');
const contract = JSON.parse(readFileSync(join(root, 'contract/cli.json'), 'utf8')) as {
  program: Node;
  commands: Node[];
};

/** The closed vocabulary a who row may use: the map's own gate kinds, and `unlisted` for a word
 *  the map does not name. A new kind must be added here with the page that explains it. */
const GATE_WORDS = [
  'owner-only',
  'owner-or-leads',
  'owner-or-own-team',
  'seat-record',
  'capability',
  'admission',
  'pane-authority',
  // The three kinds the map grew in 0.5.2 (`map.ts:27-44`): a word that asks for no record, a
  // seat of the team on its recorded pane, and a seat the file marks `leads`.
  'any-caller',
  'seat-only',
  'leads-only',
  // The three named after the verdict function their module calls: `mayChangeTeamVerdict`,
  // `mayPauseTeamVerdict` (src/caller.ts, called by src/commands/pause.ts and resume.ts) and
  // `mayReadTeam`. A row whose module also refuses a detached run carries `terminal` beside
  // its kind, never a kind of its own.
  'team-change',
  'team-pause',
  'team-read',
  'unlisted',
] as const;

/** The map's row as the contract carries it: the kind and `why` it copies, and the terminal
 *  requirement when the module refuses a run with no terminal. */
function whoOf(gate: Gate): Who {
  const row: Who = { gate: gate.kind, why: gate.why };
  if (gate.terminal !== undefined) row.terminal = gate.terminal;
  return row;
}

test('every command states who may run it, in a closed vocabulary', () => {
  // Every word the CLI dispatches carries a row — the hidden faces and the help words too,
  // because the adapter that reads this file must never meet a command without an answer.
  for (const name of Object.keys(commands)) {
    expect(contract.commands.find((command) => command.name === name), `${name} is missing from the contract`).toBeDefined();
  }
  for (const command of contract.commands) {
    expect(command.who, `${command.name} carries no who row`).toBeDefined();
    expect(GATE_WORDS as readonly string[]).toContain(command.who?.gate ?? '');
    expect(command.who?.why.trim(), `${command.name} gives no reason`).not.toBe('');
    // The row is rendered beside its command, so a reason spanning lines would break the page.
    expect(command.who?.why.includes('\n'), `${command.name}'s reason spans lines`).toBe(false);
  }
  // The program node is not a word of its own and states no row; the adapter never exposes it.
  expect(contract.program.who).toBeUndefined();
});

test('the row the contract carries is the map row as it stands, and silence reads unlisted', () => {
  const contractNames = new Set(contract.commands.map((command) => command.name));
  for (const [name, gate] of Object.entries(COMMAND_GATES)) {
    // Rows naming no command (the capability words, the Runtime words with no module) cannot be
    // the row of a command the adapter exposes; the contract is about commands.
    if (!contractNames.has(name)) continue;
    expect(contract.commands.find((command) => command.name === name)?.who, `${name} does not repeat the map's row`).toEqual(
      whoOf(gate),
    );
  }
  for (const command of contract.commands) {
    const gate = COMMAND_GATES[command.name];
    // Both directions: a row the map dropped must not survive in the contract, and a word the
    // map does not name must not claim a gate. Silence is `unlisted`, never a word that reads
    // like an admission.
    if (gate === undefined) expect(command.who?.gate, `${command.name} claims a gate the map does not hold`).toBe('unlisted');
    else expect(command.who?.gate).toBe(gate.kind);
  }
  // The four kinds the 0.5.0 table gives commands, and the two whose gate lives elsewhere,
  // each name at least one command: a kind no command uses is a kind the page need not carry.
  for (const name of ['owner-only', 'owner-or-leads', 'owner-or-own-team', 'seat-record', 'admission', 'pane-authority', 'any-caller', 'seat-only', 'leads-only', 'team-change', 'team-pause', 'team-read']) {
    expect(contract.commands.some((command) => command.who?.gate === name), `no command reads ${name}`).toBe(true);
  }
});

test('every subcommand states its own row, and a module that admits only the owner reads owner-only', () => {
  // A subcommand is its own dispatched word with its own gate (`policy set` refuses a non-owner
  // where `policy` alone answers a seat's read): a node the adapter may expose needs its row,
  // exactly as a top-level command does.
  for (const command of contract.commands) {
    for (const sub of command.subcommands ?? []) {
      expect(sub.who, `${command.name} ${sub.name} carries no who row`).toBeDefined();
      expect(GATE_WORDS as readonly string[]).toContain(sub.who?.gate ?? '');
      expect(sub.who?.why.trim(), `${command.name} ${sub.name} gives no reason`).not.toBe('');
      expect(sub.who?.why.includes('\n'), `${command.name} ${sub.name}'s reason spans lines`).toBe(false);
      // The verb repeats the map row under its own `command:subcommand` key, kind and terminal
      // requirement included: a verb that gates differently from its command is never described
      // by the command's row.
      const gate = COMMAND_GATES[`${command.name}:${sub.name}`];
      expect(gate, `${command.name} ${sub.name} has no map row of its own`).toBeDefined();
      if (gate !== undefined) expect(sub.who, `${command.name} ${sub.name} does not repeat its map row`).toEqual(whoOf(gate));
    }
  }
  const commandNamed = (name: string) => contract.commands.find((command) => command.name === name);
  const subNamed = (command: string, name: string) => commandNamed(command)?.subcommands?.find((sub) => sub.name === name);
  // The gates their own modules print, in the contract's words: `policy set`/`unset` refuse every
  // non-owner; worktree's three words call `mayChangeTeamVerdict`, the map's `team-change`.
  expect(subNamed('policy', 'set')?.who?.gate).toBe('owner-only');
  expect(subNamed('policy', 'unset')?.who?.gate).toBe('owner-only');
  for (const name of ['list', 'new', 'remove']) {
    expect(subNamed('worktree', name)?.who?.gate, `worktree ${name}`).toBe('team-change');
  }
  // Words whose own module refuses every non-owner at the door: the map names the gate the
  // module enforces, and the contract repeats it — `unlisted` would leave the adapter guessing.
  for (const name of ['broker', 'tempo']) {
    expect(commandNamed(name)?.who?.gate, `${name} admits only the owner`).toBe('owner-only');
  }
  expect(commandNamed('bus')?.who?.gate, 'bus admits the owner or a leads seat').toBe('owner-or-leads');
});

test('the words the integration tip brought state rows, and pause and resume name their verdict function', () => {
  const byName = (name: string) => contract.commands.find((command) => command.name === name);
  // `sessions` lists the machine-wide registry and changes nothing: a read row that asks for no
  // caller at all, and therefore no terminal requirement either.
  expect(byName('sessions')?.who?.gate).toBe('any-caller');
  expect(byName('sessions')?.who?.terminal).toBeUndefined();
  // `pause` and `resume` are `mayPauseTeamVerdict`'s rows: the owner or the orchestrator's seat,
  // never the operator, and both modules refuse a run with no terminal through `detachedRefusal`.
  const terminal = { who: 'the owner or the orchestrator', where: 'a terminal outside herdr or its own seat' };
  for (const name of ['pause', 'resume']) {
    expect(byName(name)?.who?.gate, `${name}'s kind`).toBe('team-pause');
    expect(byName(name)?.who?.terminal, `${name}'s terminal requirement`).toEqual(terminal);
    expect(byName(name)?.who?.why, `${name}'s reason names the operator refusal`).toContain('operator is not admitted');
    // The map's row is the same row, terminal requirement included.
    expect(COMMAND_GATES[name]?.kind, `${name}'s map kind`).toBe('team-pause');
    expect(COMMAND_GATES[name]?.terminal, `${name}'s map terminal`).toEqual(terminal);
  }
  expect(COMMAND_GATES.sessions?.kind).toBe('any-caller');
  expect(COMMAND_GATES.sessions?.terminal).toBeUndefined();
});

test('the pause and resume modules call the verdict their kind is named after, and the detached refusal', () => {
  // The kind is not a word a row may adopt freely: the module itself imports and calls
  // `mayPauseTeamVerdict`, the owner-or-orchestrator function, and refuses a detached run the
  // same way its row says. A module that swapped in a copy of the rule would fail here.
  for (const name of ['pause', 'resume']) {
    const source = readFileSync(join(root, 'src/commands', `${name}.ts`), 'utf8');
    expect(source, `${name} imports mayPauseTeamVerdict`).toMatch(
      /import\s*\{[^}]*mayPauseTeamVerdict[^}]*\}\s*from\s*'\.\.\/caller\.ts'/s,
    );
    expect(source, `${name} calls mayPauseTeamVerdict`).toMatch(/mayPauseTeamVerdict\(/);
    expect(source, `${name} calls detachedRefusal`).toMatch(/detachedRefusal\(/);
  }
  // `sessions` reads the registry and gates nothing: no verdict import at all, so its row asks
  // for no caller rather than borrowing a word from the map.
  const sessions = readFileSync(join(root, 'src/commands/sessions.ts'), 'utf8');
  for (const verdict of ['mayPauseTeamVerdict', 'mayChangeTeamVerdict', 'mayReadTeam']) {
    expect(sessions.includes(verdict), `sessions does not import ${verdict}`).toBe(false);
  }
});

test('team-pause admits the owner and the orchestrator, refuses the operator, and stays closed record-only', () => {
  const TEAM = 'dddddddddddd';
  const team: BridgeTeam = {
    id: TEAM,
    orchestrator: 'lead',
    operator: 'operator',
    seats: [
      { name: 'lead', role: 'coordinator' },
      { name: 'operator', role: 'operator' },
      { name: 'worker', role: 'implementer' },
    ],
  };
  const standing = (name: string): SeatStanding => ({ session: 'orion', recordedPane: `pane-${name}` });
  const seat = (name: string): Caller => ({ kind: 'seat', name, pane: `pane-${name}`, session: 'orion' });
  const home = join(tmpdir(), 'team-pause-bridge-home');
  // The owner and the orchestrator on its recorded pane are admitted under the function's rule.
  expect(resolveCaller({ kind: 'owner' }, team, root, home, 'pause', standing('lead')).rule).toBe('team-pause');
  for (const command of ['pause', 'resume']) {
    const byOrchestrator = resolveCaller(seat('lead'), team, root, home, command, standing('lead'));
    expect(byOrchestrator.effect, `${command} admits the orchestrator`).toBe('allow');
    expect(byOrchestrator.rule).toBe('team-pause');
    // The operator is not admitted — the owner asked for this distinction, and `team hold` is
    // the operator's own stop.
    const byOperator = resolveCaller(seat('operator'), team, root, home, command, standing('operator'));
    expect(byOperator.effect, `${command} refuses the operator`).toBe('deny');
    expect(byOperator.rule).toBe('team-pause');
    expect(byOperator.why).toContain('neither the owner nor the orchestrator');
    // Another seat, and the orchestrator on a pane the state does not record, are refused too.
    expect(resolveCaller(seat('worker'), team, root, home, command, standing('worker')).effect).toBe('deny');
    expect(resolveCaller(seat('lead'), team, root, home, command, { session: 'orion', recordedPane: 'pane-elsewhere' }).rule)
      .toBe('unplaced');
  }
  // A registry record alone cannot show where a caller stands: the pure resolver refuses
  // `team-pause` closed even for a record marked as leading its team.
  const record: CallerRecord = {
    kind: 'seat',
    agent: 'agt_0123456789ab',
    seat: 'lead',
    team: TEAM,
    role: 'coordinator',
    bundle: [],
    leads: true,
  };
  for (const command of ['pause', 'resume']) {
    const decided = resolvePermission(record, { id: TEAM }, command, [], { root }, { terminal: true });
    expect(decided.effect, `${command} record-only`).toBe('deny');
    expect(decided.rule).toBe('team-pause');
    expect(decided.why).toContain('mayPauseTeamVerdict');
    // Without the terminal proof the row is refused before the kind is read.
    expect(resolvePermission(record, { id: TEAM }, command, [], { root }).rule).toBe('terminal');
  }
});

test('the reference page states every command the same row', () => {
  const page = readFileSync(join(root, 'docs/reference/cli.md'), 'utf8');
  expect(page.split('\n').filter((line) => line === '### Who may run it').length).toBe(contract.commands.length);
  for (const command of contract.commands) {
    const row = `\`${command.who?.gate}\` — ${command.who?.why}`;
    expect(page.includes(row), `the page does not state ${command.name}'s row`).toBe(true);
  }
});

test('a changed gate fails the checked-in contract, and the unchanged tree passes', () => {
  const copy = mkdtempSync(join(tmpdir(), 'team-contract-who-'));
  try {
    // A copy of the sources and the real contract files: rootOf() reads the copy, and the only
    // edit the gate-change run makes is the one row in the copy's map.
    cpSync(join(root, 'src'), join(copy, 'src'), { recursive: true });
    mkdirSync(join(copy, 'scripts'));
    cpSync(join(root, 'scripts/contract.ts'), join(copy, 'scripts/contract.ts'));
    mkdirSync(join(copy, 'contract'));
    cpSync(join(root, 'contract/cli.json'), join(copy, 'contract/cli.json'));
    mkdirSync(join(copy, 'docs/reference'), { recursive: true });
    cpSync(join(root, 'docs/reference/cli.md'), join(copy, 'docs/reference/cli.md'));
    cpSync(join(root, 'package.json'), join(copy, 'package.json'));
    symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'));

    const run = () => spawnSync(process.execPath, [join(copy, 'scripts/contract.ts'), '--check'], { cwd: copy, encoding: 'utf8' });

    const unchanged = run();
    expect(unchanged.status, unchanged.stderr).toBe(0);

    const mapPath = join(copy, 'src/permissions/map.ts');
    const map = readFileSync(mapPath, 'utf8');
    const changed = map.replace("up: {\n      kind: 'owner-or-leads',", "up: {\n      kind: 'owner-only',");
    expect(changed, 'the copy carries the row this test changes').not.toBe(map);
    writeFileSync(mapPath, changed);

    const red = run();
    expect(red.status).not.toBe(0);
    const out = `${red.stdout}${red.stderr}`;
    expect(out).toContain('contract:check: failed');
    expect(out).toContain('contract/cli.json');
    // The produced line is the changed gate: the row came from the map, not from a stale copy.
    const jsonLine = out.split('\n').find((line) => line.startsWith('contract/cli.json:'));
    expect(jsonLine, out).toBeDefined();
    expect(jsonLine).toContain('gate');
    expect(jsonLine).toContain('owner-only');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  // Two full contract generations in a subprocess: the 5s default is the runner's, not the
  // check's, and the merged CLI grew enough commands that it no longer fits.
}, 60_000);
