// The capture coverage matrix: for each CLI and screen kind, how many conformance fixtures are
// real captures, how many are constructed, and how many have no provenance stated. Provenance is
// stated as data — a `provenance` field on each manifest entry — and nothing is real by default:
// a `capture` claim counts only when the folder's README names the file in a bullet of a section
// whose heading is not Constructed or Not produced, and a file a Constructed heading lists can
// never be claimed as one. README prose decides nothing — no sentence parsing, no marker words —
// because the matrix decides which real captures get taken, and wording has three times made a
// constructed fixture count as real. A README's "Not produced" section names kinds no capture
// exists for, with the reason.
//
//   bun run coverage           prints the matrix
//   bun run coverage --json    writes contract/capture-coverage.json
//   bun run coverage --check   regenerates that file and fails on any difference, and fails
//                              while any provenance problem exists
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'fixtures');
const outputFile = join(root, 'contract', 'capture-coverage.json');

type ScreenCase = { file: string; cli: string; classify: string; provenance?: string };
type Manifest = { screens: ScreenCase[] };

/** The kinds a screen is read as; the matrix's second axis. */
const KINDS = ['idle', 'working', 'unsent', 'permission', 'question', 'exit question', 'trust', 'vendor notice', 'provider error', 'rate limit', 'unknown'] as const;
type Kind = (typeof KINDS)[number];

export type Provenance = 'capture' | 'constructed' | 'undocumented';
export type Cell = { real: number; constructed: number; undocumented: number };
export type Matrix = {
  clis: string[];
  cells: Record<string, Record<Kind, Cell>>;
  notProduced: Record<string, Record<string, string>>;
  fixtures: { file: string; cli: string; kind: Kind; provenance: Provenance }[];
  problems: string[];
};

/** The `.txt` file names a piece of README text mentions, backticked or bare. */
function namesOf(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/[A-Za-z0-9_.-]+\.txt/g)) {
    const name = match[0] ?? '';
    if (name !== '') names.push(name);
  }
  return names;
}

type SectionKind = 'default' | 'constructed' | 'notProduced';

/** What one README says: the files its captured sections list, the files its Constructed sections
 *  list, and the kinds it says were not produced. Headings alone type a section; names are read
 *  from bullets alone, so prose never decides anything. */
function readOf(readme: string): {
  captured: Map<string, string>;
  constructed: Map<string, string>;
  notProduced: Map<Kind, string>;
} {
  const captured = new Map<string, string>();
  const constructed = new Map<string, string>();
  const notProduced = new Map<Kind, string>();
  let kind: SectionKind = 'default';
  let heading = '';
  let bullet = false;
  let block: string[] = [];
  const flush = () => {
    if (block.length === 0) return;
    const text = block.join(' ');
    if (bullet && kind === 'default') {
      for (const name of namesOf(text)) if (!captured.has(name)) captured.set(name, heading);
    } else if (bullet && kind === 'constructed') {
      // The bullet's subject is the names before its first colon, or the first name when there
      // is none: names after the colon are what the file was built from, not the file.
      const colon = text.indexOf(':');
      const names = colon === -1 ? namesOf(text).slice(0, 1) : namesOf(text.slice(0, colon));
      for (const name of names) if (!constructed.has(name)) constructed.set(name, heading);
    }
    if (kind === 'notProduced' && /not produced/i.test(text)) {
      // A Not-produced bullet names the kind it is about (backticked or bare, before the
      // colon) and says why; the reason is the first clause after "not produced".
      const colon = text.indexOf(':');
      const lead = colon === -1 ? text : text.slice(0, colon);
      const plain = lead.replace(/`[^`]+`/g, ' ');
      const kinds = KINDS.filter((one) => lead.includes(`\`${one}\``) || new RegExp(`\\b${one}\\b`).test(plain));
      const tail = colon === -1 ? '' : text.slice(colon + 1).trim();
      const stripped = tail.replace(/^not produced\s*[:,—-]?\s*/i, '');
      const cut = /[,;.—]/.exec(stripped);
      const reason = (cut ? stripped.slice(0, cut.index) : stripped).trim() || 'reason not stated';
      for (const one of kinds) notProduced.set(one, reason);
    }
    block = [];
  };
  for (const line of readme.split('\n')) {
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      flush();
      bullet = false;
      heading = line;
      const title = headingMatch[1] ?? '';
      kind = /constructed/i.test(title) ? 'constructed' : /not produced/i.test(title) ? 'notProduced' : 'default';
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      flush();
      bullet = true;
      block = [line];
      continue;
    }
    if (line.trim() === '') {
      flush();
      bullet = false;
      continue;
    }
    block.push(line);
  }
  flush();
  return { captured, constructed, notProduced };
}

/** The deepest README governing a fixture: its own folder's, or the CLI's above it. */
function readmeOf(file: string, fixturesDir: string): string {
  const parts = file.split('/');
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const candidate = join(fixturesDir, ...parts.slice(0, depth), 'README.md');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${file}: no README in its folder, so its provenance cannot be read`);
}

const cache = new Map<string, ReturnType<typeof readOf>>();
/** What the README governing this fixture says. */
function readFor(file: string, fixturesDir: string): ReturnType<typeof readOf> {
  const readme = readmeOf(file, fixturesDir);
  let read = cache.get(readme);
  if (!read) {
    read = readOf(readFileSync(readme, 'utf8'));
    cache.set(readme, read);
  }
  return read;
}

/** The whole matrix, from the manifest's stated provenance and the READMEs' headings. */
export function coverageOf(fixturesDir: string = fixtures): Matrix {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'conformance.json'), 'utf8')) as Manifest;
  const clis = [...new Set(manifest.screens.map((screen) => screen.cli))].sort();
  const cells: Record<string, Record<Kind, Cell>> = {};
  for (const cli of clis) {
    cells[cli] = Object.fromEntries(KINDS.map((kind) => [kind, { real: 0, constructed: 0, undocumented: 0 }])) as Record<Kind, Cell>;
  }
  const cellOf = (cli: string, kind: Kind): Cell => {
    const cell = cells[cli]?.[kind];
    if (cell === undefined) throw new Error(`${cli} ${kind}: no cell, which cannot happen here`);
    return cell;
  };
  // Why a kind was never captured, per CLI, from each governing README's Not-produced section.
  const reasons = new Map<string, Partial<Record<Kind, string>>>();
  const problems: string[] = [];
  const listed: { file: string; cli: string; kind: Kind; provenance: Provenance }[] = [];
  for (const screen of manifest.screens) {
    const kind = screen.classify as Kind;
    if (!KINDS.includes(kind)) throw new Error(`${screen.file}: classify says "${screen.classify}"`);
    const name = screen.file.split('/').at(-1) ?? '';
    const read = readFor(screen.file, fixturesDir);
    let provenance: Provenance;
    if (screen.provenance === 'constructed') provenance = 'constructed';
    else if (screen.provenance === 'capture') provenance = 'capture';
    else provenance = 'undocumented';
    if (read.captured.has(name) && read.constructed.has(name)) {
      problems.push(`${screen.file}: named under both ${read.captured.get(name)} and ${read.constructed.get(name)} in its folder's README; a file sits under one heading only`);
    } else if (screen.provenance === undefined) {
      problems.push(`${screen.file}: no provenance stated; add "provenance": "capture" or "constructed" to its entry in the conformance manifest`);
    } else if (screen.provenance !== 'capture' && screen.provenance !== 'constructed') {
      problems.push(`${screen.file}: provenance "${screen.provenance}" is neither "capture" nor "constructed"`);
      provenance = 'undocumented';
    } else if (screen.provenance === 'capture' && read.constructed.has(name)) {
      problems.push(`${screen.file}: stated "capture" in test/fixtures/conformance.json but listed under ${read.constructed.get(name)} in its folder's README`);
      provenance = 'undocumented';
    } else if (screen.provenance === 'capture' && !read.captured.has(name)) {
      problems.push(`${screen.file}: stated "capture" but no bullet under a captured heading in its folder's README names it`);
      provenance = 'undocumented';
    }
    cellOf(screen.cli, kind)[provenance === 'capture' ? 'real' : provenance]++;
    listed.push({ file: screen.file, cli: screen.cli, kind, provenance });
    const cliReasons = reasons.get(screen.cli) ?? {};
    for (const [notKind, reason] of read.notProduced) {
      if (cliReasons[notKind] === undefined) cliReasons[notKind] = reason;
    }
    reasons.set(screen.cli, cliReasons);
  }
  const notProduced: Record<string, Record<string, string>> = {};
  for (const cli of clis) {
    const source = reasons.get(cli) ?? {};
    const entry: Record<string, string> = {};
    for (const kind of KINDS) {
      const reason = source[kind];
      if (reason !== undefined) entry[kind] = reason;
    }
    notProduced[cli] = entry;
  }
  const byFile = (a: { file: string }, b: { file: string }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return { clis, cells, notProduced, fixtures: listed.sort(byFile), problems };
}

/** The checked-in document, byte for byte: sorted, no dates, no paths but the fixtures' own. */
export function documentOf(fixturesDir: string = fixtures): string {
  const { clis, cells, notProduced, fixtures } = coverageOf(fixturesDir);
  return `${JSON.stringify({ kind: 'capture-coverage', clis, kinds: KINDS, cells, notProduced, fixtures }, null, 2)}\n`;
}

/** The matrix a person reads. */
export function tableOf(fixturesDir: string = fixtures): string {
  const { clis, cells, notProduced } = coverageOf(fixturesDir);
  const cellOf = (cli: string, kind: Kind): Cell => {
    const cell = cells[cli]?.[kind];
    if (cell === undefined) throw new Error(`${cli} ${kind}: no cell, which cannot happen here`);
    return cell;
  };
  const reasonOf = (cli: string, kind: Kind): string | undefined => notProduced[cli]?.[kind];
  const head = ['cli', 'kind', 'real', 'constructed', 'undocumented'];
  const rows: string[][] = [];
  const empty: string[] = [];
  for (const cli of clis) {
    for (const kind of KINDS) {
      const cell = cellOf(cli, kind);
      rows.push([cli, kind, String(cell.real), String(cell.constructed), String(cell.undocumented)]);
      if (cell.real === 0) {
        const note = cell.constructed > 0
          ? ' (constructed only)'
          : reasonOf(cli, kind) !== undefined
            ? ` (not produced: ${reasonOf(cli, kind)})`
            : ' (no fixtures)';
        empty.push(`${cli} ${kind}${note}`);
      }
    }
  }
  const widths = head.map((_, column) => Math.max(head[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)));
  const line = (row: string[]) => row.map((cell, at) => (cell ?? '').padEnd(widths[at] ?? 0)).join('  ').trimEnd();
  return `${[line(head), ...rows.map(line), '', `cells with no real capture: ${empty.length === 0 ? 'none' : empty.join(', ')}`].join('\n')}\n`;
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode === '--json') {
    mkdirSync(join(root, 'contract'), { recursive: true });
    writeFileSync(outputFile, documentOf());
    console.log('wrote contract/capture-coverage.json');
  } else if (mode === '--check') {
    const { problems } = coverageOf();
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      console.error('coverage:check: the provenance above must be fixed');
      process.exitCode = 1;
    } else if (!existsSync(outputFile)) {
      console.error('contract/capture-coverage.json is missing; run `bun run coverage --json`');
      process.exitCode = 1;
    } else if (documentOf() !== readFileSync(outputFile, 'utf8')) {
      console.error('contract/capture-coverage.json is not current; run `bun run coverage --json`');
      process.exitCode = 1;
    } else {
      console.log('contract/capture-coverage.json is current');
    }
  } else if (mode === undefined) {
    const { problems } = coverageOf();
    process.stdout.write(tableOf());
    for (const problem of problems) process.stdout.write(`${problem}\n`);
  } else {
    console.error('Usage: bun scripts/coverage.ts [--json | --check]');
    process.exitCode = 2;
  }
}
