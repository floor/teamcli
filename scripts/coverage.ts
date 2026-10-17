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
//   bun run coverage --write   writes that file and the embedded captures module the package
//                              carries (src/profiles/trust-captures.ts)
//   bun run coverage --check   fails on any difference in either file, and while any provenance
//                              problem exists
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion, profileFor } from '../src/profiles/profile.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'fixtures');
const outputFile = join(root, 'contract', 'capture-coverage.json');
const capturesFile = join(root, 'src', 'profiles', 'trust-captures.ts');

type ScreenCase = { file: string; cli: string; classify: string; provenance?: string };
type Manifest = { screens: ScreenCase[] };

/** The kinds a screen is read as; the matrix's second axis. */
const KINDS = ['idle', 'working', 'unsent', 'permission', 'question', 'exit question', 'trust', 'vendor notice', 'provider error', 'rate limit', 'unknown'] as const;
export type Kind = (typeof KINDS)[number];

export type Provenance = 'capture' | 'constructed' | 'undocumented';
export type Cell = { real: number; constructed: number; undocumented: number };
/** What one version folder of one CLI holds, kind by kind, beside the range the profile claims. */
export type VersionEntry = {
  tested: { from: string; to: string } | null;
  byVersion: Record<string, Record<Kind, Cell>>;
};
export type Matrix = {
  clis: string[];
  cells: Record<string, Record<Kind, Cell>>;
  versions: Record<string, VersionEntry>;
  notProduced: Record<string, Record<string, string>>;
  fixtures: { file: string; cli: string; kind: Kind; provenance: Provenance }[];
  problems: string[];
};

/** The baseline set every version folder at or after `tested.to` owes: a real capture of each
 *  file, or a `## Not produced` bullet in that folder's README naming the kind. The exit screen
 *  is classified `unknown`, so a folder that never sees the shell back says `unknown`. */
const BASELINE: readonly [file: string, kind: Kind][] = [
  ['trust.txt', 'trust'],
  ['idle.txt', 'idle'],
  ['unsent.txt', 'unsent'],
  ['working.txt', 'working'],
  ['question.txt', 'question'],
  ['permission.txt', 'permission'],
  ['exit.txt', 'unknown'],
];

/** Versions compared as numbers, missing parts as zero. */
function orderOf(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

/** The tested range each shipped CLI's profile declares, for the CLIs the manifest lists. */
function shippedProfilesOf(fixturesDir: string): Record<string, { from: string; to: string }> {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'conformance.json'), 'utf8')) as Manifest;
  const out: Record<string, { from: string; to: string }> = {};
  for (const cli of new Set(manifest.screens.map((screen) => screen.cli))) {
    const tested = profileFor(cli)?.tested;
    if (tested !== undefined) out[cli] = tested;
  }
  return out;
}

/** The version folder a manifest file sits in (`<cli>/<version>/<name>.txt`), or null. */
function versionOf(file: string, cli: string): string | null {
  const parts = file.split('/');
  if (parts.length < 3 || parts[0] !== cli) return null;
  const version = parts[1] ?? '';
  return parseVersion(version) === null ? null : version;
}

/** A fresh kind-by-kind cell map. */
function emptyCells(): Record<Kind, Cell> {
  return Object.fromEntries(KINDS.map((kind) => [kind, { real: 0, constructed: 0, undocumented: 0 }])) as Record<Kind, Cell>;
}

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
 *  from bullets alone, so prose never decides anything. Exported so the refresh script can ask a
 *  folder's README which kinds it already accounts for. */
export function readOf(readme: string): {
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
    if (bullet && kind === 'notProduced' && /not produced/i.test(text)) {
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

/** The whole matrix, from the manifest's stated provenance and the READMEs' headings. The
 *  `profiles` argument is the claimed tested range per CLI; it defaults to the shipped profiles,
 *  and a caller testing a scratch fixtures tree passes its own map (or `{}`). */
export function coverageOf(
  fixturesDir: string = fixtures,
  profiles: Record<string, { from: string; to: string }> = shippedProfilesOf(fixturesDir),
): Matrix {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'conformance.json'), 'utf8')) as Manifest;
  const clis = [...new Set(manifest.screens.map((screen) => screen.cli))].sort();
  const cells: Record<string, Record<Kind, Cell>> = {};
  const versions: Record<string, VersionEntry> = {};
  for (const cli of clis) {
    cells[cli] = emptyCells();
    versions[cli] = { tested: profiles[cli] ?? null, byVersion: {} };
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
    const version = versionOf(screen.file, screen.cli);
    if (version !== null) {
      const byVersion = versions[screen.cli]?.byVersion;
      if (byVersion === undefined) throw new Error(`${screen.file}: no version entry for ${screen.cli}`);
      byVersion[version] ??= emptyCells();
      byVersion[version][kind][provenance === 'capture' ? 'real' : provenance]++;
    }
    listed.push({ file: screen.file, cli: screen.cli, kind, provenance });
    const cliReasons = reasons.get(screen.cli) ?? {};
    for (const [notKind, reason] of read.notProduced) {
      if (cliReasons[notKind] === undefined) cliReasons[notKind] = reason;
    }
    reasons.set(screen.cli, cliReasons);
  }
  // The per-version gates. The folder the profile claims as `tested.to` must exist and hold a
  // real capture, so a bumped range cannot pass on older folders' work. Every version folder at
  // or after `tested.to` owes the baseline set — a real capture of each file, or a Not-produced
  // bullet naming its kind in that folder's own README. Folders older than the range are
  // history: they stay, and they are not judged.
  const captured = new Set(listed.filter((one) => one.provenance === 'capture').map((one) => one.file));
  for (const [cli, tested] of Object.entries(profiles)) {
    // A profile with no manifest entries still owes its tested.to folder: the entry is made
    // here rather than skipped, so a newly shipped CLI cannot pass before its first capture.
    const entry = versions[cli] ?? { tested, byVersion: {} };
    const to = tested.to;
    const folder = `${cli}/${to}`;
    if (!existsSync(join(fixturesDir, cli, to, 'README.md'))) {
      problems.push(`${cli}: profile tested.to is ${to} but test/fixtures/${folder}/README.md is missing`);
    }
    const toCells = entry.byVersion[to];
    const toReal = toCells === undefined ? 0 : KINDS.reduce((sum, kind) => sum + toCells[kind].real, 0);
    if (toReal === 0) {
      problems.push(`${cli}: profile tested.to is ${to} but test/fixtures/${folder}/ has no captures`);
    }
    const toVersion = parseVersion(to);
    for (const version of Object.keys(entry.byVersion)) {
      const versionNumbers = parseVersion(version);
      if (toVersion === null || versionNumbers === null || orderOf(versionNumbers, toVersion) < 0) continue;
      const readmeFile = join(fixturesDir, cli, version, 'README.md');
      const read = existsSync(readmeFile)
        ? readOf(readFileSync(readmeFile, 'utf8'))
        : { notProduced: new Map<Kind, string>() };
      for (const [file, kind] of BASELINE) {
        if (captured.has(`${cli}/${version}/${file}`)) continue;
        if (read.notProduced.has(kind)) continue;
        problems.push(`${cli}/${version}: no real capture of ${file} (${kind}) and test/fixtures/${cli}/${version}/README.md does not list \`${kind}\` under ## Not produced`);
      }
    }
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
  return { clis, cells, versions, notProduced, fixtures: listed.sort(byFile), problems };
}

/** The checked-in document, byte for byte: sorted, no dates, no paths but the fixtures' own. */
export function documentOf(
  fixturesDir: string = fixtures,
  profiles?: Record<string, { from: string; to: string }>,
): string {
  const { clis, cells, versions, notProduced, fixtures } = coverageOf(fixturesDir, profiles);
  return `${JSON.stringify({ kind: 'capture-coverage', clis, kinds: KINDS, cells, versions, notProduced, fixtures }, null, 2)}\n`;
}

/** The registered captures the trust-answer path may act on, keyed `<cli> <file>` — the whole
 *  manifest path, never a basename. */
export function trustCaptureNames(fixturesDir: string = fixtures): string[] {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'conformance.json'), 'utf8')) as Manifest;
  return manifest.screens
    .filter((screen) => screen.provenance === 'capture' && Boolean(screen.cli) && Boolean(screen.file))
    .map((screen) => `${screen.cli} ${screen.file}`)
    .sort();
}

/**
 * The module the package carries: the same set, embedded at build time. The package ships dist/
 * only, so a runtime read of test/fixtures/conformance.json is not in an installed build; the
 * trust path reads this instead, and coverage:check keeps it current with the manifest.
 */
export function trustCapturesModule(fixturesDir: string = fixtures): string {
  const names = trustCaptureNames(fixturesDir).map((name) => `  ${JSON.stringify(name)},`);
  return `// Generated by scripts/coverage.ts --write from test/fixtures/conformance.json; do not edit.
// Run \`bun run coverage --write\` after the manifest changes.
//
// The registered captures the trust-answer path may act on, keyed "<cli> <file>" exactly as the
// trust records key them. They are embedded because the package ships dist/ only: a runtime read
// of the manifest under test/fixtures/ would fail in an installed build.
export const TRUST_CAPTURES: readonly string[] = [
${names.join('\n')}
];
`;
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
  } else if (mode === '--write') {
    mkdirSync(join(root, 'contract'), { recursive: true });
    writeFileSync(outputFile, documentOf());
    writeFileSync(capturesFile, trustCapturesModule());
    console.log('wrote contract/capture-coverage.json and src/profiles/trust-captures.ts');
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
    } else if (!existsSync(capturesFile)) {
      console.error('src/profiles/trust-captures.ts is missing; run `bun run coverage --write`');
      process.exitCode = 1;
    } else if (trustCapturesModule() !== readFileSync(capturesFile, 'utf8')) {
      console.error('src/profiles/trust-captures.ts is not current; run `bun run coverage --write`');
      process.exitCode = 1;
    } else {
      console.log('contract/capture-coverage.json and src/profiles/trust-captures.ts are current');
    }
  } else if (mode === undefined) {
    const { problems } = coverageOf();
    process.stdout.write(tableOf());
    for (const problem of problems) process.stdout.write(`${problem}\n`);
  } else {
    console.error('Usage: bun scripts/coverage.ts [--json | --write | --check]');
    process.exitCode = 2;
  }
}
