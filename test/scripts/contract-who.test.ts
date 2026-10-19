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
import { commands } from '../../src/cli.ts';
import { COMMAND_GATES } from '../../src/permissions/map.ts';

type Who = { gate: string; why: string };
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
  'unlisted',
] as const;

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
    expect(contract.commands.find((command) => command.name === name)?.who, `${name} does not repeat the map's row`).toEqual({
      gate: gate.kind,
      why: gate.why,
    });
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
  for (const name of ['owner-only', 'owner-or-leads', 'owner-or-own-team', 'seat-record', 'admission', 'pane-authority']) {
    expect(contract.commands.some((command) => command.who?.gate === name), `no command reads ${name}`).toBe(true);
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
});
