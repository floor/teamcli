// `team usage` — S2: the machine's report, restricted for every caller but the owner at a
// terminal. One resolution (`viewFor`), one filter (`reportOf`), one closed allow-list DTO both
// renderers print — and the DTO holds copies, never the machine's own objects, so a field the
// internals grow reaches neither face (its own test below). The suite holds the design's boundary
// as tests: the properties the restricted text and `--json` keep (no other team's name, root,
// seat or read, no location this machine derived, no path a state read produced), the full view's
// own shape, the anonymized note families with their counts, the store-level refusal, and the
// five droppable allow-list entries the brief lists — the team count, whose reading a machine
// line carries, the watch clause, the anonymized note counts, and how fine an age is — each with
// its own test below. Read-only throughout: nothing here writes, runs, reads a pane or opens a
// CLI session file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { loadReadings, observe, saveReadings } from '../src/budgets/readings.ts';
import { mayLaunchSeats, walkCaller, type Caller } from '../src/caller.ts';
import { runStatus } from '../src/commands/status.ts';
import { NO_PROJECT, runUsage, USAGE } from '../src/commands/usage.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { machineAccountsPath } from '../src/information/machine-accounts.ts';
import {
  machineUsage,
  NOT_VERIFIED,
  reportOf,
  reportText,
  tildify,
  UNBOUND_ACCOUNT,
  UNBOUND_SHAPE,
  viewFor,
  type UsageReport,
} from '../src/information/usage.ts';
import { emptySession, updateState } from '../src/state.ts';
import { approvalStanding, storePath, writeApproval } from '../src/store/store.ts';
import { gitEnv, testIo } from './helpers.ts';
import { writeTextSignedApproval } from './helpers/text-signed-approval.ts';

const NOW = new Date('2026-10-04T09:00:00Z');

/** A report document's outermost shape, as the two views' documents differ only in the names
 *  inside: the tests below compare one against the other with this type on both sides. */
type MachineDoc = {
  view: string;
  labs: { accounts: (Record<string, unknown> & { machine: Record<string, unknown>; teams: Record<string, unknown>[] })[] }[];
};

/** A seat's caller: the restricted view's ordinary reader, handed in so no test's view depends on
 *  the process tree it is run from. */
const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'w1:p1', session: 'acme-web' };
const OWNER: Caller = { kind: 'owner' };

// The state's readings: a fresh check figure, a status-line figure last seen 40 minutes ago out
// in the open (more than the reserve again, so it is the room last seen, not unknown), and a
// fresh status-line figure inside its reserve, carrying a valid point — the figure it replaced,
// an hour before it moved, so its pace reads exactly 5.3%/h (§ 3-S3's exact arithmetic).
// `anthropic` is named by the file and has none.
const READINGS = {
  'openai/session': { account: 'openai', window: 'session', left: 40, used: 60, changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: null, source: 'check', confirmed: true },
  'openai/daily/lead': { account: 'openai', window: 'daily', left: 70, used: 30, changedAt: '2026-10-04T08:20:00Z', resetsAt: null, seat: 'lead', source: 'status_line', confirmed: true },
  'openai/weekly/lead': { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'lead', source: 'status_line', confirmed: true, was: { left: 10.3, at: '2026-10-04T07:58:00Z' } },
};

// The report the fixture reads by default, byte for byte: the machine's counts, one line per
// account+window with the newest figure any team's reading holds, the caller's own row under each
// line, and the why-lines for the accounts that read unknown everywhere, the watch clause on every
// line whose newest team has no watch recording, the caller's own team block and the machine's
// count line. The pace word rides the machine line after its state clause and every row after its
// figure: a real pace where the reading carries a point, and the tool's own `pace not known` where
// there is none — the check line's reading has none, and the daily line's point was dropped with
// its window. A restricted line whose newest reading is another team's drops the element outright
// — the pace is that team's, withheld, and nothing stands in its place. A caller who is not the
// owner reads the same bytes here as the owner does — this fixture has one team. The quota tree is
// the second face (`--tree`, `REPORT` below): the default report is this table alone (owner,
// 2026-10-17).
const TABLE = [
  'ACCOUNT    WINDOW   LEFT  USED  RESETS   RESERVE             READ                     SOURCE                  STATE',
  'anthropic  -        -     -     -        -                   -                        -                       unknown',
  'openai     session  40%   60%   in 44m   -                   -  read 2m ago           check                   ok  pace not known  (no watch is recording for acme)',
  'openai     daily    70%   30%   unknown  -                   lead  last seen 40m ago  status line (fallback)  unknown  pace not known  stale  (no watch is recording for acme)',
  'openai     weekly   5%    95%   in 44m   inside reserve 20%  lead  changed 2m ago     status line (fallback)  near cap  pace 5.3%/h  (no watch is recording for acme)',
  '  anthropic  acme  unknown  pace not known',
  '  openai  acme  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known',
  '  openai  acme  daily  left 70%  used 30%  resets unknown  lead  last seen 40m ago  status line (fallback)  stale  pace not known',
  '  openai  acme  weekly  left 5%  used 95%  resets in 44m  lead  changed 2m ago  status line (fallback)  fresh, inside reserve 20%  pace 5.3%/h',
  'advice: no readings yet: no seat status line and no CLI usage command has answered',
  '',
  'acme',
  '  SEAT  CLI          ACCOUNT',
  '  lead  claude-code  anthropic',
  '',
  'usage on this machine, 1 team, 2 labs, 2 accounts',
].join('\n');

// The quota block: this machine's watch store holds no reading and no live source answers a
// test's own run (`observe` is absent from its sources), so both declared accounts read unknown
// and the advice says so. The seats are the file's own: the lead pays `anthropic` by its vendor.
const QUOTA = [
  'quota',
  '  anthropic  unknown',
  '    anthropic  unknown  seats: lead',
  '      not known: no reading yet',
  '  openai  unknown',
  '    openai  unknown',
  '      not known: no reading yet',
  'advice: no readings yet: no seat status line and no CLI usage command has answered',
].join('\n');

/** The same report under `--tree`: the table, one blank line, the quota tree, one blank line, and
 *  the project block the table already ends with. The default view's one advice line is the quota
 *  block's own when the tree prints it, so it stands in the block, never twice. */
const ADVICE = 'advice: no readings yet: no seat status line and no CLI usage command has answered';
// Under the tree the seat table carries the seats' own figures: this fixture's watch record has
// the lead's openai daily and weekly readings (the state `withState()` writes), both estimated,
// one stale; no live source answered, and the spend is unknown with its reason.
const SEAT_FIGURES = [
  '  lead  claude-code  openai  daily  left 70%  used 30%  resets unknown  margin not known  estimated  state record  read 40m ago  stale',
  '  lead  claude-code  openai  weekly  left 5%  used 95%  resets in 44m  margin +4.6%  estimated  state record  read 2m ago',
  "  lead  claude-code  anthropic  cost  unknown  no money cost was read from this seat's screen this run",
].join('\n');
const REPORT = TABLE.replace(`${ADVICE}\n`, '')
  .replace('\n\nacme\n', `\n\n${QUOTA}\n\nacme\n`)
  .replace('\n\nusage on this machine', `\n${SEAT_FIGURES}\n\nusage on this machine`);

/** The tree's lines for one seat with no figure and its own spend line: a seat the report cannot
 *  read prints `unknown` for both, never a zero. */
const noFigure = (seat: string, cli: string, account: string) => [
  `  ${seat}  ${cli}  ${account}  unknown  no reading for this seat`,
  `  ${seat}  ${cli}  ${account}  cost  unknown  no money cost was read from this seat's screen this run`,
];

/** The zero-config account a lab its seats draw on prints before any reading: one account named
 *  after the lab, `unknown` with no window, and readable by the same rule a declared account's
 *  line is — the accounts a CLI screen on this machine can expose a figure for. */
function synthesized(lab: string, readable: boolean): Record<string, unknown> {
  return {
    account: lab,
    kind: 'subscription',
    readable,
    teams: [],
    machine: {
      window: null, left: null, used: null, resetsIn: null, changedAt: null, age: null,
      source: null, fallback: false, state: 'unknown', inside: false, reserve: null,
      pace: null, other: false, seat: null,
    },
  };
}

let base: string;
let root: string;
let home: string;
let file: string;

/** The team file: trust lists the lobby and the project, the shape a real approved file has,
 *  so the loader's placed checks are satisfied and the file loads. The lead is spelled the
 *  current way — `leads: true` on the seat, `role: orchestrator` — so the fixture loads with no
 *  warning at all; a test pins that, so a later move of the tool's own words fails here. */
function teamText(): string {
  return `format: 1
project: acme
session: acme-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${root}
workspace:
  mode: shared
budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [check, status_line]
      check: acme-quota
    anthropic:
      kind: subscription
      reserve: 10%
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

/** The same file with its whole `budgets:` section taken out: it names no account. */
function withoutBudgets(): string {
  const text = teamText();
  return text.slice(0, text.indexOf('budgets:')) + text.slice(text.indexOf('seats:'));
}

/** The store's record for one text: what `team approve` leaves, signed by the key the store
 *  writes on first use. The budgets section takes effect only once the owner has approved it. */
function approve(text: string, opts: { root?: string; name?: string } = {}): void {
  const at = opts.root ?? root;
  const checked = validateTeamFile(text, { home, root: at });
  if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
  writeApproval(storePath(opts.name ?? checked.team.project, at, home), { approval: approvalOf(checked.team, at, NOW), file: text }, [], home);
}

/** A state with the session recorded and no readings at all: the session is reset and the whole
 *  `budgets` record emptied, so a test that set readings earlier really has none. */
function withoutReadings(): void {
  updateState(join(root, '.agents'), (state) => {
    state.budgets = {};
    state.sessions['acme-web'] = { ...emptySession() } as never;
  });
}

/** The readings the state holds, and the watch record, as the watch would have written them. */
function withState(watch: { pid: number; heartbeat: string } | null = null): void {
  updateState(join(root, '.agents'), (state) => {
    state.budgets = { ...READINGS } as never;
    state.sessions['acme-web'] = { ...emptySession(), ...(watch ? { watch } : {}) } as never;
  });
}

beforeEach(() => {
  // The real path: `/tmp` is a link on this machine, and the loader resolves every folder it
  // checks, so a fixture keeping the `/tmp/...` spelling would fail its own trust walk.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-usage-')));
  home = join(base, 'home');
  root = join(base, 'acme');
  mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
  mkdirSync(join(root, '.agents'), { recursive: true });
  file = join(root, '.agents', 'team.yaml');
  const text = teamText();
  writeFileSync(file, text);
  // An approved file in a real store, signed by the key the store writes on first use: the
  // budgets section takes effect only once the owner has approved it.
  approve(text);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function usageAt(cwd: string, caller?: Caller, ...argv: string[]) {
  const io = testIo(cwd, caller);
  const code = await runUsage(argv, io, { home, now: () => NOW });
  return { code, out: io.out, err: io.err };
}

/** The tokens of a face that start at the filesystem root, run to whitespace or a delimiter: what
 *  a path the tool derived from this machine looks like — a root, the home folder, the store, a
 *  state or file path — and, just as well, what a name a team wrote in its own file may look
 *  like. The tests here keep the two halves apart: `expectNoDerivedPath` refuses every such token
 *  where only derived paths can stand, and the account-name test pins the other half to exactly
 *  the one name the file wrote, so the exception can never widen into a hiding place. */
function absoluteTokens(face: string): string[] {
  return [...face.matchAll(/(?:^|[\s"'()[\]=:,])(\/[^\s"',;)\]]+)/g)].map((hit) => hit[1] as string);
}

/** No location the tool derived from this machine reaches a caller who is not the owner, in either
 *  face: the fixture's own base and home are distinctive strings — the base is under `/tmp`, and
 *  the root, the store and the state live under it — and no absolute-looking token stands in the
 *  output at all. The one exception is a name a team's own file wrote, and it is pinned by its own
 *  test, never allowed here by omission: a caller's own `budgets.accounts` name prints as written. */
function expectNoDerivedPath(faces: readonly string[], why?: string, allowed: readonly string[] = []): void {
  const derived = [base, root, home, storePath('acme', root, home), join(root, '.agents', 'team.state.json')];
  for (const face of faces) {
    for (const path of derived) expect(face, why).not.toContain(path);
    expect(absoluteTokens(face).filter((token) => !allowed.includes(token)), why).toEqual([]);
  }
}

/** The report's per-team rows: the two-space list lines under the machine table, whose second
 *  field is the team's name (the table's own rows start at column 0 and lead with the account). */
function teamRowsOf(text: string, team: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('  ') && line.split('  ')[2] === team);
}

/** The rows under a heading: the two-space lines that follow the line `after`. */
function rowsUnder(text: string, after: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines.slice(lines.indexOf(after) + 1)) {
    if (!line.startsWith('  ')) break;
    out.push(line.slice(2));
  }
  return out;
}

/** Every file under a folder, by relative path, as its own bytes in base64. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return out;
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const full = join(dir, rel);
    if (statSync(full).isFile()) out[rel] = readFileSync(full).toString('base64');
  }
  return out;
}

/** Run one scenario with the watched folders snapshotted around it. */
async function untouched(watched: string[], run: () => Promise<unknown>): Promise<void> {
  const before = watched.map((dir) => snapshot(dir));
  await run();
  watched.forEach((dir, index) => expect(snapshot(dir)).toEqual(before[index] as Record<string, string>));
}

/** A team file for the gate scene: one project, its own distinctive account, the shared `openai`,
 *  and a seat whose vendor puts a lab in use. `project` is the distinctive string the property
 *  sweep looks for. */
function teamTextFor(project: string, accounts: string[], seats: string): string {
  return `format: 1
project: ${project}
session: ${project}-web
operator: lead
trust:
  - ~/.config/team/lobby
  - ${join(base, project)}
workspace:
  mode: shared
budgets:
  accounts:
    openai:
      kind: subscription
      reserve: 20%
      sources: [status_line]
${accounts.map((account) => `    ${account}:\n      kind: subscription\n      reserve: 10%`).join('\n')}
seats:
  - role: orchestrator
    name: lead
    label: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
${seats}`;
}

/** One other team's seat block, for the extra account a lab keeps to itself. */
function extraSeat(name: string, account: string): string {
  return `  - role: member
    name: ${name}
    account: ${account}
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
}

describe('team usage', () => {
  test('the default rows keep only the current checkout when projects have the same name', async () => {
    const otherRoot = join(base, 'another-checkout');
    for (const [at, left] of [[root, 75], [otherRoot, 25]] as const) {
      mkdirSync(join(at, '.agents'), { recursive: true });
      const text = teamText().replace(root, at).replace(
        '  accounts:\n',
        '  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: acme-quota }\n',
      );
      writeFileSync(join(at, '.agents', 'team.yaml'), text);
      approve(text, { root: at });
      updateState(join(at, '.agents'), (state) => {
        state.budgets = {
          'openai/session': { ...READINGS['openai/session'], left, used: 100 - left },
        } as never;
        state.spend = {
          deepseek: { account: 'deepseek', amount: left, currency: 'USD', at: '2026-10-04T08:58:00Z' },
        } as never;
      });
    }

    const linked = join(base, 'linked-checkout');
    symlinkSync(root, linked);
    for (const cwd of [root, linked]) {
      for (const all of [false, true]) {
        const args = all ? ['--all'] : [];
        const result = await usageAt(cwd, OWNER, '--json', ...args);
        expect(result.code).toBe(0);
        expect(result.err).toBe('');
        const report = JSON.parse(result.out) as UsageReport;
        const accounts = report.labs.flatMap((lab) => lab.accounts)
          .filter((entry) => entry.account === 'openai' || entry.account === 'deepseek');
        expect(accounts).toHaveLength(2);
        for (const entry of accounts) {
          expect(entry.teams.map((row) => row.root).sort()).toEqual(all ? [root, otherRoot].sort() : [root]);
          expect(entry.teams.every((row) => row.team === 'acme')).toBe(true);
          const figures = entry.kind === 'subscription'
            ? entry.teams.map((row) => row.row.left)
            : entry.teams.map((row) => row.reading.amount);
          expect(figures.sort()).toEqual(all ? [25, 75] : [75]);
        }
        expect(report.teams).toHaveLength(all ? 2 : 1);

        const text = (await usageAt(cwd, OWNER, ...args)).out;
        const teamRows = teamRowsOf(text, 'acme');
        expect(teamRows.some((line) => line.includes('left 75%'))).toBe(true);
        expect(teamRows.some((line) => line.includes('75.00 USD'))).toBe(true);
        expect(teamRows.some((line) => line.includes('left 25%'))).toBe(all);
        expect(teamRows.some((line) => line.includes('25.00 USD'))).toBe(all);
      }
    }

    const restricted = JSON.parse((await usageAt(root, SEAT, '--json', '--all')).out) as UsageReport;
    expect(restricted.view).toBe('restricted');
    for (const entry of restricted.labs.flatMap((lab) => lab.accounts)) {
      expect(entry.teams).toHaveLength(1);
      expect(entry.teams[0]).not.toHaveProperty('root');
      if (entry.kind === 'spend') expect(entry.teams[0]?.reading.amount).toBe(75);
      else if (entry.account === 'openai') expect(entry.teams[0]?.row.left).toBe(75);
    }
  });

  test('the fixture takes the current file spelling, so no deprecation warning fires on it', () => {
    // The guard for the class a moved word breaks: if the tool's file language moves again —
    // another key renamed, another field deprecated — this fixture would warn, and this fails
    // here rather than on the check that runs the whole suite. The fixture's trust entry is its
    // own resolved path; a path no longer reads as a random value (`secrets.ts`), so the whole
    // list is asserted: nothing here warns, whatever temporary name a run draws.
    const checked = validateTeamFile(teamText(), { home, root });
    expect(checked.ok).toBe(true);
    const warnings = checked.ok ? checked.warnings : [];
    expect(warnings).toEqual([]);
  });

  test('the machine report is the header, the lines and the notes — and status rows its own rows', async () => {
    withState();
    const mine = await usageAt(root);
    expect(mine.err).toBe('');
    // The default report is the table alone: no quota tree behind it. The tree is the second
    // face, asked for by name (owner, 2026-10-17).
    expect(mine.out).toBe(`${TABLE}\n`);
    expect(mine.out).not.toContain('quota\n');
    const tree = await usageAt(root, undefined, '--tree');
    expect(tree.err).toBe('');
    expect(tree.out).toBe(`${REPORT}\n`);
    expect(mine.code).toBe(0);

    // The caller's own rows are `status`'s own, over the same state: the fresh, unknown and
    // last-seen rows are the budget table's rows with the account column replaced by the team's
    // name. One row per table row, in the table's order, and every table row is one of them.
    const io = testIo(root, OWNER);
    await runStatus(['--file', file], io, {
      live: () => ({ running: false, agents: [], workspaces: [], screens: {} }),
      branch: () => null,
      standing: () => approvalStanding(root, home),
      now: () => NOW,
      home,
    });
    const statusRows = rowsUnder(io.out, 'budgets:');
    const ownRows = teamRowsOf(mine.out, 'acme');
    expect(statusRows.length).toBeGreaterThan(0);
    expect(ownRows.length).toBe(statusRows.length);
    // The pace word rides after the figure text (`pace 5.3%/h`, `pace not known`, § 3-S3): with
    // it taken off, a usage row is the status row byte for byte — and every row carries one.
    const figure = (line: string) => line.replace(/  pace (?:not known|-?[0-9]+\.[0-9]%\/h)$/, '');
    for (const row of ownRows) expect(figure(row)).not.toBe(row);
    for (const row of statusRows) {
      const account = row.slice(0, row.indexOf('  '));
      expect(ownRows.some((line) => figure(line).endsWith(row.slice(account.length)))).toBe(true);
    }
  });

  test('--json prints the same report as one document, format 1, restricted with no names of another team', async () => {
    withState();
    const { code, out } = await usageAt(root, undefined, '--json');
    const doc = JSON.parse(out) as Record<string, unknown>;
    expect(code).toBe(0);
    expect(doc).toEqual({
      schema: { name: 'team.usage', version: 1 },
      format: 1,
      at: '2026-10-04T09:00:00.000Z',
      view: 'restricted',
      mine: 'acme',
      counts: { teams: 1, labs: 2, accounts: 2 },
      labs: [
        {
          lab: 'anthropic',
          accounts: [
            {
              account: 'anthropic',
              kind: 'subscription',
              readable: true,
              machine: { window: null, left: null, used: null, resetsIn: null, changedAt: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: null, pace: null, other: false },
              teams: [{ team: 'acme', row: { account: 'anthropic', window: null, left: null, used: null, resetsIn: null, seat: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: 10, pace: null } }],
            },
          ],
        },
        {
          lab: 'openai',
          accounts: [
            {
              account: 'openai',
              kind: 'subscription',
              readable: true,
              machine: { window: 'session', left: 40, used: 60, resetsIn: '44m', changedAt: '2026-10-04T08:58:00.000Z', age: '2m', source: 'check', fallback: false, state: 'fresh', inside: false, reserve: 20, pace: null, other: false, watch: 'not-recording', seat: null },
              teams: [{ team: 'acme', row: { account: 'openai', window: 'session', left: 40, used: 60, resetsIn: '44m', seat: null, age: '2m', source: 'check', fallback: false, state: 'fresh', inside: false, reserve: 20, pace: null } }],
            },
            {
              account: 'openai',
              kind: 'subscription',
              readable: true,
              machine: { window: 'daily', left: 70, used: 30, resetsIn: null, changedAt: '2026-10-04T08:20:00.000Z', age: '40m', source: 'status_line', fallback: true, state: 'stale', inside: false, reserve: 20, pace: null, other: false, watch: 'not-recording', seat: 'lead' },
              teams: [{ team: 'acme', row: { account: 'openai', window: 'daily', left: 70, used: 30, resetsIn: null, seat: 'lead', age: '40m', source: 'status_line', fallback: true, state: 'stale', inside: false, reserve: 20, pace: null } }],
            },
            {
              account: 'openai',
              kind: 'subscription',
              readable: true,
              machine: { window: 'weekly', left: 5, used: 95, resetsIn: '44m', changedAt: '2026-10-04T08:58:00.000Z', age: '2m', source: 'status_line', fallback: true, state: 'fresh', inside: true, reserve: 20, pace: 5.3, other: false, watch: 'not-recording', seat: 'lead' },
              teams: [{ team: 'acme', row: { account: 'openai', window: 'weekly', left: 5, used: 95, resetsIn: '44m', seat: 'lead', age: '2m', source: 'status_line', fallback: true, state: 'fresh', inside: true, reserve: 20, pace: 5.3 } }],
            },
          ],
        },
      ],
      unknown: [],
      notes: [],
      // The quota view: no machine reading and no live source in a test's own run, so both
      // declared accounts are unknown, the lead is the one seat on its vendor's account, and the
      // advice says what is missing rather than inventing a figure.
      quota: {
        format: 1,
        accountsFile: '~/.config/team/accounts.yaml',
        labs: [
          {
            lab: 'anthropic',
            state: 'unknown',
            accounts: [{ account: 'anthropic', state: 'unknown', windows: [], seats: ['lead'], wallResets: null }],
          },
          {
            lab: 'openai',
            state: 'unknown',
            accounts: [{ account: 'openai', state: 'unknown', windows: [], seats: [], wallResets: null }],
          },
        ],
        advice: 'no readings yet: no seat status line and no CLI usage command has answered',
      },
      teams: [{
        team: 'acme',
        seats: [{
          seat: 'lead',
          cli: 'claude-code',
          account: 'anthropic',
          run: 'acme-web',
          // The state's per-seat record, marked estimated: the daily point is older than five
          // minutes and stale, the weekly one still inside its window.
          windows: [
            {
              window: 'daily', account: 'openai', left: 70, used: 30, resetsAt: null, resetsIn: null,
              margin: null, mark: 'estimated', source: 'state record', readAt: '2026-10-04T08:20:00.000Z',
              age: '40m', stale: true,
            },
            {
              window: 'weekly', account: 'openai', left: 5, used: 95, resetsAt: '2026-10-04T09:44:00.000Z',
              resetsIn: '44m', margin: 4.6, mark: 'estimated', source: 'state record',
              readAt: '2026-10-04T08:58:00.000Z', age: '2m', stale: false,
            },
          ],
          cost: { amount: null, currency: 'USD', source: 'unknown', why: "no money cost was read from this seat's screen this run" },
        }],
      }],
    });
  });

  test('the report carries copies, not the machine’s own objects: a field the internals grow reaches neither face', async () => {
    // The closed allow-list's own rule, pinned where it can break in silence: `reportOf` builds
    // the one DTO both renderers print from, and the command `JSON.stringify`s it for `--json` —
    // so a row (or the counts) carried by reference would print whatever field the internal type
    // grows next, the restricted view's rows included. The marker below stands for that field:
    // planted on every internal row, reading, count and machine-line entry the report reads from,
    // it must reach neither face. The spend account is in the fixture so the sweep covers a spend
    // reading too, and the weekly reading carries a point — its pace 5.3%/h (§ 3-S3) — so a pace
    // carried by reference instead of copied is planted and swept like everything else.
    const text = teamText().replace(
      '  accounts:\n',
      '  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: acme-quota }\n',
    );
    writeFileSync(file, text);
    approve(text);
    updateState(join(root, '.agents'), (state) => {
      state.spend = { deepseek: { account: 'deepseek', amount: 12.4, currency: 'USD', at: '2026-10-04T08:56:00Z' } } as never;
    });
    withState();
    const view = viewFor(testIo(root, SEAT), root);
    expect(view.full).toBe(false);
    const machine = machineUsage(home, NOW.getTime(), view);

    const marker = 'ZAP-MARKER-2b5f';
    const plant = (one: object): void => {
      (one as Record<string, unknown>).zap = marker;
    };
    plant(machine.counts);
    for (const team of machine.teams) for (const seat of team.usage.seatAccounts) plant(seat);
    for (const lab of machine.labs) {
      for (const account of lab.accounts) {
        if (account.kind === 'spend') {
          for (const one of account.spend.rows) plant(one.reading);
          if (account.spend.newest !== null) plant(account.spend.newest.reading);
        } else {
          for (const line of account.lines) {
            for (const one of line.rows) {
              plant(one.row);
              plant(one);
            }
            if (line.newest !== null) {
              plant(line.newest.row);
              plant(line.newest);
            }
          }
        }
      }
    }

    const report = reportOf(machine, view, NOW.getTime(), []);
    expect(JSON.stringify(report)).not.toContain(marker);
    expect(reportText(report)).not.toContain(marker);

    // And the key sets themselves, level by level — the report, the counts, a machine line, a
    // team row and a spend reading — so a key that does cross fails here by name, not only by
    // plant. A machine's optional tail (`watch`, `team`, `seat`) varies with the line, so its
    // fixed head is pinned in order and the whole object by the `--json` document test above.
    expect(Object.keys(report)).toEqual(['format', 'at', 'view', 'mine', 'counts', 'labs', 'quota', 'unknown', 'notes', 'teams']);
    for (const block of report.teams) {
      expect(Object.keys(block)).toEqual(['team', 'seats']);
      for (const seat of block.seats) expect(Object.keys(seat)).toEqual(['seat', 'cli', 'account', 'run', 'windows', 'cost']);
    }
    expect(Object.keys(report.counts)).toEqual(['teams', 'labs', 'accounts']);
    const accountEntries = report.labs.flatMap((lab) => lab.accounts);
    for (const entry of accountEntries) {
      if (entry.kind !== 'subscription') continue;
      expect(Object.keys(entry.machine).slice(0, 13)).toEqual(['window', 'left', 'used', 'resetsIn', 'changedAt', 'age', 'source', 'fallback', 'state', 'inside', 'reserve', 'pace', 'other']);
    }
    const teamRows = report.labs.flatMap((lab) => lab.accounts.flatMap((entry) => (entry.kind === 'subscription' ? entry.teams : [])));
    const spendRows = report.labs.flatMap((lab) => lab.accounts.flatMap((entry) => (entry.kind === 'spend' ? entry.teams : [])));
    expect(teamRows.length).toBeGreaterThan(0);
    expect(spendRows.length).toBeGreaterThan(0);
    for (const row of teamRows) {
      expect(Object.keys(row.row)).toEqual(['account', 'window', 'left', 'used', 'resetsIn', 'seat', 'age', 'source', 'fallback', 'state', 'inside', 'reserve', 'pace']);
    }
    for (const row of spendRows) {
      expect(Object.keys(row.reading)).toEqual(['amount', 'currency', 'at', 'age', 'source', 'state']);
    }
  });

  test('the pace word reads from the stored point alone: its not-known faces, and the unknown line that carries none', async () => {
    // § 3-S3's word, against the fixture's own report: the weekly reading's point is a real pair
    // (10.3% an hour before 5%, 5.3%/h), while the two records below are given points their own
    // lines must not read. The check reading's point is as old as the change it sits beside
    // (`dt = 0`: the odd pair `revive` keeps by shape but `paceFrom` refuses by arithmetic), and
    // the daily record's point is a real drop — 77% to 70% over 30 minutes, 14.0%/h — on a figure
    // that moved 40 minutes ago, stale by the file's own `stale_after` of 30 minutes.
    withState();
    updateState(join(root, '.agents'), (state) => {
      const stored = state.budgets as Record<string, Record<string, unknown>>;
      stored['openai/session'] = { ...(stored['openai/session'] ?? {}), was: { left: 60, at: '2026-10-04T08:58:00Z' } };
      stored['openai/daily/lead'] = { ...(stored['openai/daily/lead'] ?? {}), was: { left: 77, at: '2026-10-04T07:50:00Z' } };
    });
    const mine = await usageAt(root, SEAT);
    expect(mine.code).toBe(0);
    expect(mine.out).toContain('openai     session  40%   60%   in 44m   -                   -  read 2m ago           check                   ok  pace not known  (no watch is recording for acme)');
    expect(mine.out).toContain('openai     daily    70%   30%   unknown  -                   lead  last seen 40m ago  status line (fallback)  unknown  pace not known  stale  (no watch is recording for acme)');
    // The one record whose point stands reads its figure — the positive control the refusals
    // above need: not the stale record's real 14.0%/h, and not a 0.0 the zero-distance pair could
    // fake if the rule were only "a point is present".
    expect(mine.out).toContain('openai     weekly   5%    95%   in 44m   inside reserve 20%  lead  changed 2m ago     status line (fallback)  near cap  pace 5.3%/h  (no watch is recording for acme)');
    expect(mine.out).not.toContain('14.0%/h');
    expect(mine.out).not.toContain('0.0%/h');
    // A machine row with no figure carries no word either: `anthropic` reads `unknown`, where
    // the caller's row under the table reads `pace not known` like every row of a subscription
    // account.
    expect(mine.out).toContain('anthropic  -        -     -     -        -                   -                        -                       unknown\n');
    expect(mine.out).toContain('  anthropic  acme  unknown  pace not known\n');

    // The window-change face, through the real fold: a figure that moved while a different window
    // stands ahead of it is written with no point at all (§ 2's kept-rule), so the record a later
    // pass reads carries none — and its line reads `pace not known`, left 3% and all.
    const folded = observe(loadReadings(join(root, '.agents')), { account: 'openai', window: 'weekly', left: 3, used: 97, resets: '1h44m' }, 'lead', NOW.getTime());
    saveReadings(join(root, '.agents'), folded, NOW.getTime());
    const stored = (JSON.parse(readFileSync(join(root, '.agents', 'team.state.json'), 'utf8')) as { budgets: Record<string, Record<string, unknown>> }).budgets['openai/weekly/lead'] as Record<string, unknown>;
    expect('was' in stored).toBe(false);
    const after = await usageAt(root, SEAT);
    expect(after.out).toContain('openai     weekly   3%    97%   in 1h44m  inside reserve 20%  lead  changed 0m ago     status line (fallback)  near cap  pace not known  (no watch is recording for acme)');
  });

  test("the machine line takes the newest team's pace, and each row its own", async () => {
    // § 3.3's rule, as bytes: over an account two teams hold, the full view's machine line carries
    // the newest reading's pace whichever team it came from — 5.3%/h for the fixture's reading,
    // 60.0%/h for the other team's newer one (30 points down over half an hour) — and each team's
    // own row carries its own. The restricted caller reads that other team's line with no pace at
    // all: the number is withheld there — null in `--json` — and nothing stands in its place,
    // never `pace not known`, while the caller's own row keeps its word.
    const project = 'zeta-4WX';
    const theirRoot = join(base, project);
    mkdirSync(join(theirRoot, '.agents'), { recursive: true });
    const theirText = teamTextFor(project, [], '');
    writeFileSync(join(theirRoot, '.agents', 'team.yaml'), theirText);
    approve(theirText, { root: theirRoot, name: project });
    updateState(join(theirRoot, '.agents'), (state) => {
      state.sessions[`${project}-web`] = { ...emptySession() } as never;
      state.budgets = {
        'openai/weekly/scout': { account: 'openai', window: 'weekly', left: 30, used: 70, changedAt: '2026-10-04T08:59:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'scout', source: 'status_line', confirmed: true, was: { left: 60, at: '2026-10-04T08:29:00Z' } },
      } as never;
    });
    withState();

    const seat = await usageAt(root, SEAT);
    expect(seat.code).toBe(0);
    expect(seat.out).toContain('openai     weekly   30%   70%   in 44m   read by another team, 1m ago  status line             ok    (no watch is recording for it)');
    const seatLine = seat.out.split('\n').find((text) => /^openai\s+weekly/.test(text));
    expect(seatLine).not.toContain('pace');
    expect(seat.out).toContain('  openai  acme  weekly  left 5%  used 95%  resets in 44m  lead  changed 2m ago  status line (fallback)  fresh, inside reserve 20%  pace 5.3%/h');

    const owner = await usageAt(root, OWNER, '--all');
    expect(owner.code).toBe(0);
    expect(owner.out).toContain('openai     weekly   30%   70%   in 44m   read by zeta-4WX, 1m ago  status line             ok  pace 60.0%/h  (no watch is recording for zeta-4WX)');
    expect(owner.out).toContain(`  openai  ${project}  weekly  left 30%  used 70%  resets in 44m  scout  changed 1m ago  status line  fresh  pace 60.0%/h`);

    // The same split in the allow-list: the machine's `pace` is the newest reading's in the full
    // view — with the newest reading's team beside it — and null on the restricted line that
    // withholds it; each row's is its own.
    const doc = JSON.parse((await usageAt(root, OWNER, '--json', '--all')).out) as {
      labs: { accounts: { account: string; kind: string; machine: { window: string | null; pace: number | null; team?: string }; teams: { team: string; row: { pace: number | null } }[] }[] }[];
    };
    const weekly = doc.labs.flatMap((lab) => lab.accounts).find((one) => one.account === 'openai' && one.machine.window === 'weekly');
    expect(weekly?.machine.pace).toBe(60);
    expect(weekly?.machine.team).toBe(project);
    expect(weekly?.teams.map((peer) => [peer.team, peer.row.pace])).toEqual([['acme', 5.3], [project, 60]]);
    const seatDoc = JSON.parse((await usageAt(root, SEAT, '--json')).out) as {
      labs: { accounts: { account: string; machine: { window: string | null; pace: number | null; other: boolean }; teams: { team: string; row: { pace: number | null } }[] }[] }[];
    };
    const seatWeekly = seatDoc.labs.flatMap((lab) => lab.accounts).find((one) => one.account === 'openai' && one.machine.window === 'weekly');
    expect(seatWeekly?.machine.pace).toBeNull();
    expect(seatWeekly?.machine.other).toBe(true);
    expect(seatWeekly?.teams.map((peer) => [peer.team, peer.row.pace])).toEqual([['acme', 5.3]]);
  });

  test("the owner's document is the same one with the names on: `team`, `root`, and the full view", async () => {
    withState();
    const seat = JSON.parse((await usageAt(root, SEAT, '--json')).out) as MachineDoc;
    const { code, out } = await usageAt(root, OWNER, '--json');
    const doc = JSON.parse(out) as {
      view: string;
      labs: Array<{ accounts: Array<{ machine: Record<string, unknown>; teams: Array<Record<string, unknown>> }> }>;
    };
    expect(code).toBe(0);
    expect(doc.view).toBe('full');
    // The full view is the restricted document with exactly the names the restricted one leaves
    // out: `root` on every team row, and `team` on every machine line that has a figure (whose
    // reading it is). A row's own `team` is not one of those — it is the caller's own name, which
    // the restricted view prints too — so taking the two full-view fields off a copy of the
    // owner's document must give the caller's document back, key for key.
    const copy = JSON.parse(JSON.stringify(doc)) as MachineDoc;
    let roots = 0;
    let machineTeams = 0;
    for (const entry of copy.labs.flatMap((lab) => lab.accounts)) {
      for (const row of entry.teams) {
        expect(typeof row.root).toBe('string');
        delete row.root;
        roots += 1;
        // The row's name is the caller's own, and the caller is the whole of this fixture.
        expect(row.team).toBe('acme');
      }
      if ('team' in entry.machine) {
        machineTeams += 1;
        delete entry.machine.team;
      }
    }
    copy.view = 'restricted';
    expect(roots).toBe(4);
    expect(machineTeams).toBe(3);
    expect(copy).toEqual(seat);
  });

  test('a watch whose heartbeat is fresh prints no clause; a stale or odd one says which', async () => {
    withState({ pid: 1, heartbeat: '2026-10-04T08:59:30Z' });
    const recording = await usageAt(root, SEAT, '--tree');
    expect(recording.out).not.toContain('watch');
    expect(recording.out).toBe(`${REPORT.replaceAll('  (no watch is recording for acme)', '')}\n`);

    withState({ pid: 1, heartbeat: '2026-10-04T08:55:00Z' });
    const stale = await usageAt(root, SEAT, '--tree');
    expect(stale.out).toBe(`${REPORT}\n`);

    withState({ pid: 1, heartbeat: 'not a time' });
    const odd = await usageAt(root, SEAT, '--tree');
    expect(odd.out).toBe(`${REPORT.replaceAll('(no watch is recording for acme)', '(not known whether a watch is recording)')}\n`);
  });

  test('an unreadable state is a note line: this project’s own path, absolute for the owner, relative for a seat', async () => {
    const state = join(root, '.agents', 'team.state.json');
    writeFileSync(state, 'not json');
    const why = 'is not valid JSON; move it aside and run the command again';

    // The owner reads the state's message exactly as the state wrote it, its absolute path and
    // all, named for the team it belongs to; the lines still print under it.
    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`note: acme: ${state} ${why}\n`);
    expect(owner.out).toContain('openai     -       -     -     -       -     -       unknown\n');
    expect(owner.out).toContain('  openai  acme  unknown  pace not known\n  openai  (acme: no pattern can read this account)\n');

    // A caller who is not the owner reads the project's own path relative to the project root —
    // and no absolute path at all, the fixture's base included — in the text and in `--json`.
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      'openai     -       -     -     -       -     -       unknown',
      '  anthropic  acme  unknown  pace not known',
      '  openai  acme  unknown  pace not known',
      '  openai  (acme: no pattern can read this account)',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      '  openai  unknown',
      '    openai  unknown',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      'note: acme: .agents/team.state.json is not valid JSON; move it aside and run the command again',
      '',
      'usage on this machine, 1 team, 2 labs, 2 accounts',
    ].join('\n') + '\n');
    expect((JSON.parse(raw) as { notes: unknown[] }).notes).toEqual([
      { scope: 'acme', why: '.agents/team.state.json is not valid JSON; move it aside and run the command again' },
    ]);
    expectNoDerivedPath([mine.out, raw]);
  });

  test('a file that names no account still reads its seats lab account, and a seat reads no leftover rows', async () => {
    // The file the owner approved names no account, so the budgets in force name none either: the
    // zero-config rule makes the lab its seat's vendor keeps in use one account named after the
    // lab, unknown until its first reading. No "declare it in accounts.yaml" narration prints.
    const text = withoutBudgets();
    writeFileSync(file, text);
    approve(text);

    // No readings at all: the lab's own account, unknown, with its seat behind it, and the team's
    // own seat breakdown.
    withoutReadings();
    const bare = await usageAt(root, undefined, '--tree');
    expect(bare.code).toBe(0);
    expect(bare.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      '',
      'usage on this machine, 1 team, 1 lab, 1 account',
    ].join('\n') + '\n');

    // A state that still holds readings: a caller who is not the owner reads none of them — the
    // state's account is not one the file names, so no line and no row is rendered, and one fixed
    // line says so, under the same zero-config account.
    withState();
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { counts: Record<string, number>; labs: unknown[]; notes: unknown[] };
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      `note: acme: ${UNBOUND_ACCOUNT}`,
      '',
      'usage on this machine, 1 team, 1 lab, 1 account',
    ].join('\n') + '\n');
    expect(doc.counts).toEqual({ teams: 1, labs: 1, accounts: 1 });
    expect(doc.labs).toEqual([{ lab: 'anthropic', accounts: [synthesized('anthropic', true)] }]);
    expect(doc.notes).toEqual([{ scope: 'acme', why: UNBOUND_ACCOUNT }]);

    // The owner reads the zero-config lab account, and the state's account is counted beside it
    // — the report is keyed by declarations, so the state's name gets no line and no lab — and no
    // "not shown" line prints.
    const owner = await usageAt(root, OWNER, '--tree');
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    const held = JSON.parse(ownerRaw) as { counts: Record<string, number>; labs: unknown[]; notes: unknown[] };
    expect(owner.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      '',
      'usage on this machine, 1 team, 1 lab, 2 accounts',
    ].join('\n') + '\n');
    expect(held.counts).toEqual({ teams: 1, labs: 1, accounts: 2 });
    expect(held.labs).toEqual([{ lab: 'anthropic', accounts: [synthesized('anthropic', true)] }]);
    expect(held.notes).toEqual([]);
  });

  test('a dead session leaves no seat behind and no account, and a stopped seat none either', async () => {
    // The zero-config account is made of the seats a lab's rows carry, so the one answer that
    // calls a seat history is the session's own: a team whose session herdr says is gone keeps
    // its declarations and drops every seat row, vendor and the lab they made.
    const text = withoutBudgets();
    writeFileSync(file, text);
    approve(text);
    withoutReadings();
    const gone = testIo(root, { kind: 'owner' });
    expect(await runUsage(['--tree'], gone, { home, now: () => NOW, sessions: () => false })).toBe(0);
    expect(gone.out).toContain('usage on this machine, 1 team, 0 labs, 0 accounts\n');
    expect(gone.out).not.toContain('anthropic');
    // No evidence either way (`null`) is no removal: the same machine reads its lab again.
    const unasked = testIo(root, { kind: 'owner' });
    expect(await runUsage(['--tree'], unasked, { home, now: () => NOW, sessions: () => null })).toBe(0);
    expect(unasked.out).toContain('usage on this machine, 1 team, 1 lab, 1 account\n');
    expect(unasked.out).toContain('  anthropic  unknown\n');

    // A seat the file marks stopped is a record of one that ran: its vendor makes no lab and no
    // zero-config account, while the running seat's lab still reads.
    const retired = '  - role: member\n    name: retired\n    cli: claude-code\n    vendor: zai\n    model: Claude Opus\n    version: "5.5"\n    launch: claude --model claude-opus-5-5\n    stopped: true\n';
    const stopped = text.replace('    launch: claude --model claude-opus-5-5\n', `    launch: claude --model claude-opus-5-5\n${retired}`);
    writeFileSync(file, stopped);
    approve(stopped);
    const idle = await usageAt(root, undefined, '--tree');
    expect(idle.code).toBe(0);
    expect(idle.out).toContain('usage on this machine, 1 team, 1 lab, 1 account\n');
    expect(idle.out).toContain('  anthropic  unknown\n');
    expect(idle.out).not.toContain('zai');
  });

  test('an owner note under the home reads with a tilde, never as an absolute path', () => {
    expect(tildify(join(home, '.config', 'team', 'usage', 'readings.json'), home)).toBe('~/.config/team/usage/readings.json');
    expect(tildify(`${home}/one and ${home}/two`, home)).toBe('~/one and ~/two');
    expect(tildify(home, home)).toBe('~');
    expect(tildify('/elsewhere/state.json', home)).toBe('/elsewhere/state.json');
    // An empty or root home is no home to shorten.
    expect(tildify('/anywhere', '')).toBe('/anywhere');
    expect(tildify('/anywhere', '/')).toBe('/anywhere');
  });

  test('an unverified file explains missing budgets and verified files use live accounts', async () => {
    // Never approved: the store holds no record for this project, so the file's accounts — which
    // it declares — are not in force, and the tool's own why-line for that standing prints.
    rmSync(storePath('acme', root, home), { recursive: true, force: true });
    withoutReadings();
    const bare = await usageAt(root, undefined, '--tree');
    expect(bare.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      'note: acme: the file was never approved on this machine',
      '',
      'usage on this machine, 1 team, 1 lab, 1 account',
    ].join('\n') + '\n');

    // The readings the state holds are not bound to the accounts the file declares: a caller who
    // is not the owner reads no line for them and the one fixed line for the dropped readings.
    withState();
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { counts: Record<string, number>; labs: unknown[]; notes: unknown[] };
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      'note: acme: the file was never approved on this machine',
      `note: acme: ${UNBOUND_ACCOUNT}`,
      '',
      'usage on this machine, 1 team, 1 lab, 1 account',
    ].join('\n') + '\n');
    expect(doc.notes).toEqual([
      { scope: 'acme', why: 'the file was never approved on this machine' },
      { scope: 'acme', why: UNBOUND_ACCOUNT },
    ]);

    // The owner reads the zero-config lab account and the state's own account beside it under
    // the machine's count, and no "not shown" line.
    const owner = await usageAt(root, OWNER, '--tree');
    expect(owner.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      'note: acme: the file was never approved on this machine',
      '',
      'usage on this machine, 1 team, 1 lab, 2 accounts',
    ].join('\n') + '\n');

    // A verified standing allows the accounts added to the live file immediately.
    const text = withoutBudgets();
    writeFileSync(file, text);
    approve(text);
    writeFileSync(file, teamText());
    for (const caller of [SEAT, OWNER]) {
      const moved = await usageAt(root, caller, '--tree');
      expect(moved.code).toBe(0);
      expect(moved.out).toBe(`${REPORT}\n`);
    }
  });

  test("a refused approval's own words are the owner's: one fixed sentence for a seat, every reason", async () => {
    const text = teamText();
    const store = storePath('acme', root, home);
    const record = join(store, 'approval.json');
    const keyFile = join(home, '.config', 'team-key', 'key.json');
    const generations = join(home, '.config', 'team-key', 'generations');
    const generationFile = () => join(generations, (readdirSync(generations) as string[])[0] as string);
    const read = () => JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown>;
    const write = (value: unknown) => writeFileSync(record, `${JSON.stringify(value, null, 2)}\n`);

    // The root of the after-review's case: a name this test owns, so its appearing anywhere in a
    // non-owner's output could only come from the store's own words.
    const foreign = join(base, 'acme-FOREIGN-ROOT-8ZKQ');
    mkdirSync(foreign, { recursive: true });

    /** A clean fixture before each reason: the store, the key and the generations start over. */
    const reset = () => {
      rmSync(join(home, '.config'), { recursive: true, force: true });
      mkdirSync(join(home, '.config', 'team', 'lobby'), { recursive: true });
      approve(text);
    };

    // Every refusal reason `approvalStanding` can produce, with its store.ts line. Two of the ten
    // cannot be reached by a record on disk — `:162`, guarded by the shape check (`store.ts:159-161`),
    // and `:179`, the belt-and-braces catch around `verifyPayload` (`store.ts:174-178`) — so eight
    // are fed here; the pull request lists all ten.
    const refusals: { at: string; refuse: () => void }[] = [
      { at: ':154 the record cannot be read', refuse: () => write({ format: 3 }) },
      { at: ':166 the key is missing', refuse: () => rmSync(keyFile, { force: true }) },
      { at: ':169 the key cannot be read', refuse: () => writeFileSync(keyFile, 'not a key at all') },
      { at: ':182 the signature does not verify', refuse: () => write({ ...read(), file: text.replace(/^project: .*$/m, 'project: changed-after-signing') }) },
      { at: ':185 another project root', refuse: () => {
        const checked = validateTeamFile(text, { home, root });
        if (!checked.ok) throw new Error('the fixture does not validate');
        writeApproval(store, { approval: approvalOf(checked.team, foreign, NOW), file: text }, [], home);
      } },
      { at: ':189 no generation recorded', refuse: () => rmSync(generationFile(), { force: true }) },
      { at: ':193 the record is older than the generation', refuse: () => {
        const earlier = read();
        approve(text);
        write(earlier);
      } },
      { at: ':194 only an older generation is recorded', refuse: () => {
        approve(text);
        writeFileSync(generationFile(), `${JSON.stringify({ format: 1, generation: 1, at: NOW.toISOString() }, null, 2)}\n`);
      } },
    ];

    for (const one of refusals) {
      reset();
      one.refuse();
      const standing = approvalStanding(root, home);
      expect([one.at, standing.kind], one.at).toEqual([one.at, 'refused']);
      const why = (standing as { why: string }).why;
      withState();

      // A seat gets the one fixed sentence, in both faces, and nothing that names the fixture.
      const mine = await usageAt(root, SEAT);
      expect(mine.code, one.at).toBe(0);
      expect(mine.out.split('\n'), one.at).toContain(`note: acme: ${NOT_VERIFIED}`);
      expect(mine.out, one.at).not.toContain('another project root');

      const raw = (await usageAt(root, SEAT, '--json')).out;
      expectNoDerivedPath([mine.out, raw], one.at);
      const notes = (JSON.parse(raw) as { notes: { scope: string; why: string }[] }).notes;
      expect(notes[0], one.at).toEqual({ scope: 'acme', why: NOT_VERIFIED });

      // The owner keeps the store's own words, byte for byte — the leak's own path included.
      const theirs = await usageAt(root, OWNER);
      expect(theirs.out, one.at).toContain(why);
      if (one.at.startsWith(':185')) {
        expect(why, one.at).toContain(foreign);
        expect(theirs.out, one.at).toContain(foreign);
        expect(mine.out, one.at).not.toContain('FOREIGN-ROOT-8ZKQ');
        expect(raw, one.at).not.toContain('FOREIGN-ROOT-8ZKQ');
      }
    }
  });

  test('outside any project it is a note and exit 0, in text and in JSON', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    const text = await usageAt(elsewhere, undefined, '--tree');
    expect(text.code).toBe(0);
    expect(text.err).toBe('');
    expect(text.out).toBe([
      'ACCOUNT  WINDOW  LEFT  USED  RESETS  RESERVE  READ  SOURCE  STATE',
      '',
      'quota',
      '  not known: no account declared; declare it in ~/.config/team/accounts.yaml',
      'advice: no lab is declared on this machine: declare an account first',
      `note: ${NO_PROJECT}`,
      '',
      'usage on this machine, 1 team, 2 labs, 2 accounts',
    ].join('\n') + '\n');
    const json = await usageAt(elsewhere, undefined, '--json');
    expect(JSON.parse(json.out)).toEqual({
      schema: { name: 'team.usage', version: 1 },
      format: 1,
      at: '2026-10-04T09:00:00.000Z',
      view: 'restricted',
      mine: null,
      counts: { teams: 1, labs: 2, accounts: 2 },
      labs: [],
      unknown: [],
      notes: [{ scope: 'mine', why: NO_PROJECT }],
      quota: {
        format: 1,
        accountsFile: '~/.config/team/accounts.yaml',
        labs: [],
        advice: 'no lab is declared on this machine: declare an account first',
      },
      teams: [],
    });
  });

  test('a repository with no team file answers the same way', async () => {
    const repo = join(base, 'empty-repo');
    mkdirSync(repo);
    execFileSync('git', ['init', repo], { env: gitEnv(), stdio: 'ignore' });
    const { code, out } = await usageAt(repo);
    expect(code).toBe(0);
    expect(out).toContain(`note: ${NO_PROJECT}\n`);
  });

  test("a file that exists and does not load is the loader's message for the owner, one fixed sentence for anyone else", async () => {
    writeFileSync(file, 'format: 1\nproject: acme\n');

    // The owner sees loader details, but invalid live YAML supplies no roster or accounts.
    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`note: ${file} line 1: seats is required`);
    expect(owner.out).toContain(`note: ${file} line 1: the file has no seat that leads`);
    // The team the machine still records prints by name: its folder in the store is the record
    // of which team this is (owner, 2026-10-17), never a path.
    expect(owner.out).toContain(`note: the team "acme" (${root}): its file could not be read.`);
    expect(owner.out).not.toContain('anthropic');

    // A caller who is not the owner reads one fixed sentence per line instead — this project's
    // own path, the line, and the owner as the reader of the reason — and never a body: the loader's bodies can name
    // paths outside this project (`trust: must list the lobby <home>/…`). The three problems here
    // all name line 1, so the one sentence prints once; the machine's own counts stand in the
    // header, and no lab or line of this project's is rendered, because none of it can be read.
    const mine = await usageAt(root, SEAT, '--tree');
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT  WINDOW  LEFT  USED  RESETS  RESERVE  READ  SOURCE  STATE',
      '',
      'quota',
      '  not known: no account declared; declare it in ~/.config/team/accounts.yaml',
      'advice: no lab is declared on this machine: declare an account first',
      'note: .agents/team.yaml does not load (line 1): the owner reads the reason',
      'note: acme: its file could not be read',
      '',
      'usage on this machine, 1 team, 0 labs, 0 accounts',
    ].join('\n') + '\n');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { mine: string | null; labs: unknown[]; notes: unknown[] };
    expect(doc.mine).toBeNull();
    expect(doc.labs).toEqual([]);
    expect(doc.notes).toEqual([{ scope: 'mine', why: '.agents/team.yaml does not load (line 1): the owner reads the reason' }, { scope: 'acme', why: 'its file could not be read' }]);
    expectNoDerivedPath([mine.out, raw]);
  });

  test('a file that exists and cannot be read prints the error for the owner, one fixed sentence for anyone else', async () => {
    // A directory where the file would be, in a checkout the loader resolves: the read itself is
    // what fails. The loader refuses it with its own sentence and marks the problem unreadable,
    // so the owner reads that reason, while anyone else reads one fixed sentence whose body never
    // passes through — a read error can name the path it failed on
    // (`ENOENT: … open '/<path>'`, a recorded probe).
    rmSync(file);
    mkdirSync(file, { recursive: true });
    execFileSync('git', ['init', root], { env: gitEnv(), stdio: 'ignore' });
    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`note: the team file at ${file} could not be read\n`);
    const mine = await usageAt(root, SEAT, '--tree');
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT  WINDOW  LEFT  USED  RESETS  RESERVE  READ  SOURCE  STATE',
      '',
      'quota',
      '  not known: no account declared; declare it in ~/.config/team/accounts.yaml',
      'advice: no lab is declared on this machine: declare an account first',
      'note: .agents/team.yaml cannot be read: the owner reads the reason',
      'note: acme: its file could not be read',
      '',
      'usage on this machine, 1 team, 0 labs, 0 accounts',
    ].join('\n') + '\n');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect((JSON.parse(raw) as { notes: unknown[] }).notes).toEqual([{ scope: 'mine', why: '.agents/team.yaml cannot be read: the owner reads the reason' }, { scope: 'acme', why: 'its file could not be read' }]);
    expectNoDerivedPath([mine.out, raw]);
  });

  test('no location the tool derived reaches a caller who is not the owner, whatever breaks', async () => {
    // Every class the loader, its placement checks, the state and the resolution can hand this
    // command, provoked one at a time. Each runs through both faces, and `expectNoDerivedPath`
    // sweeps the whole of each: not a figure or a row depends on who asks, and no note may name a
    // root, the home folder, the store or a state or file path of this machine.
    const faces = async (cwd: string): Promise<string> => {
      const text = await usageAt(cwd, SEAT);
      const raw = (await usageAt(cwd, SEAT, '--json')).out;
      expect(text.code).toBe(0);
      expectNoDerivedPath([text.out, raw]);
      return text.out;
    };

    // Validation: three problems, all on line 1 — one fixed sentence, once.
    writeFileSync(file, 'format: 1\nproject: acme\n');
    expect(await faces(root)).toContain('note: .agents/team.yaml does not load (line 1): the owner reads the reason\n');

    // Placement, no line: the trust list omits the lobby, whose absolute path the loader's body
    // names (`trust: must list the lobby <home>/.config/team/lobby`).
    writeFileSync(file, teamText().replace('  - ~/.config/team/lobby\n', ''));
    expect(await faces(root)).toContain('note: .agents/team.yaml does not load: the owner reads the reason\n');

    // Placement, with a line: a trust entry is a symbolic link; the loader's body names the entry
    // and the target it resolves to, both absolute.
    const target = join(base, 'linked-target');
    const linked = join(base, 'linked-entry');
    mkdirSync(target);
    symlinkSync(target, linked);
    const withLink = teamText().replace(`  - ${root}`, `  - ${linked}\n  - ${root}`);
    writeFileSync(file, withLink);
    const entry = withLink.split('\n').findIndex((line) => line.includes(linked)) + 1;
    expect(await faces(root)).toContain(`note: .agents/team.yaml does not load (line ${entry}): the owner reads the reason\n`);

    // YAML that does not parse: the parser's own line.
    writeFileSync(file, 'project: [unclosed\n');
    expect(await faces(root)).toContain('note: .agents/team.yaml does not load (line 1): the owner reads the reason\n');

    // A file that exists and cannot be read: the read itself fails, and the loader's marked
    // refusal keeps its own sentence for this caller.
    rmSync(file);
    mkdirSync(file, { recursive: true });
    execFileSync('git', ['init', root], { env: gitEnv(), stdio: 'ignore' });
    expect(await faces(root)).toContain('note: .agents/team.yaml cannot be read: the owner reads the reason\n');

    // A team file that is a symbolic link in a plain folder: not followed, so no project here.
    const plain = join(base, 'plain');
    mkdirSync(join(plain, '.agents'), { recursive: true });
    writeFileSync(join(base, 'target.yaml'), 'format: 1\n');
    symlinkSync(join(base, 'target.yaml'), join(plain, '.agents', 'team.yaml'));
    expect(await faces(plain)).toContain(`note: ${NO_PROJECT}\n`);

    // A state that cannot be read: the state's own reason with this project's own path in it.
    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, teamText());
    writeFileSync(join(root, '.agents', 'team.state.json'), 'not json');
    expect(await faces(root)).toContain('note: acme: .agents/team.state.json is not valid JSON; move it aside and run the command again\n');

    // No project at all: the one note, and nothing for it to name.
    const nowhere = join(base, 'nowhere');
    mkdirSync(nowhere);
    expect(await faces(nowhere)).toContain(`note: ${NO_PROJECT}\n`);
  });

  test('an account named like an absolute path prints as written, and is the only such string a seat reads', async () => {
    // The after-review's case, under the ruling: a valid, approved file whose `budgets.accounts`
    // key is an absolute path. Account names have no closed grammar at load — that is S2's
    // question, not this slice's — so the name is this team's own agreed data: a seat reads it as
    // written, exactly as `status` shows it. The exception is pinned, not silently wide: the name
    // must be the ONLY absolute-looking string in either face, and nothing the tool derived may
    // ride along with it.
    const name = '/ABSOLUTE-ACCOUNT-LEAK';
    const text = teamText().replace('    anthropic:', `    ${name}:`);
    writeFileSync(file, text);
    approve(text);
    withState();

    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect(mine.code).toBe(0);
    expect(mine.out).toContain(`\n${name}  -        -     -     -        -                   -                        -                       unknown  not readable from a CLI screen\n`);
    expect(mine.out).toContain(`  ${name}  acme  unknown  pace not known\n`);
    // The name is the only absolute-looking string in either face, however often it repeats in
    // the document — in the text, at each place the document names the account: its table row,
    // the caller's team row, and the quota block's lab and account lines — and no string the
    // tool derived stands anywhere near it.
    expect(absoluteTokens(mine.out)).toEqual([name, name, name, name]);
    expect(absoluteTokens(raw).length).toBeGreaterThan(0);
    expect(absoluteTokens(raw).filter((token) => token !== name)).toEqual([]);
    expectNoDerivedPath([mine.out, raw], undefined, [name]);
    for (const face of [mine.out, raw]) {
      expect(face).not.toContain(base);
      expect(face).not.toContain(home);
    }

    // And the owner reads the same name, exactly as `status` prints it: the exception is about
    // who wrote the string, never about who is reading it.
    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`${name}  -        -     -     -        -                   -                        -                       unknown  not readable from a CLI screen\n`);
    expect(owner.out).toContain(`  ${name}  acme  unknown  pace not known\n`);
  });

  test("a stored reading's own names are the state's: a seat reads only what the file binds", async () => {
    // The second read's case, under the ruling: the state file is signed by nothing — it is a
    // cache, not the approved copy — and `readState` validates no part of a stored reading, so
    // its `account` and `seat` are strings whoever wrote the state chose. In an approved project
    // with no budgets the reviewer wrote `account: /STATE-ACCOUNT-LEAK` and `seat:
    // /STATE-SEAT-LEAK`, and `usage --json` as a seat printed both.
    const text = withoutBudgets();
    writeFileSync(file, text);
    approve(text);
    updateState(join(root, '.agents'), (state) => {
      state.budgets = {
        'leak/leak': {
          account: '/STATE-ACCOUNT-LEAK',
          window: 'session',
          left: 40,
          used: 60,
          changedAt: '2026-10-04T08:58:00Z',
          resetsAt: null,
          seat: '/STATE-SEAT-LEAK',
          source: 'status_line',
          confirmed: true,
        },
      } as never;
      state.sessions['acme-web'] = { ...emptySession() } as never;
    });

    // A caller who is not the owner reads no line and no name from the state: the zero-config
    // account of the lab the seat draws on, and one fixed line for the reading that was dropped —
    // `nothing in rows`, as the ruling has it, because the file names no account to bind it to.
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { counts: Record<string, number>; labs: unknown[]; notes: unknown[] };
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      `note: acme: ${UNBOUND_ACCOUNT}`,
      '',
      'usage on this machine, 1 team, 1 lab, 1 account',
    ].join('\n') + '\n');
    expect(doc.counts).toEqual({ teams: 1, labs: 1, accounts: 1 });
    expect(doc.labs).toEqual([{ lab: 'anthropic', accounts: [synthesized('anthropic', true)] }]);
    expect(doc.notes).toEqual([{ scope: 'acme', why: UNBOUND_ACCOUNT }]);
    for (const face of [mine.out, raw]) {
      expect(face).not.toContain('STATE-ACCOUNT-LEAK');
      expect(face).not.toContain('STATE-SEAT-LEAK');
    }

    // The owner reads no such name either: a face is keyed by the file's own declarations, and
    // none declares this reading, so neither view prints what the state wrote. The owner reads
    // the zero-config lab account and the machine's own count — the state's reading is there, so
    // its account is counted beside the lab's — and neither view prints a "not shown" line.
    const owner = await usageAt(root, OWNER);
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    const ownerDoc = JSON.parse(ownerRaw) as { counts: Record<string, number>; notes: unknown[] };
    expect(owner.code).toBe(0);
    expect(owner.out).toContain('usage on this machine, 1 team, 1 lab, 2 accounts\n');
    expect(ownerDoc.counts).toEqual({ teams: 1, labs: 1, accounts: 2 });
    expect(ownerDoc.notes).toEqual([]);
    for (const face of [owner.out, ownerRaw]) {
      expect(face).not.toContain('STATE-ACCOUNT-LEAK');
      expect(face).not.toContain('STATE-SEAT-LEAK');
      expect(face).not.toContain('not shown');
    }
  });

  test('a vendor only the live file writes binds a stored reading', async () => {
    // The live vendor name binds a cached reading even when the saved roster names another vendor.
    const LIVE_VENDOR = '/LIVE-VENDOR-LEAK';
    const live = teamText().replace('    vendor: anthropic', `    vendor: ${LIVE_VENDOR}`);
    // The route's own precondition, pinned: the edited file still loads, so the live file is the
    // one `usage` reads. A loader that refused the edit would close the route by itself.
    expect(validateTeamFile(live, { home, root }).ok).toBe(true);
    writeFileSync(file, live);
    updateState(join(root, '.agents'), (state) => {
      state.budgets = {
        'live/vendor': { account: LIVE_VENDOR, window: 'session', left: 40, used: 60, changedAt: '2026-10-04T08:58:00Z', resetsAt: null, seat: null, source: 'status_line', confirmed: true },
      } as never;
    });

    // The live seat account binds this name for either view.
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { counts: Record<string, number>; labs: unknown[]; notes: unknown[] };
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  READ  SOURCE  STATE',
      'anthropic  -       -     -     -       -     -       unknown',
      'openai     -       -     -     -       -     -       unknown',
      `${LIVE_VENDOR}  not readable from a screen  (1 seat)`,
      '  anthropic  acme  unknown  pace not known',
      '  openai  acme  unknown  pace not known',
      '  openai  (acme: no pattern can read this account)',
      '',
      'quota',
      `  ${LIVE_VENDOR}  unknown`,
      `    ${LIVE_VENDOR}  unknown  seats: lead`,
      '      not known: no reading yet',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      '  openai  unknown',
      '    openai  unknown',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      '',
      'usage on this machine, 1 team, 3 labs, 3 accounts',
    ].join('\n') + '\n');
    expect(doc.counts).toEqual({ teams: 1, labs: 3, accounts: 3 });
    expect(doc.notes).toEqual([]);
    for (const face of [mine.out, raw]) expect(face).toContain('LIVE-VENDOR-LEAK');

    // The owner reads it the same way: the live vendor's own lab, which no screen reads, stands
    // for its seat in one line — the seat count is the fact, and no "not shown" line prints.
    const owner = await usageAt(root, OWNER, '--tree');
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`${LIVE_VENDOR}  not readable from a screen  (1 seat)\n`);
    expect(owner.out).toContain(`  ${LIVE_VENDOR}  unknown\n`);
    expect(owner.out).toContain(`    ${LIVE_VENDOR}  unknown  seats: lead\n`);
    expect(ownerRaw).toContain(LIVE_VENDOR);
    for (const face of [owner.out, ownerRaw]) expect(face).not.toContain('not shown');
  });

  test('a seat only the live file names holds its stored reading', async () => {
    // A newly declared live seat retains its name on cached readings.
    const live = teamText() + [
      '  - role: member',
      '    name: ghost',
      '    cli: claude-code',
      '    vendor: openai',
      '    model: Claude Opus',
      '    version: "5.5"',
      '    launch: claude --model claude-opus-5-5',
      '',
    ].join('\n');
    expect(validateTeamFile(live, { home, root }).ok).toBe(true);
    writeFileSync(file, live);
    updateState(join(root, '.agents'), (state) => {
      state.budgets = {
        'openai/weekly/ghost': { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: '2026-10-04T08:58:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'ghost', source: 'status_line', confirmed: true },
      } as never;
    });

    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { labs: { accounts: { machine: { seat?: unknown } }[] }[] };
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  RESERVE             READ                   SOURCE                  STATE',
      'anthropic  -       -     -     -       -                   -                      -                       unknown',
      'openai     weekly  5%    95%   in 44m  inside reserve 20%  ghost  changed 2m ago  status line (fallback)  near cap  pace not known  (no watch is recording for acme)',
      '  anthropic  acme  unknown  pace not known',
      '  openai  acme  weekly  left 5%  used 95%  resets in 44m  ghost  changed 2m ago  status line (fallback)  fresh, inside reserve 20%  pace not known',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead, ghost',
      '      not known: no reading yet',
      '  openai  unknown',
      '    openai  unknown',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT   CLI          ACCOUNT',
      '  lead   claude-code  anthropic',
      '  ghost  claude-code  anthropic',
      '  lead  claude-code  anthropic  unknown  no reading for this seat',
      "  lead  claude-code  anthropic  cost  unknown  no money cost was read from this seat's screen this run",
      '  ghost  claude-code  openai  weekly  left 5%  used 95%  resets in 44m  margin +4.6%  estimated  state record  read 2m ago',
      "  ghost  claude-code  anthropic  cost  unknown  no money cost was read from this seat's screen this run",
      '',
      'usage on this machine, 1 team, 2 labs, 2 accounts',
    ].join('\n') + '\n');
    expect(doc.labs.flatMap((lab) => lab.accounts).map((entry) => entry.machine.seat)).toEqual([undefined, 'ghost']);
    for (const face of [mine.out, raw]) expect(face).toContain('ghost');

    // The owner sees the reading's own seat, exactly as the state holds it.
    const owner = await usageAt(root, OWNER);
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    expect(owner.code).toBe(0);
    expect(owner.out).toContain('ghost');
    expect(ownerRaw).toContain('ghost');
  });

  test('both views use the live project name', async () => {
    // A live project rename updates the header, watch clause and JSON identity for both views.
    const LIVE_PROJECT = 'a-project-nobody-approved';
    const live = teamText().replace('project: acme', `project: ${LIVE_PROJECT}`);
    expect(validateTeamFile(live, { home, root }).ok).toBe(true);
    writeFileSync(file, live);
    expect(approvalStanding(root, home).kind).toBe('verified');
    withState();

    // Both views use the live project identity.
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect(mine.code).toBe(0);
    expect(mine.out).toBe(`${REPORT.replaceAll('acme', LIVE_PROJECT)}\n`);
    expect((JSON.parse(raw) as { mine: string }).mine).toBe(LIVE_PROJECT);
    for (const face of [mine.out, raw]) expect(face).toContain(LIVE_PROJECT);

    // The owner reads the live name as today: the view this command had before the restricted
    // path, and the name the file has now.
    const owner = await usageAt(root, OWNER, '--tree');
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    expect(owner.code).toBe(0);
    expect(owner.out).toBe(`${REPORT.replaceAll('acme', LIVE_PROJECT)}\n`);
    expect((JSON.parse(ownerRaw) as { mine: string }).mine).toBe(LIVE_PROJECT);
  });

  test('an unreadable stored copy does not hide the live project and accounts', async () => {
    // A verified record with invalid stored YAML must not replace the valid live project and accounts.
    const name = '/APPROVED-ACCOUNT';
    const LIVE_PROJECT = 'a-project-nobody-approved';
    const text = teamText().replace('    openai:', `    ${name}:`).replace('project: acme', `project: ${LIVE_PROJECT}`);
    const checked = validateTeamFile(text, { home, root });
    if (!checked.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(checked.errors)}`);
    writeFileSync(file, text);
    // The record `team approve` would write, signed by the store's key, with one edit: the copy
    // it stores is not a team file. The store is found by the root's hash, so the record lives
    // under the name the owner approved and the rename moved nothing. The live file still
    // matches the record's fingerprints — the shortcut's precondition, pinned here so a change
    // of that precondition shows.
    const invalid = 'not a team file: [';
    expect(validateTeamFile(invalid).ok).toBe(false);
    // Only a record signed over the text (the compatibility path) can carry a copy that is not a team file.
    writeTextSignedApproval(storePath('acme', root, home), { approval: approvalOf(checked.team, root, NOW), file: invalid }, [], home);
    expect(approvalStanding(root, home).kind).toBe('verified');
    updateState(join(root, '.agents'), (state) => {
      state.budgets = {
        'approved/session': { account: name, window: 'session', left: 40, used: 60, changedAt: '2026-10-04T08:58:00Z', resetsAt: null, seat: null, source: 'status_line', confirmed: true },
        'anthropic/session': { account: 'anthropic', window: 'session', left: 70, used: 30, changedAt: '2026-10-04T08:58:00Z', resetsAt: null, seat: null, source: 'status_line', confirmed: true },
      } as never;
      state.sessions['acme-web'] = { ...emptySession() } as never;
    });

    // Both views read the live project's declared accounts despite an invalid stored copy.
    const mine = await usageAt(root, SEAT);
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { counts: Record<string, number>; labs: unknown[]; notes: unknown[]; mine: string | null };
    expect(mine.code).toBe(0);
    expect(doc.counts).toEqual({ teams: 1, labs: 2, accounts: 2 });
    expect(doc.notes).toEqual([]);
    expect(doc.mine).toBe(LIVE_PROJECT);
    for (const face of [mine.out, raw]) {
      expect(face).toContain(name);
      expect(face).toContain('anthropic');
      expect(face).toContain(LIVE_PROJECT);
    }

    // The owner reads the live file's own names as today — exactly what `status` still shows —
    // the live project among them, and no "not shown" line.
    const owner = await usageAt(root, OWNER);
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(`${name}  session`);
    expect(owner.out).toContain(`${LIVE_PROJECT}  session  left 70%`);
    expect(ownerRaw).toContain(name);
    expect((JSON.parse(ownerRaw) as { mine: string }).mine).toBe(LIVE_PROJECT);
    for (const face of [owner.out, ownerRaw]) expect(face).not.toContain('not shown');
  });

  test('hostile state: not one string of a stored reading reaches a caller who is not the owner', async () => {
    // Every string field a `StoredReading` holds, each a name this test owns: account, window,
    // source and seat on readings whose account the file names, and the two time fields as
    // strings where times belong. Whatever route the state's words could take into a face, one
    // of these would show it. The sweep at the end is over both faces of the non-owner's run,
    // and the owner's own run proves the readings really are in the state.
    const WINDOW_LEAK = '/STATE-WINDOW-LEAK';
    const SOURCE_LEAK = '/STATE-SOURCE-LEAK';
    const SEAT_LEAK = '/STATE-SEAT-LEAK';
    const TIME_LEAK = '/STATE-TIME-LEAK';
    withState();
    updateState(join(root, '.agents'), (state) => {
      state.budgets = {
        // A window the tool does not write, with both time fields as strings for the sweep to
        // cover (`table.ts` writes `session`, `daily`, `weekly`; a time is parsed before any
        // face sees it — no face can carry one as written, the owner's included).
        'openai/window-leak': {
          account: 'openai',
          window: WINDOW_LEAK,
          left: 40,
          used: 60,
          changedAt: TIME_LEAK,
          resetsAt: TIME_LEAK,
          seat: null,
          source: 'status_line',
          confirmed: true,
        },
        // A source the tool does not write (`check`, `status_line` are the two).
        'openai/source-leak': {
          account: 'openai',
          window: 'session',
          left: 40,
          used: 60,
          changedAt: '2026-10-04T08:58:00Z',
          resetsAt: null,
          seat: null,
          source: SOURCE_LEAK,
          confirmed: true,
        },
        // A seat the file's seats do not name; its account and its shape are ones the file binds.
        'openai/weekly': {
          account: 'openai',
          window: 'weekly',
          left: 5,
          used: 95,
          changedAt: '2026-10-04T08:58:00Z',
          resetsAt: '2026-10-04T09:44:00Z',
          seat: SEAT_LEAK,
          source: 'status_line',
          confirmed: true,
        },
      } as never;
    });

    // A caller who is not the owner reads none of those strings. The bound reading prints its
    // figures with no seat — a seat's name is narrower than an account's, it does not hide the
    // figures behind it — and the other two are not rendered at all, one fixed line for both.
    const mine = await usageAt(root, SEAT, '--tree');
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { labs: { lab: string; accounts: { machine: { window: string | null; seat?: unknown } }[] }[]; notes: unknown[] };
    expect(mine.code).toBe(0);
    expect(mine.out).toBe([
      'ACCOUNT    WINDOW  LEFT  USED  RESETS  RESERVE             READ               SOURCE                  STATE',
      'anthropic  -       -     -     -       -                   -                  -                       unknown',
      'openai     weekly  5%    95%   in 44m  inside reserve 20%  -  changed 2m ago  status line (fallback)  near cap  pace not known  (no watch is recording for acme)',
      '  anthropic  acme  unknown  pace not known',
      '  openai  acme  weekly  left 5%  used 95%  resets in 44m  -  changed 2m ago  status line (fallback)  fresh, inside reserve 20%  pace not known',
      '',
      'quota',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead',
      '      not known: no reading yet',
      '  openai  unknown',
      '    openai  unknown',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      ...noFigure('lead', 'claude-code', 'anthropic'),
      `note: acme: ${UNBOUND_SHAPE}`,
      '',
      'usage on this machine, 1 team, 2 labs, 2 accounts',
    ].join('\n') + '\n');
    // The labs run in name order; the anthropic line has no figure at all, so its machine entry
    // carries no `seat` key (a machine entry with a figure carries the seat when it knows one),
    // and the weekly line's seat — the state's string, which the file's seats do not name — is
    // dropped for both the line and the row.
    expect(doc.labs.map((lab) => [lab.lab, ...lab.accounts.map((entry) => [entry.machine.window, entry.machine.seat])])).toEqual([
      ['anthropic', [null, undefined]],
      ['openai', ['weekly', null]],
    ]);
    expect(doc.notes).toEqual([{ scope: 'acme', why: UNBOUND_SHAPE }]);
    for (const face of [mine.out, raw]) {
      for (const leak of [WINDOW_LEAK, SOURCE_LEAK, SEAT_LEAK, TIME_LEAK]) {
        expect(face).not.toContain(leak);
      }
    }

    // The owner reads what a face can carry, exactly as the state holds it: the seat of a reading
    // whose account and window the file backs. Neither the window nor the source string can reach
    // any face — the report's lines are the table's own windows and the tool's two sources, so a
    // reading from anywhere else counts for nothing and its row is blank — and a time string is
    // parsed before any face sees it.
    const owner = await usageAt(root, OWNER);
    const ownerRaw = (await usageAt(root, OWNER, '--json')).out;
    expect(owner.code).toBe(0);
    expect(owner.out).toContain(SEAT_LEAK);
    expect(ownerRaw).toContain(SEAT_LEAK);
    for (const leak of [WINDOW_LEAK, SOURCE_LEAK, TIME_LEAK]) {
      expect(owner.out).not.toContain(leak);
      expect(ownerRaw).not.toContain(leak);
    }
    for (const face of [owner.out, ownerRaw]) expect(face).not.toContain('not shown');
  });

  test('any caller may run it, and a subfolder of a checkout reads the same project', async () => {
    withState();
    const unplaced: Caller = { kind: 'unplaced', reason: 'it is run by an agent (claude) outside herdr' };
    expect((await usageAt(root, SEAT, '--tree')).out).toBe(`${REPORT}\n`);
    expect((await usageAt(root, unplaced, '--tree')).out).toBe(`${REPORT}\n`);

    execFileSync('git', ['init', root], { env: gitEnv(), stdio: 'ignore' });
    const sub = join(root, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    const nested = await usageAt(sub, SEAT, '--tree');
    expect(nested.out).toBe(`${REPORT}\n`);
  });

  test('the invocation is the one refusal, and it prints the usage', async () => {
    const io = testIo(root);
    const code = await runUsage(['--nope'], io, { home, now: () => NOW });
    expect(code).toBe(2);
    expect(io.err).toBe(`team usage: unknown option --nope\n${USAGE}`);
    const extra = testIo(root);
    expect(await runUsage(['now'], extra, { home, now: () => NOW })).toBe(2);
    expect(extra.err).toBe(`team usage: unexpected "now"\n${USAGE}`);
    // `--json` is read from the raw tokens before the parser runs, so a bad argument does not
    // hide it: the refusal writes the `team.error` envelope on stdout, stderr empty, exit 2 —
    // whichever side of the bad token the flag stands on.
    for (const [argv, message] of [
      [['now', '--json'], 'unexpected "now"'],
      [['--nope', '--json'], 'unknown option --nope'],
      [['--json', 'now'], 'unexpected "now"'],
    ] as const) {
      const marked = await usageAt(root, SEAT, ...argv);
      expect({ argv, code: marked.code, err: marked.err }).toEqual({ argv, code: 2, err: '' });
      expect(JSON.parse(marked.out)).toEqual({
        schema: { name: 'team.error', version: 1 },
        error: { id: 'usage.invocation', message, repair: null },
      });
    }
  });

  test('the store folder itself unreadable is the other refusal: the owner reads the reason, a seat does not', async () => {
    // § 2.4's one refusal beside the invocation. The store folder's own path and the read's why
    // are this machine's derivation, so a caller who is not the owner reads the fixed sentence,
    // exit 2, and nothing of the folder; the owner reads both.
    rmSync(join(home, '.config', 'team'), { recursive: true, force: true });
    writeFileSync(join(home, '.config', 'team'), 'not a folder\n');
    const mine = await usageAt(root, SEAT);
    expect(mine.code).toBe(2);
    expect(mine.err).toBe('team usage: the store folder cannot be read: the owner reads the reason\n');
    expect(mine.out).toBe('');
    expectNoDerivedPath([mine.err]);
    const owner = await usageAt(root, OWNER);
    expect(owner.code).toBe(2);
    expect(owner.err).toBe(`team usage: the store folder ${join(home, '.config', 'team')} could not be read: ENOTDIR: not a directory, scandir '${join(home, '.config', 'team')}'\n`);
    expect(owner.out).toBe('');
  });

  test('the gate: with two stores, nothing of the other team reaches a seat — in the text, in --json, in every note', async () => {
    // The brief's gate, as a test: a temporary home with two stores whose team names and roots
    // are distinctive strings, each holding one account the other does not, both spending one
    // shared account. Two further stores hold broken states, so the anonymized note families and
    // their counts are in the report too. Every string a seat must not read is in `theirs`, and
    // the same list is swept over the text, the `--json` and the notes of the restricted run —
    // and over the owner's run as a positive control, so the sweep can never pass by the string
    // never having been there.
    const project = 'acme-7QK';
    // The scene is exactly the stores this test builds: the suite's own fixture is taken away,
    // its store and its root both, so the counts below are the two sound teams and the two
    // broken ones and no other.
    rmSync(storePath('acme', root, home), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    const mineRoot = join(base, project);
    mkdirSync(join(mineRoot, '.agents'), { recursive: true });
    writeFileSync(join(mineRoot, '.agents', 'team.yaml'), teamTextFor(project, ['acme-only-8ZKQ'], ''));
    approve(teamTextFor(project, ['acme-only-8ZKQ'], ''), { root: mineRoot, name: project });
    updateState(join(mineRoot, '.agents'), (state) => {
      state.sessions[`${project}-web`] = { ...emptySession() } as never;
      state.budgets = {
        'openai/weekly/lead': { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: '2026-10-04T08:50:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'lead', source: 'status_line', confirmed: true },
        'mine/weekly': { account: 'acme-only-8ZKQ', window: 'weekly', left: 9, used: 91, changedAt: '2026-10-04T08:58:00Z', resetsAt: null, seat: null, source: 'status_line', confirmed: true },
        // A reading of mine under the other team's account: bound by nothing, and dropped.
        'stray/weekly': { account: 'zeta-only-3HMV', window: 'weekly', left: 9, used: 91, changedAt: '2026-10-04T08:58:00Z', resetsAt: null, seat: null, source: 'status_line', confirmed: true },
      } as never;
    });

    const theirProject = 'zeta-4WX';
    const theirRoot = join(base, theirProject);
    const theirFile = join(theirRoot, '.agents', 'team.yaml');
    mkdirSync(join(theirRoot, '.agents'), { recursive: true });
    const theirText = teamTextFor(theirProject, ['zeta-only-3HMV', 'claude-extra'], extraSeat('extra-seat-6RT', 'claude-extra'));
    writeFileSync(theirFile, theirText);
    approve(theirText, { root: theirRoot, name: theirProject });
    updateState(join(theirRoot, '.agents'), (state) => {
      state.sessions[`${theirProject}-web`] = { ...emptySession() } as never;
      state.budgets = {
        // The newest reading of the shared account is theirs: a seat of mine reads the figure,
        // never the team (`§ 2.3`: `read by another team`).
        'openai/weekly/scout': { account: 'openai', window: 'weekly', left: 88, used: 12, changedAt: '2026-10-04T08:59:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'scout', source: 'status_line', confirmed: true },
        'zeta/weekly': { account: 'zeta-only-3HMV', window: 'weekly', left: 63, used: 37, changedAt: '2026-10-04T08:59:00Z', resetsAt: null, seat: null, source: 'status_line', confirmed: true },
        'extra/weekly': { account: 'claude-extra', window: 'weekly', left: 44, used: 56, changedAt: '2026-10-04T08:59:00Z', resetsAt: null, seat: 'extra-seat-6RT', source: 'status_line', confirmed: true },
      } as never;
    });

    // Two stores whose states cannot be read: the anonymized family for that, twice, so its count
    // is in the report (`2 teams' states cannot be read`).
    const broken = ['omega-9PL', 'kappa-2VN'];
    for (const brokenProject of broken) {
      const brokenRoot = join(base, brokenProject);
      mkdirSync(join(brokenRoot, '.agents'), { recursive: true });
      const brokenText = teamTextFor(brokenProject, [], '');
      writeFileSync(join(brokenRoot, '.agents', 'team.yaml'), brokenText);
      approve(brokenText, { root: brokenRoot, name: brokenProject });
      writeFileSync(join(brokenRoot, '.agents', 'team.state.json'), 'not json');
    }

    const theirs = [theirProject, theirRoot, join(theirRoot, '.agents'), 'zeta-only-3HMV', 'claude-extra', 'scout', 'extra-seat-6RT', `${theirProject}-web`, join(base, 'omega-9PL'), join(base, 'kappa-2VN'), 'omega-9PL', 'kappa-2VN'];

    const seat = await usageAt(mineRoot, SEAT, '--tree');
    const raw = (await usageAt(mineRoot, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { counts: Record<string, number>; notes: unknown[] };
    expect(seat.code).toBe(0);
    // The whole restricted face, pinned: the machine's counts, one block per lab this caller
    // carries, the account lines of the labs it does not (their figures are the machine's — an
    // account the caller's own file names is the caller's business, its team's name is not), the
    // caller's own rows, and the two notes. The `anthropic` lab is the caller's own by its
    // seat's vendor: its zero-config account prints, and the other teams' accounts in it are the
    // count beside the lab, never a name.
    expect(seat.out).toBe([
      'ACCOUNT         WINDOW  LEFT  USED  RESETS   RESERVE             READ                          SOURCE       STATE',
      'acme-only-8ZKQ  weekly  9%    91%   unknown  inside reserve 10%  -  changed 2m ago             status line  near cap  pace not known  (no watch is recording for acme-7QK)',
      'anthropic       -       -     -     -        -                   -                             -            unknown',
      'openai          weekly  88%   12%   in 44m   -                   read by another team, 1m ago  status line  ok    (no watch is recording for it)',
      '  acme-only-8ZKQ  acme-7QK  weekly  left 9%  used 91%  resets unknown  -  changed 2m ago  status line  fresh, inside reserve 10%  pace not known',
      'anthropic: 1 other account',
      '  openai  acme-7QK  weekly  left 5%  used 95%  resets in 44m  lead  changed 10m ago  status line  fresh, inside reserve 20%  pace not known',
      '',
      'quota',
      '  acme-only-8ZKQ  unknown',
      '    acme-only-8ZKQ  unknown',
      '      not known: no reading yet',
      '  anthropic  unknown',
      '    anthropic  unknown  seats: lead, +4 on another team',
      '      not known: no reading yet',
      '  openai  unknown',
      '    openai  unknown',
      '      not known: no reading yet',
      'advice: no readings yet: no seat status line and no CLI usage command has answered',
      '',
      'acme-7QK',
      '  SEAT  CLI          ACCOUNT',
      '  lead  claude-code  anthropic',
      // The caller's own state holds this seat's weekly record; it is old enough to be stale, so
      // the margin is not read from it, and the spend is unknown with its reason.
      '  lead  claude-code  openai  weekly  left 5%  used 95%  resets in 44m  margin not known  estimated  state record  read 10m ago  stale',
      "  lead  claude-code  anthropic  cost  unknown  no money cost was read from this seat's screen this run",
      "note: acme-7QK: a stored reading names an account this team's file does not: not shown",
      "note: 2 teams' states cannot be read (not valid JSON; move it aside and run the command again)",
      '',
      'usage on this machine, 4 teams, 4 labs, 4 accounts',
    ].join('\n') + '\n');
    expect(doc.counts).toEqual({ teams: 4, labs: 4, accounts: 4 });
    expect(doc.notes).toEqual([
      { scope: 'acme-7QK', why: "a stored reading names an account this team's file does not: not shown" },
      { scope: 'another', why: 'its state cannot be read (not valid JSON; move it aside and run the command again)', count: 2 },
    ]);
    for (const face of [seat.out, raw]) {
      for (const string of theirs) expect(face).not.toContain(string);
    }

    // The positive control: the owner reads every one of those strings — the names, the roots,
    // the seats, the labs — so the sweep above is never vacuous.
    const defaultOwner = await usageAt(mineRoot, OWNER);
    expect(defaultOwner.out).not.toContain('  zeta-only-3HMV  zeta-4WX');
    const owner = await usageAt(mineRoot, OWNER, '--all');
    const ownerRaw = (await usageAt(mineRoot, OWNER, '--json', '--all')).out;
    expect(owner.out).toContain('read by zeta-4WX, 1m ago');
    expect(owner.out).toContain('claude-extra    weekly');
    expect(owner.out).toContain('  openai  zeta-4WX  weekly  left 88%');
    expect(owner.out).toContain('scout');
    expect(ownerRaw).toContain(theirRoot);
    expect(ownerRaw).toContain('extra-seat-6RT');
    // The broken teams' own state paths do not reach the owner either: another team's problem is
    // one counted sentence per kind in both views, never one note per team and never a path.
    expect(owner.out).toContain("note: 2 teams' states cannot be read (not valid JSON; move it aside and run the command again)\n");
    expect(owner.out).not.toContain(join(base, 'omega-9PL', '.agents', 'team.state.json'));

    // And the other side of the property: their seat reads their own material and none of mine.
    const theirSeat = await usageAt(theirRoot, { kind: 'seat', name: 'scout', pane: 'w1:p1', session: `${theirProject}-web` });
    const theirRaw = (await usageAt(theirRoot, { kind: 'seat', name: 'scout', pane: 'w1:p1', session: `${theirProject}-web` }, '--json')).out;
    expect(theirSeat.out).toContain('zeta-only-3HMV');
    expect(theirSeat.out).toContain('claude-extra');
    expect(theirSeat.out).not.toContain('acme-only-8ZKQ');
    expect(theirSeat.out).not.toContain(project);
    expect(theirRaw).not.toContain(mineRoot);
  });

  test('a process placed as the owner without a terminal still reads the restricted view', async () => {
    // A run with no terminal is placed `owner-no-tty` and reads the restricted view. The full view
    // is `kind === 'owner'`, the owner at a terminal. The witness below is placed by the same walk
    // every command uses, and the full view
    // is still not its to read.
    const io = testIo(root);
    io.callerSources = () => ({
      ancestors: () => [{ pid: process.pid, name: 'zsh' }],
      agents: () => null,
      paneRootPid: () => null,
      env: {},
      stdinIsTTY: false,
    });
    const placed = walkCaller(io);
    expect(placed).toEqual({ kind: 'owner-no-tty' });
    // Launching is the owner at a terminal. This placement is refused there, and the full view
    // is still not its to read.
    expect(mayLaunchSeats(placed)).toBe(false);
    expect(viewFor(io, root)).toEqual({ full: false, mine: root });

    // And the command it runs reads the restricted view: no name, no root, no seat of another
    // team, while the owner at a terminal reads the same machine with every name on.
    const theirProject = 'zeta-4WX';
    const theirRoot = join(base, theirProject);
    mkdirSync(join(theirRoot, '.agents'), { recursive: true });
    const theirText = teamTextFor(theirProject, ['zeta-only-3HMV'], '');
    writeFileSync(join(theirRoot, '.agents', 'team.yaml'), theirText);
    approve(theirText, { root: theirRoot, name: theirProject });

    const code = await runUsage(['--json'], io, { home, now: () => NOW });
    expect(code).toBe(0);
    expect(io.out).not.toContain(theirProject);
    expect(io.out).not.toContain(theirRoot);
    expect((JSON.parse(io.out) as { view: string }).view).toBe('restricted');

    const ownerText = await usageAt(root, OWNER);
    expect(ownerText.out).toContain(theirProject);
  });

  test('the droppable entries, 1 of 5: the machine’s team count is carried, and counts a member it cannot read', async () => {
    // One allow-list entry per test, as the brief lists them. The team count is the machine's
    // own — every store read as one team, the caller's project included — so a store whose record
    // cannot be read still counts: the machine holds it, and the fixed sentence says why it
    // contributes nothing.
    const theirProject = 'zeta-4WX';
    const theirRoot = join(base, theirProject);
    mkdirSync(join(theirRoot, '.agents'), { recursive: true });
    const theirText = teamTextFor(theirProject, [], '');
    writeFileSync(join(theirRoot, '.agents', 'team.yaml'), theirText);
    approve(theirText, { root: theirRoot, name: theirProject });
    writeFileSync(join(storePath(theirProject, theirRoot, home), 'approval.json'), `${JSON.stringify({ format: 3 }, null, 2)}\n`);
    withState();

    // Two members: this project, and the store of theirs whose record does not read. The seat
    // reads the count and the fixed sentence, never the store's name or path.
    const mine = await usageAt(root, SEAT);
    const raw = (await usageAt(root, SEAT, '--json')).out;
    expect(mine.out.split('\n').find((line) => line.startsWith('usage on this machine'))).toBe('usage on this machine, 2 teams, 2 labs, 2 accounts');
    expect(mine.out).toContain('note: a store on this machine cannot be read: the owner reads the reason\n');
    for (const face of [mine.out, raw]) {
      expect(face).not.toContain(theirProject);
      expect(face).not.toContain(theirRoot);
    }
    // The owner reads the store's own message, its path written under `~` and not absolute.
    const owner = await usageAt(root, OWNER);
    const storeMessage = join(storePath(theirProject, theirRoot, home), 'approval.json');
    expect(owner.out).toContain(storeMessage.replace(home, '~'));
    expect(owner.out).not.toContain(storeMessage);
  });

  test('the droppable entries, 2 of 5: a machine line says whose reading it carries, never whose name', async () => {
    // The second entry: whether the figure on a machine line is the caller's own or another
    // team's is carried (`other`, and `read by another team` in the text), because a figure of an
    // account the caller's own file names is the caller's business — its name is not, and the
    // pace of that reading is not either: the element is dropped on that line (§ 3.3).
    const theirProject = 'zeta-4WX';
    const theirRoot = join(base, theirProject);
    mkdirSync(join(theirRoot, '.agents'), { recursive: true });
    const theirText = teamTextFor(theirProject, [], '');
    writeFileSync(join(theirRoot, '.agents', 'team.yaml'), theirText);
    approve(theirText, { root: theirRoot, name: theirProject });
    updateState(join(theirRoot, '.agents'), (state) => {
      state.budgets = {
        'openai/weekly/scout': { account: 'openai', window: 'weekly', left: 88, used: 12, changedAt: '2026-10-04T08:59:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'scout', source: 'status_line', confirmed: true },
      } as never;
    });
    withoutReadings();

    const mine = await usageAt(root, SEAT);
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const line = mine.out.split('\n').find((text) => /^openai\s+weekly/.test(text));
    expect(line).toBe('openai     weekly  88%   12%   in 44m  read by another team, 1m ago  status line  ok    (no watch is recording for it)');
    const entries = (JSON.parse(raw) as { labs: { accounts: { account: string; machine: Record<string, unknown> }[] }[] }).labs.flatMap((lab) => lab.accounts);
    const openai = entries.find((entry) => entry.account === 'openai');
    expect(openai?.machine.other).toBe(true);
    expect(openai?.machine.pace).toBeNull();
    expect(openai?.machine.team).toBeUndefined();
    expect(openai?.machine.seat).toBeUndefined();
    for (const face of [mine.out, raw]) expect(face).not.toContain(theirProject);

    // The owner reads the same figure with the team's name on it, and the team's own row under it.
    const owner = await usageAt(root, OWNER);
    expect(owner.out).toContain('read by zeta-4WX, 1m ago');
  });

  test('the droppable entries, 3 of 5: the watch clause rides the line it belongs to, in both views', async () => {
    // The third entry: whose watch is not recording is the line's business, and it prints only
    // where a figure is — a team with nothing counted has no line to carry it.
    withState({ pid: 1, heartbeat: '2026-10-04T08:55:00Z' });
    const stale = await usageAt(root, SEAT, '--tree');
    expect(stale.out).toBe(`${REPORT}\n`);
    expect(stale.out.split('\n').filter((line) => line.includes('watch')).length).toBe(3);
    const recording = await usageAt(root, OWNER, '--tree');
    expect(recording.out).toBe(`${REPORT}\n`);

    // With no readings at all there is no line, and so no clause: the report has nothing to say
    // about a watch for a team it shows no figure of.
    withoutReadings();
    const bare = await usageAt(root, SEAT);
    expect(bare.out).not.toContain('watch');
  });

  test('the droppable entries, 4 of 5: other teams’ notes are counted, never named, and the count is one line', async () => {
    // The fourth entry: the anonymized sentences carry the count of the teams behind them, one
    // line per distinct reason, and nothing else of those teams.
    for (const brokenProject of ['omega-9PL', 'kappa-2VN']) {
      const brokenRoot = join(base, brokenProject);
      mkdirSync(join(brokenRoot, '.agents'), { recursive: true });
      const brokenText = teamTextFor(brokenProject, [], '');
      writeFileSync(join(brokenRoot, '.agents', 'team.yaml'), brokenText);
      approve(brokenText, { root: brokenRoot, name: brokenProject });
      writeFileSync(join(brokenRoot, '.agents', 'team.state.json'), 'not json');
    }
    withState();
    const mine = await usageAt(root, SEAT);
    const raw = (await usageAt(root, SEAT, '--json')).out;
    const doc = JSON.parse(raw) as { notes: { scope: string; why: string; count?: number }[] };
    expect(mine.out).toContain("note: 2 teams' states cannot be read (not valid JSON; move it aside and run the command again)\n");
    expect(doc.notes).toEqual([
      { scope: 'another', why: 'its state cannot be read (not valid JSON; move it aside and run the command again)', count: 2 },
    ]);
    for (const face of [mine.out, raw]) {
      expect(face).not.toContain('omega-9PL');
      expect(face).not.toContain('kappa-2VN');
    }

    // One team with that reason is the singular sentence, with no count in the document beyond
    // the sentence's own `1`; the owner reads the same counted sentence, because another team's
    // problem is one summary line in both views, never one note per team.
    rmSync(join(base, 'kappa-2VN'), { recursive: true, force: true });
    const one = await usageAt(root, SEAT);
    expect(one.out).toContain("note: 1 team's state cannot be read (not valid JSON; move it aside and run the command again)\n");
    const owner = await usageAt(root, OWNER);
    expect(owner.out).toContain("note: 1 team's state cannot be read (not valid JSON; move it aside and run the command again)\n");
    // The note lines never name the team; the full view may name its seats elsewhere.
    expect(owner.out).not.toContain('note: omega-9PL');
    expect(owner.out).not.toContain('note: kappa-2VN');
  });

  test('the droppable entries, 5 of 5: an age is as fine as the report always printed it', async () => {
    // The fifth entry: how fine an age is. The report carries the same age words it always did —
    // minutes under the hour, hours and minutes beyond — and the same span the owner reads, so
    // restricting a view never coarsens a figure either view prints.
    withState();
    const mine = await usageAt(root, SEAT);
    expect(mine.out).toContain('read 2m ago');
    expect(mine.out).toContain('last seen 40m ago');
    expect(mine.out).toContain('changed 2m ago');
    // A reading 90 minutes old reads in hours and minutes, in both views, in the two shapes an
    // old reading still prints in: inside its reserve with a known reset (kept as the fallback,
    // refusing until the reset), and past the reserve again with no reset, as the room last
    // seen. Both lines below are a recorded run of this branch, quoted as they printed.
    updateState(join(root, '.agents'), (state) => {
      state.budgets = {
        'openai/weekly/lead': { account: 'openai', window: 'weekly', left: 5, used: 95, changedAt: '2026-10-04T07:30:00Z', resetsAt: '2026-10-04T09:44:00Z', seat: 'lead', source: 'status_line', confirmed: true },
        'openai/daily/lead': { account: 'openai', window: 'daily', left: 70, used: 30, changedAt: '2026-10-04T07:30:00Z', resetsAt: null, seat: 'lead', source: 'status_line', confirmed: true },
      } as never;
    });
    const older = await usageAt(root, SEAT);
    const owner = await usageAt(root, OWNER);
    for (const face of [older.out, owner.out]) {
      expect(face).toContain('changed 1h30m ago  status line (fallback)  refusing, inside reserve 20%');
      expect(face).toContain('last seen 1h30m ago  status line (fallback)  stale');
    }
  });

  test('a spend account reads from the state\'s spend readings: money on the line, the reading in the allow-list', async () => {
    // The spend line is read from the state's own spend readings (§ 5), the newest across teams;
    // this caller is its own team, so the line says `read`, not `read by another team`. The
    // allow-list entry is the reading the line renders from — `amount`, `currency`, `at` and the
    // `age` computed against the report's `at` — never a state's own words. A spend account has
    // no window, so the line carries no window word either.
    const text = teamText().replace(
      '  accounts:\n',
      '  accounts:\n    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: acme-quota }\n',
    );
    writeFileSync(file, text);
    approve(text);
    updateState(join(root, '.agents'), (state) => {
      state.spend = { deepseek: { account: 'deepseek', amount: 12.4, currency: 'USD', at: '2026-10-04T08:56:00Z' } } as never;
    });
    const mine = await usageAt(root, SEAT);
    expect(mine.out).toContain('deepseek   spend   12.40 USD  -     -       read 4m ago  check   fresh\n');
    expect(mine.out).toContain('  acme  spend  12.40 USD left  read 4m ago  check  fresh\n');
    // The pace word never rides a spend line (§ 3.4): money has no window and no stored point, so
    // both of the account's lines are whole — the two `contains` above would fail on any word.
    const spendLines = mine.out.split('\n').filter((line) => line.includes(' spend '));
    expect(spendLines).toHaveLength(2);
    for (const line of spendLines) expect(line).not.toContain('pace');
    const doc = JSON.parse((await usageAt(root, SEAT, '--json')).out) as {
      labs: { lab: string; accounts: Record<string, unknown>[] }[];
    };
    expect(doc.labs.find((one) => one.lab === 'deepseek')?.accounts).toEqual([
      {
        account: 'deepseek',
        kind: 'spend',
        machine: {
          amount: 12.4,
          currency: 'USD',
          at: '2026-10-04T08:56:00.000Z',
          age: '4m',
          source: 'check',
          state: 'fresh',
          other: false,
        },
        teams: [
          {
            team: 'acme',
            reading: {
              amount: 12.4,
              currency: 'USD',
              at: '2026-10-04T08:56:00.000Z',
              age: '4m',
              source: 'check',
              state: 'fresh',
            },
          },
        ],
      },
    ]);
    // The full view adds the team to the line's own fields and the row's; the entry above, with
    // no `team` on its machine, is the restricted one — the same entry, one field apart.
    const owner = JSON.parse((await usageAt(root, OWNER, '--json')).out) as typeof doc;
    const line = owner.labs.find((one) => one.lab === 'deepseek')?.accounts[0] as { machine: { team?: string } };
    expect(line.machine.team).toBe('acme');
  });

  test('it writes nothing: every file under the state, the store and the key is byte-identical', async () => {
    withState();
    const watched = [join(root, '.agents'), join(home, '.config', 'team'), join(home, '.config', 'team-key')];

    // Each face of the command, allowed or refused, with the folders compared around it: the
    // report, its JSON, a seat's run, the owner's run, a run outside any project, a refused
    // invocation, a refused stores folder, a file that does not load, and a state that does not
    // read.
    await untouched(watched, () => usageAt(root));
    await untouched(watched, () => usageAt(root, undefined, '--json'));
    await untouched(watched, () => usageAt(root, SEAT));
    await untouched(watched, () => usageAt(root, OWNER));
    await untouched(watched, async () => {
      const elsewhere = join(base, 'elsewhere');
      mkdirSync(elsewhere);
      await usageAt(elsewhere);
    });
    await untouched(watched, () => runUsage(['--nope'], testIo(root), { home, now: () => NOW }));
    await untouched(watched, () => runUsage([], testIo(root), { home: join(base, 'no-home'), now: () => NOW }));
    writeFileSync(join(root, '.agents', 'team.state.json'), 'not json');
    await untouched(watched, () => usageAt(root));
    writeFileSync(file, 'format: 1\nproject: acme\n');
    await untouched(watched, () => usageAt(root));
  });

  test('a borrowed account’s row names the entity it comes from, in both views and both faces', async () => {
    withState();
    writeFileSync(machineAccountsPath(home), 'accounts:\n  globex: [anthropic]\n');
    // The team names no entity of its own, so the account its seat pays with — `anthropic` — is
    // `globex`'s. The row that counts it says so, in the parenthesised tail the pool suffix and
    // the watch clause already sit in, so the account keeps its one line; every other row of the
    // report is byte for byte what it was.
    const mine = await usageAt(root, OWNER);
    expect(mine.out).toContain('anthropic  -        -     -     -        -                   -                        -                       unknown\n');
    expect(mine.out).toContain('  anthropic  acme  unknown  pace not known  (borrowed from globex)\n');
    expect(mine.out).toContain('  openai  acme  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh  pace not known\n');
    // One fact, one place: the restricted reader reads the same clause, and the document carries
    // it as its own key — absent, never null, for an account no entity claims.
    expect((await usageAt(root, SEAT)).out).toContain('  anthropic  acme  unknown  pace not known  (borrowed from globex)');
    const doc = JSON.parse((await usageAt(root, SEAT, '--json')).out) as {
      labs: { accounts: { account: string; teams: { borrowedFrom?: string }[] }[] }[];
    };
    const accounts = doc.labs.flatMap((lab) => lab.accounts);
    const entry = accounts.find((one) => one.account === 'anthropic');
    expect(entry?.teams.map((row) => row.borrowedFrom)).toEqual(['globex']);
    const openai = accounts.find((one) => one.account === 'openai');
    expect(openai?.teams.every((row) => !('borrowedFrom' in row))).toBe(true);
  });

  test('a team spending its own entity’s account borrows nothing, and --all marks each team on its own row', async () => {
    const otherRoot = join(base, 'solar');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    // The second team names the entity the account belongs to, declares the account in its own
    // file and pins its lobby the way such a file does, so the same account is its own there.
    const solar = teamTextFor('solar', ['anthropic'], '')
      .replace(root, otherRoot)
      .replace('workspace:', 'entity: globex\nlobby: ~/.config/team/lobby\nworkspace:');
    writeFileSync(join(otherRoot, '.agents', 'team.yaml'), solar);
    approve(solar, { root: otherRoot });
    writeFileSync(machineAccountsPath(home), 'accounts:\n  globex: [anthropic]\n');
    withState();

    const all = await usageAt(root, OWNER, '--all');
    const borrowed = teamRowsOf(all.out, 'acme').filter((row) => row.includes('(borrowed from globex)'));
    expect(borrowed).toHaveLength(1);
    expect(borrowed[0]).toStartWith('  anthropic  acme');
    // The team the entity is its own reads the same row without the clause.
    const own = teamRowsOf(all.out, 'solar').find((row) => row.startsWith('  anthropic  solar'));
    expect(own).not.toBeUndefined();
    expect(own ?? '').not.toContain('borrowed');
  });

  test('with no entity key the machine list reads as one unnamed entity and the report is byte for byte what it was', async () => {
    withState();
    writeFileSync(machineAccountsPath(home), 'accounts:\n  - anthropic\n');
    const mine = await usageAt(root, OWNER, '--tree');
    expect(mine.out).toBe(`${REPORT}\n`);
  });

  test('a window far ahead of its clock reads near cap in the DEFAULT table, and the advice prints without --tree', async () => {
    // The live case: google (claude-gpt) at weekly 89% with a -68.6% margin
    // read only `fresh` in STATE, and the advice line sat behind `--tree`. The state is the
    // quota's, printed in the default table, and the advice stands beside it.
    withoutReadings();
    withState();
    const io = testIo(root, SEAT);
    const code = await runUsage([], io, {
      home,
      now: () => NOW,
      observe: () => ({
        observations: [{
          account: 'openai', window: 'session', left: 40, used: 60, resetsAt: null, resetText: null,
          observedAt: NOW.getTime() - 60_000, source: 'status line' as const, seat: 'lead', margin: -68.6, wall: false,
        }],
        costs: [],
        notes: [],
      }),
    });
    expect(code).toBe(0);
    const line = io.out.split('\n').find((text) => /^openai\s+session/.test(text)) ?? '';
    expect(line).toContain('near cap  margin -68.6%');
    expect(line).not.toContain('fresh');
    expect(io.out).toContain('advice: near cap on openai (session used 60%, margin -68.6%)');
    expect(io.out).not.toContain('\nquota\n');
  });

  test('a spend a seat’s own row printed is measured for that seat and its run, and never for another run', async () => {
    // The live case the owner asked for: the seat's row prints `S: $5.8`, and the report records
    // it per seat and per run — measured, with the screen it came from — while a seat the screen
    // did not answer for stays `unknown`, never a zero.
    withoutReadings();
    withState();
    const cost = (session: string | null) => ({
      seat: 'lead',
      account: 'anthropic',
      session,
      amount: 5.8,
      currency: 'USD' as const,
      observedAt: NOW.getTime(),
      source: 'status line' as const,
    });
    const io = testIo(root, SEAT);
    const code = await runUsage(['--tree'], io, { home, now: () => NOW, observe: () => ({ observations: [], costs: [cost('acme-web')], notes: [] }) });
    expect(code).toBe(0);
    expect(io.out).toContain('  lead  claude-code  anthropic  cost  $5.8  measured  status line  read 0m ago');
    const json = testIo(root, SEAT);
    expect(await runUsage(['--json'], json, { home, now: () => NOW, observe: () => ({ observations: [], costs: [cost('acme-web')], notes: [] }) })).toBe(0);
    const doc = JSON.parse(json.out) as { teams: { seats: { cost: Record<string, unknown> }[] }[] };
    expect(doc.teams[0]?.seats[0]?.cost).toEqual({
      amount: 5.8,
      currency: 'USD',
      // The session registry's own word carries the mark (`SessionRecord['cost']['source']`),
      // and the surface the figure was read from is `readFrom`, so the two commands agree.
      source: 'measured',
      readFrom: 'status line',
      readAt: new Date(NOW.getTime()).toISOString(),
      age: '0m',
    });
    // The figure is per run: the same name in another run's pane is another seat's spend, and
    // this run reads unknown rather than borrowing it.
    const stray = testIo(root, SEAT);
    expect(await runUsage(['--json'], stray, { home, now: () => NOW, observe: () => ({ observations: [], costs: [cost('other-web')], notes: [] }) })).toBe(0);
    const other = JSON.parse(stray.out) as { teams: { seats: { cost: { amount: number | null; currency: string; source: string; why?: string } }[] }[] };
    expect(other.teams[0]?.seats[0]?.cost).toEqual({
      amount: null,
      currency: 'USD',
      source: 'unknown',
      why: "no money cost was read from this seat's screen this run",
    });
  });

  test('a lab its seats draw on and no screen reads is one line with its seat count, never an `unknown` row', async () => {
    const builders = Array.from({ length: 11 }, (_, at) => `  - role: member
    name: builder-${at + 1}
    label: builder-${at + 1}
    cli: claude-code
    vendor: deepseek
    model: DeepSeek V4.1 Flash
    version: "4.1"
    launch: claude --model deepseek-v4-1-flash
`).join('');
    const glm = `  - role: member
    name: zhander
    label: zhander
    cli: claude-code
    vendor: zai
    model: GLM
    version: "5.3"
    launch: claude-glm.sh
`;
    const text = `${teamText()}${builders}${glm}`;
    writeFileSync(file, text);
    approve(text);
    withoutReadings();
    const out = await usageAt(root, OWNER);
    expect(out.out).toContain('deepseek  not readable from a screen  (11 seats)\n');
    expect(out.out).toContain('zai  not readable from a screen  (1 seat)\n');
    // The seat count replaces the account row: no `deepseek  -  …  unknown` line reads as a
    // figure not yet seen.
    const rows = out.out.split('\n').filter((line) => /^(deepseek|zai)\s+-\s/.test(line));
    expect(rows).toEqual([]);
  });

  test('a named team whose file cannot be read reads as one sentence in every view: its name and its ~ root', async () => {
    // The sentence: `the team "team" (~/Code/floor/team): its file could
    // not be read.` The store's folder is the record of the name; the root prints under the
    // home it lives in, never as an absolute path. A `~/…` root prints in every view — the
    // owner's and the restricted view alike — so a seat sees the same sentence the owner does.
    const otherRoot = join(home, 'Code', 'floor', 'team');
    mkdirSync(join(otherRoot, '.agents'), { recursive: true });
    const other = teamText().replace('project: acme', 'project: team').replace('session: acme-web', 'session: team-web').replace(root, otherRoot);
    writeFileSync(join(otherRoot, '.agents', 'team.yaml'), other);
    approve(other, { root: otherRoot });
    writeFileSync(join(otherRoot, '.agents', 'team.yaml'), 'format: 1\nproject: team\ntrust: [\n');
    const out = await usageAt(root, OWNER);
    expect(out.code).toBe(0);
    expect(out.out).toContain('note: the team "team" (~/Code/floor/team): its file could not be read.\n');
    // The restricted view reads the same sentence, root and all — the store's own folder is the
    // record the note is built from, and the team is named by the file that cannot be read.
    const seat = await usageAt(root, SEAT);
    expect(seat.out).toContain('note: the team "team" (~/Code/floor/team): its file could not be read.\n');
  });

  test('the RESERVE column prints only when a row has something in it, headers and cells together', async () => {
    withoutReadings();
    const bare = await usageAt(root, OWNER);
    expect(bare.out.split('\n')[0]).not.toContain('RESERVE');
    withState();
    const full = await usageAt(root, OWNER);
    expect(full.out.split('\n')[0]).toContain('RESERVE');
    expect(full.out).toContain('inside reserve 20%');
  });
});
