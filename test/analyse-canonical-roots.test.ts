import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mayAnalyseProject, signAnalyserSetting } from '../src/analyse/gate.ts';
import { readProjectFacts } from '../src/analyse/read.ts';
import { runAnalyse } from '../src/commands/analyse.ts';
import { recordText } from '../src/config/team-record.ts';
import type { Io } from '../src/io.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { updateState } from '../src/state.ts';
import type { YamlValue } from '../src/yaml.ts';

const made: string[] = [];
const SENTINEL = 'CANONICAL_PRIVATE_SENTINEL';
afterEach(() => {
  for (const path of made.splice(0)) childProcess.execFileSync('trash', [path]);
});

function world() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'analyse-canonical-')));
  made.push(base);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  fs.mkdirSync(join(home, '.config', 'team'), { recursive: true });
  fs.mkdirSync(repo);
  const write = (path: string, text = `analyser: ${SENTINEL}\n`) => {
    fs.mkdirSync(path, { recursive: true });
    fs.writeFileSync(join(path, 'README.md'), text);
  };
  const configure = (roots: [string, string, string][]) => {
    fs.writeFileSync(join(home, '.config', 'team', 'entities.yaml'), recordText(Object.fromEntries(
      roots.map(([id, principal, root]) => [id, {
        analyser: signAnalyserSetting(home, 'entity', id, { principal, roots: [root] }) as unknown as YamlValue,
      }]),
    )));
  };
  for (const suffix of ['a', 'b']) {
    const root = join(base, `team-${suffix}`);
    fs.mkdirSync(root);
    upsertTeam(home, teamIdOf(root), { project: `team-${suffix}`, session: `team-${suffix}`, root });
    updateState(join(root, '.agents'), state => {
      state.sessions[`team-${suffix}`] = {
        seats: { [`seat-${suffix}`]: { stage: 'ready', pane: `pane-${suffix}` } }, worktrees: {},
      };
    });
  }
  const io = (suffix = 'a'): Io & { out: string } => {
    let out = '';
    return {
      cwd: repo, env: { HOME: home }, stdinIsTTY: false,
      caller: { kind: 'seat', name: `seat-${suffix}`, session: `team-${suffix}`, pane: `pane-${suffix}` },
      stdout: text => { out += text; }, stderr: () => {}, get out() { return out; },
    };
  };
  return { home, repo, write, configure, io };
}

async function refusedBeforeRead(w: ReturnType<typeof world>, target: string, suffix = 'a') {
  const read = fs.readFileSync;
  const spawn = childProcess.spawnSync;
  const targetReads: string[] = [];
  let gitCalls = 0;
  const reads = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof read>) => {
    if (String(args[0]).startsWith(w.repo + '/')) targetReads.push(String(args[0]));
    return Reflect.apply(read, fs, args);
  }) as typeof read);
  const spawns = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof spawn>) => {
    if (args[0] === 'git') gitCalls += 1;
    return Reflect.apply(spawn, childProcess, args);
  }) as typeof spawn);
  const io = w.io(suffix);
  let code: number;
  try {
    code = await runAnalyse([target, '--json'], io, { home: w.home });
  } finally {
    reads.mockRestore();
    spawns.mockRestore();
  }
  expect({ code, leaked: io.out.includes(SENTINEL), targetReads, gitCalls }).toEqual({
    code: 1, leaked: false, targetReads: [], gitCalls: 0,
  });
}

for (const kind of ['sibling', 'chain'] as const) {
  test(`${kind} aliases cannot bypass a narrower canonical analyser`, async () => {
    const w = world();
    const narrow = join(w.repo, 'private');
    w.write(join(narrow, 'sub'));
    fs.mkdirSync(join(w.repo, 'shared'));
    const entry = join(w.repo, 'shared', 'entry');
    if (kind === 'chain') {
      fs.symlinkSync(narrow, join(w.repo, 'second'));
      fs.symlinkSync(join(w.repo, 'second'), entry);
    } else fs.symlinkSync(narrow, entry);
    w.configure([['entity-b', 'seat-b@team-b', narrow], ['entity-a', 'seat-a@team-a', w.repo]]);
    await refusedBeforeRead(w, join(entry, 'sub'));
    const own = w.io('b');
    expect(await runAnalyse([join(entry, 'sub'), '--json'], own, { home: w.home })).toBe(0);
  });
}

test('an alias from a narrow root to a broader one keeps the destination analyser', async () => {
  const w = world();
  const narrow = join(w.repo, 'private');
  const publicRoot = join(w.repo, 'public');
  fs.mkdirSync(narrow);
  w.write(join(publicRoot, 'sub'), '# Public fixture\n');
  fs.symlinkSync(publicRoot, join(narrow, 'exit'));
  w.configure([['entity-a', 'seat-a@team-a', w.repo], ['entity-b', 'seat-b@team-b', narrow]]);
  const target = join(narrow, 'exit', 'sub');
  await refusedBeforeRead(w, target, 'b');
  expect(await runAnalyse([target, '--json'], w.io('a'), { home: w.home })).toBe(0);
});

for (const reverse of [false, true]) {
  test(`equal canonical roots with different principals refuse both spellings (reverse=${reverse})`, async () => {
    const w = world();
    w.write(join(w.repo, 'sub'));
    const alias = join(w.repo, 'longer-root-alias');
    fs.symlinkSync(w.repo, alias);
    const roots: [string, string, string][] = [
      ['entity-a', 'seat-a@team-a', w.repo], ['entity-b', 'seat-b@team-b', alias],
    ];
    w.configure(reverse ? roots.reverse() : roots);
    await refusedBeforeRead(w, join(w.repo, 'sub'));
    await refusedBeforeRead(w, join(alias, 'sub'));
  });
}

test('equal canonical roots for the same principal keep ordinary reads available', async () => {
  const w = world();
  w.write(join(w.repo, 'sub'), '# Ordinary fixture\n');
  const alias = join(w.repo, 'longer-root-alias');
  fs.symlinkSync(w.repo, alias);
  w.configure([['entity-a', 'seat-a@team-a', w.repo], ['entity-b', 'seat-a@team-a', alias]]);
  for (const target of [join(w.repo, 'sub'), join(alias, 'sub')]) {
    expect(await runAnalyse([target, '--json'], w.io(), { home: w.home })).toBe(0);
  }
});

test('retargeting an alias after admission cannot change the directory read', () => {
  const w = world();
  const publicRoot = join(w.repo, 'public');
  const narrow = join(w.repo, 'private');
  w.write(join(publicRoot, 'sub'), '# Ordinary fixture\n');
  w.write(join(narrow, 'sub'));
  const alias = join(w.repo, 'entry');
  fs.symlinkSync(publicRoot, alias);
  w.configure([['entity-a', 'seat-a@team-a', w.repo], ['entity-b', 'seat-b@team-b', narrow]]);
  const target = join(alias, 'sub');
  const gate = mayAnalyseProject(w.io(), target, { home: w.home });
  expect(gate.ok).toBe(true);
  if (!gate.ok) return;
  fs.unlinkSync(alias);
  fs.symlinkSync(narrow, alias);
  const read = readProjectFacts(target, { signedRoot: gate.scopeRoot, canonicalTarget: gate.canonicalTarget });
  expect(read.ok).toBe(false);
  expect(JSON.stringify(read)).not.toContain(SENTINEL);
});
