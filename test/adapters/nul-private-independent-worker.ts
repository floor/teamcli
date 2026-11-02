import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [scene, expectedHome] = process.argv.slice(2);
if (scene === undefined || expectedHome === undefined || homedir() !== realpathSync(expectedHome)) throw new Error('child-start synthetic HOME required');
const home = homedir();
const base = dirname(home);
const { scanPrivateLines, privateDiffCorpus } = await import('../../src/check/private-names.ts');
const needle = ['fixture', 'privacy', 'token'].join('-');
const split = needle.slice(0, 8) + '\0' + needle.slice(8);
const names = join(base, 'names.txt');
const phrases = join(base, 'phrases.txt');
writeFileSync(names, needle + '\n', { mode: 0o600 });
writeFileSync(phrases, 'unrelated-synthetic-phrase\n', { mode: 0o600 });
const sources = [{ label: 'synthetic', path: names, entries: [{ source: needle, scope: ['diff'] as const, origin: 'synthetic', ordinal: 1, line: 1 }] }];
const samples: Record<string, string[]> = {
  adjacent: ['safe', needle, 'padding\0tail'],
  split: ['safe', split],
  multiple: ['', '\0' + needle + '\0', 'safe\0', needle.slice(0, 4) + '\0\0' + needle.slice(4)],
  positions: ['\0', '', needle, 'plain', '\0', needle],
};
if (samples[scene] !== undefined) {
  const scan = scanPrivateLines(samples[scene]!, sources);
  console.log(JSON.stringify({ home, scan }));
} else {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[], input?: string | Buffer): Buffer => {
    const result = spawnSync('git', args, { cwd: repo, env, input });
    if (result.status !== 0) throw new Error(result.stderr.toString());
    return result.stdout;
  };
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.gitattributes'), 'notes.txt diff\n');
  writeFileSync(join(repo, 'notes.txt'), 'safe\n');
  git(['add', '.gitattributes', 'notes.txt']);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'test: seed synthetic corpus\n\nAgent: GPT Sol 6.1 · tester']);
  const parent = git(['rev-parse', 'HEAD']).toString().trim();
  if (scene === 'range') writeFileSync(join(repo, 'notes.txt'), `safe\n${needle}\npadding\0tail\n`);
  if (scene === 'range-split') writeFileSync(join(repo, 'notes.txt'), `safe\n${split}\n`);
  git(['add', 'notes.txt']);
  const tree = git(['write-tree']).toString().trim();
  const body = scene === 'commit-tail' ? `test: record synthetic range\n\nprefix\0${needle}\n` : scene === 'commit-before' ? `test: record synthetic range\n\n${needle}\nprefix\0suffix\n` : 'test: record synthetic range\n\nprefix\0suffix\n';
  const raw = Buffer.from(`tree ${tree}\nparent ${parent}\nauthor Synthetic <fixture@example.invalid> 1793520000 +0000\ncommitter Synthetic <fixture@example.invalid> 1793520000 +0000\n\n${body}\nAgent: GPT Sol 6.1 · tester\n`);
  const commit = git(['hash-object', '--literally', '-t', 'commit', '-w', '--stdin'], raw).toString().trim();
  git(['update-ref', 'refs/heads/main', commit, parent]);
  const built = privateDiffCorpus(repo, parent);
  if ('problem' in built) throw new Error(built.problem);
  const scan = scanPrivateLines(built.corpus.lines, sources);
  if ('problem' in scan) throw new Error(scan.problem);
  const locations = scan.hits.map((hit) => built.corpus.where[hit.line - 1]);
  const script = fileURLToPath(new URL('../../scripts/check-private-diff.ts', import.meta.url));
  const cli = spawnSync(process.execPath, [script, '--root', repo, '--base', parent, '--private-names', names, '--private-phrases', phrases], { cwd: repo, env, encoding: 'utf8', timeout: 15_000 });
  const rawAgain = git(['cat-file', 'commit', commit]);
  console.log(JSON.stringify({ home, locations, commit, corpusHasNul: built.corpus.lines.some((line) => line.includes('\0')), rawHasNul: rawAgain.includes(0), rawHasNeedle: rawAgain.includes(Buffer.from(needle)), code: cli.status, out: cli.stdout, err: cli.stderr, leaks: (cli.stdout + cli.stderr).includes(needle) }));
}
