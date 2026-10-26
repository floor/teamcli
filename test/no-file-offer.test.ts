import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/cli.ts';
import { testIo } from './helpers.ts';

// A command run outside a git repository used to say "run team from a project, or pass
// --file" even where it takes no --file — an offer its own parser refuses. Hold the sentence
// to the command contract: every command and subcommand in contract/cli.json that does not
// list --file runs here from outside any checkout, plain and --json where it takes the flag,
// and its output may not carry the offer. Subcommands carry their own flags, so each is
// walked with its own argv.
//
// Two faces cannot run here: the conformance adapter speaks a stdin RPC protocol, not a
// terminal, and `team init` is the command that makes a project where none is — it runs as a
// terminal-less owner and stops at that refusal before writing anything.

type ContractNode = {
  name: string;
  flags: { name: string }[];
  positionals: { name: string }[];
  subcommands: ContractNode[];
};

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL('../contract/cli.json', import.meta.url)), 'utf8'),
) as { commands: ContractNode[] };

/** Values that get past a parser's own shape checks to the team file: `tempo` refuses a
 *  word that is not its own before it reads the file, and the sentence sits behind the load. */
const PROBES: Record<string, string> = { word: 'normal' };

/** The flags that reach the file: without them `grant` and `delegate` stop at their usage
 *  line, before the sentence this census is about. `--dry-run` keeps the run from writing. */
const TO_THE_FILE: Record<string, string[]> = {
  grant: ['--scope', 'up', '--dry-run'],
  delegate: ['--commands', 'add', '--dry-run'],
};

/** Commands that read the machine instead of a team file, so the sentence cannot come from
 *  them: `team usage` prints the live quota status lines, which a test folder does not
 *  isolate and a real machine answers slowly, and `team daemon` manages or runs the
 *  machine-wide daemon process. */
const MACHINE_ONLY = new Set(['usage', 'daemon']);

/** Subcommands that run in the foreground until stopped. `team owner-seat serve` reads the
 *  owner seat under the real home (Bun fixes `homedir()` at startup, so the census cannot point
 *  it elsewhere): on a machine with an owner seat it starts the owner page and waits for Ctrl-C,
 *  which timed the census out on every owner's Mac and never on CI. It reads no team file, so
 *  the sentence cannot come from it. */
const FOREGROUND = new Set(['owner-seat serve']);

const OFFER = 'or pass --file';
const NO_REPO = 'not inside a git repository';

function nodes(node: ContractNode, path: string[]): { path: string[]; node: ContractNode }[] {
  return [{ path, node }, ...node.subcommands.flatMap((sub) => nodes(sub, [...path, sub.name]))];
}

const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-no-file-offer-')));
const outside = join(base, 'outside');
mkdirSync(outside);
afterAll(() => rmSync(base, { recursive: true, force: true }));

/** The nodes whose no-repository sentence this run must reach: every command the sentence is
 *  held to. A run that stopped before the message would pass the offer check vacuously, so
 *  the set of nodes that printed it is pinned. */
const REACHED = [
  'ack',
  'broker',
  'bus',
  'delegate',
  'drops',
  'feed',
  'grant',
  'hold',
  'issues',
  'lock',
  'messages',
  'next',
  'plan',
  'queue add',
  'queue install',
  'queue list',
  'queue ready',
  'proc add',
  'proc done',
  'proc list',
  'register',
  'revoke delegate',
  'revoke grant',
  'route',
  'tempo',
  'unlock',
];

const reached = new Set<string>();

describe('outside a checkout, the sentence offers --file only where the contract lists it', () => {
  const cases = contract.commands
    .flatMap((command) => nodes(command, [command.name]))
    .filter(
      ({ path, node }) =>
        !MACHINE_ONLY.has(path[0] as string) &&
        !FOREGROUND.has(path.join(' ')) &&
        // Hidden dispatchers: neither is a command in the table, and neither prints a no-repository
        // sentence — one answers a port's protocol, the other stages a hook's record.
        path[0] !== 'conformance-adapter' &&
        path[0] !== 'presence-hook' &&
        !node.flags.some((flag) => flag.name === '--file'),
    );

  test('the only nodes without a loader are the dispatcher words', () => {
    const skipped = new Set(cases.filter(({ path }) => commands[path[0] as string] === undefined).map(({ path }) => path[0] as string));
    expect(skipped).toEqual(new Set(['help']));
  });

  for (const { path, node } of cases) {
    const name = path[0] as string;
    if (commands[name] === undefined) continue;
    // One positional probe: the contract merges the alternative forms of a command that names
    // one seat or one team, so its positional list can be longer than any one argv.
    const first = node.positionals[0];
    const argv = [...path.slice(1), ...(first ? [PROBES[first.name] ?? 'probe'] : []), ...(TO_THE_FILE[path.join(' ')] ?? [])];
    test(`team ${path.join(' ')}: no --file in the sentence`, async () => {
      const run = async (args: string[]): Promise<string> => {
        const io = testIo(outside, name === 'init' ? { kind: 'owner-no-tty' } : { kind: 'owner' });
        const command = await commands[name]!();
        await command.default(args, io);
        return `${io.out}${io.err}`;
      };
      const plain = await run(argv);
      if (plain.includes(NO_REPO)) reached.add(path.join(' '));
      expect(plain).not.toContain(OFFER);
      if (node.flags.some((flag) => flag.name === '--json')) {
        expect(await run([...argv, '--json'])).not.toContain(OFFER);
      }
    });
  }

  test('the census reaches every sentence it protects', () => {
    expect([...reached].sort()).toEqual([...REACHED].sort());
  });
});
