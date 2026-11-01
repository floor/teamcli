// Checks an implementation of the screen reading and the YAML subset against the shared fixtures.
// The implementation is a command that reads one JSON request per line on stdin and writes one
// JSON answer per line. `bun run conformance` runs this against the TypeScript adapter.
//
//   bun scripts/conformance.ts --impl "node dist/cli.js conformance-adapter"
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'test', 'fixtures');

type ScreenCase = { file: string; cli: string; classify: string; composer: string };
type YamlCase = { file: string; ok: boolean };
type Manifest = { screens: ScreenCase[]; yaml: YamlCase[] };

type Row = { pass: boolean; part: string; file: string; detail: string };

function usage(): string {
  return 'Usage: bun scripts/conformance.ts --impl "<command>"\n';
}

function splitCommand(text: string): { cmd: string; args: string[] } | null {
  const parts = text.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!parts || parts.length === 0) return null;
  const argv = parts.map((part) => part.replace(/^['"]|['"]$/g, ''));
  const [cmd, ...args] = argv;
  if (!cmd) return null;
  return { cmd, args };
}

function ask(impl: string, input: string): Promise<{ code: number | null; out: string; err: string }> {
  const command = splitCommand(impl);
  if (!command) return Promise.resolve({ code: 127, out: '', err: 'conformance: --impl needs a command\n' });
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, { cwd: root });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { out += text; });
    child.stderr.on('data', (text) => { err += text; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => resolve({ code: 127, out, err: err + error.message }));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

function answersOf(out: string): unknown[] {
  const lines = out.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  });
}

function kindOf(answer: unknown): string | null {
  if (answer === null || typeof answer !== 'object' || !('kind' in answer)) return null;
  const kind = (answer as { kind: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}

function okOf(answer: unknown): boolean | null {
  if (answer === null || typeof answer !== 'object' || !('ok' in answer)) return null;
  const ok = (answer as { ok: unknown }).ok;
  return typeof ok === 'boolean' ? ok : null;
}

function nonAscii(text: string): boolean {
  return [...text].some((char) => (char.codePointAt(0) ?? 0) > 127);
}

// Folders under test/fixtures that are not conformance input. Every other top-level folder is a
// CLI folder whose `.txt` files, at any depth, are screen captures the manifest must list; `yaml`
// holds the YAML cases the same way. An unlisted folder is not exempt: its `.txt` files are named.
const EXEMPT = new Map<string, string>([
  ['banner', "constructed wrapper banner screens the banner scenes read, not a shipped CLI's screen"],
  ['hatch', "a fake CLI used only by the hatch tests, not a shipped CLI's screen"],
  ['herdr', 'JSON shapes herdr itself prints, read by the herdr tests'],
  ['linux', 'a fake /proc tree for the load and memory readers'],
  ['release', 'recorded npm and GitHub responses the release-check tests replay'],
]);

type Problem = { file: string; detail: string };

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of filesUnder(join(dir, entry.name))) found.push(`${entry.name}/${child}`);
    } else if (entry.isFile()) {
      found.push(entry.name);
    }
  }
  return found;
}

/** Names every fixture on disk the manifest does not list, and every manifest entry with no file. */
function fixtureProblems(fixturesDir: string, manifest: Manifest): Problem[] {
  const listed = new Set([...manifest.screens.map((one) => one.file), ...manifest.yaml.map((one) => one.file)]);
  const problems: Problem[] = [];
  for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || EXEMPT.has(entry.name)) continue;
    const suffix = entry.name === 'yaml' ? '.yaml' : '.txt';
    for (const child of filesUnder(join(fixturesDir, entry.name))) {
      const file = `${entry.name}/${child}`;
      if (file.endsWith(suffix) && !listed.has(file)) problems.push({ file, detail: 'not in the conformance manifest' });
    }
  }
  for (const file of listed) {
    if (!existsSync(join(fixturesDir, file))) problems.push({ file, detail: 'in the conformance manifest but not on disk' });
  }
  return problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function reportOf(rows: Row[]): { code: number; report: string } {
  const failed = rows.filter((row) => !row.pass).length;
  const report = [
    ...rows.map((row) => `${row.pass ? 'pass' : 'fail'}  ${row.part}  ${row.file}  ${row.detail}`),
    `conformance: ${rows.length - failed} pass, ${failed} fail`,
  ].join('\n');
  return { code: failed === 0 ? 0 : 1, report };
}

export async function run(impl: string, fixturesDir: string = fixtures): Promise<{ code: number; report: string }> {
  const manifest = JSON.parse(readFileSync(join(fixturesDir, 'conformance.json'), 'utf8')) as Manifest;
  const problems = fixtureProblems(fixturesDir, manifest);
  if (problems.length > 0) {
    return reportOf(problems.map((problem) => ({ pass: false, part: 'manifest', ...problem })));
  }
  const requests: string[] = [];
  for (const screen of manifest.screens) {
    const lines = readFileSync(join(fixturesDir, screen.file), 'utf8').split('\n');
    requests.push(JSON.stringify({ op: 'classify', cli: screen.cli, lines }));
    requests.push(JSON.stringify({ op: 'composer', cli: screen.cli, lines }));
  }
  const screenRequests = requests.length;
  for (const yaml of manifest.yaml) {
    requests.push(JSON.stringify({ op: 'yaml', text: readFileSync(join(fixturesDir, yaml.file), 'utf8') }));
  }
  const replied = await ask(impl, `${requests.join('\n')}\n`);
  const got = answersOf(replied.out);
  const rows: Row[] = [];
  if (replied.code !== 0 || got.length !== requests.length) {
    const why = replied.code !== 0 ? `the command exited ${replied.code ?? 'without a code'}` : `expected ${requests.length} answers, got ${got.length}`;
    rows.push({ pass: false, part: 'impl', file: impl, detail: why });
  } else {
    let at = 0;
    for (const screen of manifest.screens) {
      const classified = kindOf(got[at]);
      const composed = kindOf(got[at + 1]);
      at += 2;
      rows.push({
        pass: classified === screen.classify,
        part: 'classify',
        file: screen.file,
        detail: classified === screen.classify ? screen.classify : `expected ${screen.classify}, got ${classified ?? 'no kind'}`,
      });
      rows.push({
        pass: composed === screen.composer,
        part: 'composer',
        file: screen.file,
        detail: composed === screen.composer ? screen.composer : `expected ${screen.composer}, got ${composed ?? 'no kind'}`,
      });
      const text = readFileSync(join(fixturesDir, screen.file), 'utf8');
      if (nonAscii(text)) {
        const pass = classified === screen.classify && composed === screen.composer;
        rows.push({
          pass,
          part: 'non-ASCII',
          file: screen.file,
          detail: pass ? `classify ${screen.classify}, composer ${screen.composer}` : 'the non-ASCII text was not read as the fixture says',
        });
      }
    }
    for (const yaml of manifest.yaml) {
      const ok = okOf(got[at]);
      at += 1;
      const expected = yaml.ok ? 'accepted' : 'refused';
      const actual = ok === null ? 'no answer' : ok ? 'accepted' : 'refused';
      rows.push({
        pass: ok === yaml.ok,
        part: 'yaml',
        file: yaml.file,
        detail: ok === yaml.ok ? expected : `expected ${expected}, got ${actual}`,
      });
    }
    if (at !== screenRequests + manifest.yaml.length) {
      rows.push({ pass: false, part: 'impl', file: impl, detail: 'the answers were not paired with the requests' });
    }
  }
  return reportOf(rows);
}

if (import.meta.main) {
  const at = process.argv.indexOf('--impl');
  const impl = at >= 0 ? process.argv[at + 1] : undefined;
  if (!impl) {
    process.stderr.write(usage());
    process.exitCode = 2;
  } else {
    const result = await run(impl);
    process.stdout.write(`${result.report}\n`);
    process.exitCode = result.code;
  }
}
