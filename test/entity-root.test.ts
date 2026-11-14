// Each entity has one projects root per machine, named in the machine's own entities file
// (`<entity>: { root: <folder> }`), and a team file names it `{root}` (src/file/root-word.ts): the
// same file reads on every machine. Every scene is a synthetic home under a scratch root; no live
// registry, entities file or store is read, and no launch runs.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundRoot, charterPath, defaultProjectRoots, resolvedTarget, signedRoots } from '../src/charter/body.ts';
import { charterRootsGate } from '../src/charter/check.ts';
import { inheritedRulesProblem } from '../src/launch/rules.ts';
import { readCharter } from '../src/charter/store.ts';
import { runConfig } from '../src/commands/config.ts';
import { runSetup } from '../src/commands/setup.ts';
import { rootWordFindings } from '../src/commands/doctor.ts';
import { runMigrate } from '../src/commands/migrate.ts';
import { canonicalFolder, checkedRootPath, entitiesPath, entityFolders, entityProjectsRoot } from '../src/entities.ts';
import { fillRootWord, filledPath, filledRules, hasRootWord, keptRootWords, planRootRewrite, rootPathUses } from '../src/file/root-word.ts';
import { writeTeamText } from '../src/file/team-text.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { fillSecretWords } from '../src/launch/secret-words.ts';
import type { SecretStore } from '../src/secrets/store.ts';
import { formatPlan, upPlan, type UpSeat } from '../src/launch/plan.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { readTeamText } from '../src/file/team-text.ts';
import { parseYaml } from '../src/yaml.ts';
import { intoRegistry } from './helpers/registry-team.ts';
import { fixtureBase, gitEnv, testIo } from './helpers.ts';
import { fakeOwnerStore } from './helpers/owner-seat.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch home whose entities file says `entities` (absent: no file). */
function homeWith(entities?: string): string {
  const base = fixtureBase('.entity-root-');
  made.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.config', 'team'), { recursive: true });
  if (entities !== undefined) writeFileSync(entitiesPath(home), entities);
  return home;
}

/** A team of entity `acme` (or none) whose launch line, rules and brief name `{root}`. */
function teamText(options: { entity?: string | null; launch?: string; rules?: string[]; brief?: string } = {}): string {
  const entity = options.entity === undefined ? 'acme' : options.entity;
  return [
    'format: 1',
    'project: web',
    ...(entity === null ? [] : [`entity: ${entity}`]),
    'operator: lead',
    '# the knowledge base sits beside the code',
    'rules:',
    ...(options.rules ?? ['"Docs for this team live in {root}/docs/web/."']).map((rule) => `  - ${rule}`),
    'workspace:',
    '  mode: shared',
    'seats:',
    '  - role: orchestrator',
    '    name: lead',
    '    leads: true',
    '    cli: codex',
    '    vendor: openai',
    '    model: GPT Sol',
    '    version: "6.1"',
    `    launch: ${options.launch ?? 'zsh {root}/docs/tools/as-acme.sh codex -m gpt-6.1-sol'}`,
    ...(options.brief === undefined ? [] : [`    brief: ${options.brief}`]),
    '',
  ].join('\n');
}

describe('the projects root an entity names on this machine', () => {
  test('an absolute path or one under the home reads as an absolute folder, trailing slash dropped', () => {
    expect(checkedRootPath('/home/acme/repos', '/home/acme')).toEqual({ ok: true, root: '/home/acme/repos' });
    expect(checkedRootPath('~/Code/acme/', '/home/owner')).toEqual({ ok: true, root: '/home/owner/Code/acme' });
    expect(checkedRootPath('~/repos', '/home/acme')).toEqual({ ok: true, root: '/home/acme/repos' });
  });

  test('a relative path, the filesystem root, the home, a folder above it, a word and a .. are refused', () => {
    for (const value of ['Code/acme', './acme', '/', '', '{root}/x', '{worktrees}', '~', '~/', '/home', '/home/owner', '~/..', '~/repos/../..', '/srv/../etc']) {
      expect(checkedRootPath(value, '/home/owner').ok, JSON.stringify(value)).toBe(false);
    }
  });

  test('a folder holds no character a shell reads: $(…), a space, a quote and the rest are refused', () => {
    for (const value of ['/srv/$(id)', '/srv/my repos', "/srv/it's", '/srv/"x"', '/srv/`id`', '/srv/a\\b', '/srv/a;b', '/srv/a|b', '/srv/a&b', '/srv/a*', '/srv/a?', '/srv/{x}', '/home/a\nb', '~/$HOME']) {
      const checked = checkedRootPath(value, '/home/owner');
      expect(checked.ok, JSON.stringify(value)).toBe(false);
    }
    expect(checkedRootPath('/srv/$(id)', '/home/owner')).toEqual({ ok: false, why: 'a folder of the entity holds only letters, digits and / . _ - @ +, after a leading ~/ (no space, quote, $, backtick, backslash, other ~ or other shell character)' });
    expect(checkedRootPath('/srv/team@v1.2+x_y-z', '/home/owner')).toEqual({ ok: true, root: '/srv/team@v1.2+x_y-z' });
  });

  test('the entities file holds it under the entity; absent reads as none, a bad word is refused', () => {
    const home = homeWith('acme:\n  root: ~/Code/acme\nother:\n  roots: [/x]\nbroken:\n  root: Code/broken\n');
    expect(entityProjectsRoot(home, 'acme')).toEqual({ ok: true, root: join(home, 'Code', 'acme') });
    expect(entityProjectsRoot(home, 'other')).toEqual({ ok: true, root: null });
    expect(entityProjectsRoot(home, 'missing')).toEqual({ ok: true, root: null });
    expect(entityProjectsRoot(home, null)).toEqual({ ok: true, root: null });
    expect(entityProjectsRoot(home, 'broken').ok).toBe(false);
  });
});

describe('the word', () => {
  test('{root} is filled wherever it stands; the shell\'s ${root} is left alone', () => {
    expect(hasRootWord('zsh {root}/x.sh')).toBe(true);
    expect(hasRootWord('echo ${root}/x')).toBe(false);
    expect(fillRootWord('cd {root}/a && ls ${root} {root}', '/srv/acme')).toBe('cd /srv/acme/a && ls ${root} /srv/acme');
    // A folder holding `$&` is placed as written, never read as a replacement pattern.
    expect(fillRootWord('{root}/x', '/srv/$&')).toBe('/srv/$&/x');
  });

  test('an unquoted value that starts with the word is refused with the repair', () => {
    expect(() => parseYaml('cwd: {root}/app')).toThrow('a value that starts with {root} must be quoted');
  });
});

describe('a team file that writes {root}', () => {
  test('its launch line, rules and brief read this machine\'s folder', () => {
    const home = homeWith('acme:\n  root: /srv/acme\n');
    const checked = validateTeamFile(teamText({ brief: '"{root}/docs/briefs/lead.md"' }), { home });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const seat = checked.team.seats[0]!;
    expect(seat.launch).toBe('zsh /srv/acme/docs/tools/as-acme.sh codex -m gpt-6.1-sol');
    expect(seat.brief).toBe('/srv/acme/docs/briefs/lead.md');
    expect(checked.team.rules).toEqual(['Docs for this team live in /srv/acme/docs/web/.']);
    const rules = rulesOf(checked.team, seat, '/srv/acme/web', undefined, 'file', home);
    expect(rules).toContain('- Docs for this team live in /srv/acme/docs/web/.');
    expect(rules).toContain('/srv/acme/docs/briefs/lead.md');
    expect(rules).not.toContain('{root}');
  });

  test('the same text reads each machine\'s own folder', () => {
    const text = teamText();
    const mac = validateTeamFile(text, { home: homeWith('acme:\n  root: ~/Code/acme\n') });
    const server = validateTeamFile(text, { home: homeWith('acme:\n  root: /home/acme/repos\n') });
    expect(mac.ok && mac.team.seats[0]!.launch).toMatch(/^zsh \/.+\/home\/Code\/acme\/docs\/tools\/as-acme\.sh /);
    expect(server.ok && server.team.seats[0]!.launch).toBe('zsh /home/acme/repos/docs/tools/as-acme.sh codex -m gpt-6.1-sol');
  });

  test('no root on this machine refuses the file, naming the line and the command that sets one', () => {
    for (const entities of [undefined, 'acme:\n  roots: [/srv]\n']) {
      const checked = validateTeamFile(teamText(), { home: homeWith(entities) });
      expect(checked.ok).toBe(false);
      if (checked.ok) continue;
      expect(checked.errors).toEqual([{
        line: 7,
        message: 'the file writes {root}, and entity "acme" names no projects root on this machine: run `team config set acme.root <folder>`',
      }]);
    }
  });

  test('a team with no entity, and an entity whose root does not read, are refused too', () => {
    const none = validateTeamFile(teamText({ entity: null }), { home: homeWith('acme:\n  root: /srv/acme\n') });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.errors[0]!.message).toContain('names no entity');
    const bad = validateTeamFile(teamText(), { home: homeWith('acme:\n  root: srv/acme\n') });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0]!.message).toContain('the file writes {root}, and entity "acme" root:');
  });

  test('a file without the word reads exactly as before, with or without a root', () => {
    const text = teamText({ launch: 'codex -m gpt-6.1-sol', rules: ['Run the tests your change touches.'] });
    const before = validateTeamFile(text, { home: homeWith() });
    const after = validateTeamFile(text, { home: homeWith('acme:\n  root: /srv/acme\n') });
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.team).toEqual(before.team);
  });

  test('a secret word on the same line is still filled from the store', () => {
    const home = homeWith('acme:\n  root: /srv/acme\n');
    const checked = validateTeamFile(teamText({ launch: 'OPENAI_API_KEY={secret:openai-acme} zsh {root}/docs/tools/as-acme.sh codex' }), { home });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const line = checked.team.seats[0]!.launch;
    expect(line).toBe('OPENAI_API_KEY={secret:openai-acme} zsh /srv/acme/docs/tools/as-acme.sh codex');
    const store: SecretStore = { read: async () => ({ ok: false, reason: 'not read' }), lookupCommand: (name: string) => ({ ok: true, command: `lookup ${name}` }) };
    expect(fillSecretWords(line, store)).toEqual({ ok: true, line: 'OPENAI_API_KEY="$(lookup openai-acme)" zsh /srv/acme/docs/tools/as-acme.sh codex', entries: ['openai-acme'] });
  });

  test('the launch plan runs the filled line, never a literal {root}', () => {
    const home = homeWith('acme:\n  root: /srv/acme\n');
    const checked = validateTeamFile(teamText({ launch: 'zsh {root}/docs/tools/as-acme.sh claude' }), { home });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const seat: UpSeat = {
      name: 'lead', cli: 'claude-code', launch: checked.team.seats[0]!.launch, vendor: 'anthropic', role: 'orchestrator',
      model: 'Claude Opus', version: '5.5', cwd: '.', label: 'lead · orchestrator', displayAgent: 'Claude Opus 5.5',
      repairLine: '`team down` then `team up` (to restart the whole team)', stopped: false, rules: '',
    };
    const text = formatPlan(upPlan({ root: '/srv/acme/web', session: 'acme-web', sessionRunning: true, seats: [seat], watchAlive: true, watchLabel: 'Watch · acme-web' }));
    expect(text).toContain('/srv/acme/docs/tools/as-acme.sh');
    expect(text).not.toContain('{root}');
  });

  test('an entity\'s and a project\'s rules read the word the same way', () => {
    const home = homeWith('acme:\n  root: /srv/acme\n');
    expect(filledRules(['Notes go in {root}/docs/notes.', 'Keep it short.'], home, 'acme')).toEqual(['Notes go in /srv/acme/docs/notes.', 'Keep it short.']);
    // No root here: the rule keeps the word, and the doctor names it (below).
    expect(filledRules(['Notes go in {root}/docs.'], homeWith(), 'acme')).toEqual(['Notes go in {root}/docs.']);
  });
});

describe('the doctor names full paths inside the root', () => {
  test('the absolute and the home forms are named, once per value; a longer path is not', () => {
    const home = homeWith('acme:\n  root: ~/Code/acme\n');
    const text = teamText({
      launch: `zsh ~/Code/acme/docs/tools/as-acme.sh codex`,
      rules: [`"Never commit in ${home}/Code/acme/site itself."`, `"Scratch lives in ${home}/Code/acme-scratch."`, '"Docs: {root}/docs."'],
    });
    const uses = rootPathUses(text, home);
    expect(uses.map((use) => [use.line, use.field, use.written])).toEqual([
      [7, 'rules.0', `${home}/Code/acme`],
      [20, 'seats.0.launch', '~/Code/acme'],
    ]);
    const checked = validateTeamFile(text, { home });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const findings = rootWordFindings(text, checked.team, join(home, 'Code', 'acme', 'web'), home);
    // The two paths, and the folders bound to no signature: this machine has no charter.
    expect(findings.map((finding) => finding.level)).toEqual(['warn', 'warn', 'warn']);
    expect(findings[1]!.text).toContain('the file, line 20: seats.0.launch writes ~/Code/acme, the entity\'s projects root on this machine: write {root} in its place');
  });

  test('the home\'s own folders sit outside a root under the home, and are not named', () => {
    // The server layout: repositories under ~/repos (a folder need not carry its remote's name),
    // worktrees beside it, the machine's config in ~/.config: only ~/repos/… is the root's.
    const home = homeWith('acme:\n  root: ~/repos\n');
    const text = teamText({
      launch: 'zsh ~/repos/v4/tools/as-acme.sh codex',
      rules: ['"The lobby is ~/.config/team/lobbies/acme."', '"Worktrees go in ~/worktrees/acme."', '"Docs: ~/repos-old/docs."'],
    });
    expect(rootPathUses(text, home).map((use) => [use.field, use.written])).toEqual([['seats.0.launch', '~/repos']]);
  });

  test('a hidden folder of the root is the machine\'s, never read as a project path', () => {
    const home = homeWith('acme:\n  root: ~/repos\n');
    const text = teamText({ launch: 'zsh ~/repos/docs/tools/as-acme.sh codex', rules: ['"The cache is ~/repos/.cache/acme."'] });
    expect(rootPathUses(text, home).map((use) => [use.field, use.written])).toEqual([['seats.0.launch', '~/repos']]);
  });

  test('no root on this machine: nothing to compare with, so nothing is named', () => {
    const home = homeWith();
    expect(rootPathUses(teamText({ launch: `zsh ${home}/Code/acme/x.sh` }), home)).toEqual([]);
  });
});

describe('rewriting full paths as {root}', () => {
  test('a dry plan rewrites only the root paths, keeps comments, and quotes a value that starts with the word', () => {
    const home = homeWith('acme:\n  root: ~/Code/acme\n');
    const text = teamText({
      launch: 'zsh ~/Code/acme/docs/tools/as-acme.sh codex # the wrapper',
      rules: [`${home}/Code/acme/docs/web is the knowledge base`, `"Never commit in ${home}/Code/acme/site itself."`],
      brief: `${home}/Code/acme/docs/briefs/lead.md`,
    });
    const plan = planRootRewrite(text, home);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changes.map((change) => [change.line, change.after.trim()])).toEqual([
      [7, "- '{root}/docs/web is the knowledge base'"],
      [8, '- "Never commit in {root}/site itself."'],
      [19, 'launch: zsh {root}/docs/tools/as-acme.sh codex # the wrapper'],
      [20, "brief: '{root}/docs/briefs/lead.md'"],
    ]);
    expect(plan.text).toContain('# the knowledge base sits beside the code');
    // Read back on this machine, the rewrite is the same team, every root path absolute.
    const before = validateTeamFile(text, { home });
    const after = validateTeamFile(plan.text, { home });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.team.rules).toEqual(before.team.rules);
    expect(after.team.seats[0]!.brief).toBe(before.team.seats[0]!.brief);
    expect(after.team.seats[0]!.launch).toBe(`zsh ${home}/Code/acme/docs/tools/as-acme.sh codex`);
  });

  test('with no root set, the plan is refused with the command that sets one', () => {
    const plan = planRootRewrite(teamText(), homeWith());
    expect(plan).toEqual({ ok: false, why: 'entity "acme" names no projects root on this machine: run `team config set acme.root <folder>`' });
  });
});

/** A home with an entities file, and one team checkout moved into its registry. */
function world(text: (home: string) => string, entities: string): { home: string; root: string } {
  const home = homeWith(entities);
  const root = join(home, '..', 'web');
  mkdirSync(join(root, '.agents'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore', env: gitEnv() });
  writeFileSync(join(root, '.agents', 'team.yaml'), text(home));
  intoRegistry(root, home);
  return { home, root };
}

const SEAT_CALLER = { kind: 'seat' as const, name: 'lead', pane: 'w1:p1' };

describe('team migrate --root', () => {
  test('--dry-run lists every line and writes nothing; the owner\'s run writes those lines and says each', async () => {
    const { home, root } = world(
      (at) => teamText({ launch: `zsh ${at}/Code/acme/docs/tools/as-acme.sh codex`, rules: ['Keep it short.'] }),
      'acme:\n  roots: [/x]\n',
    );
    // The team's text where every command reads it: the suite's source, the registry in real use.
    const record = (): string => readTeamText(join(root, '.agents', 'team.yaml'), { home });
    const stored = record();

    // No root yet: the dry run is refused, and says how to set one.
    const unset = testIo(root, { kind: 'owner' });
    expect(await runMigrate(['--root', '--dry-run'], unset, { home })).toBe(1);
    expect(unset.err).toContain('run `team config set acme.root <folder>`');

    const set = testIo(root, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.root', '~/Code/acme'], set, { home })).toBe(0);
    expect(set.out).toContain(`set acme.root: ~/Code/acme (${home}/Code/acme)`);
    expect(readFileSync(entitiesPath(home), 'utf8')).toContain('root: ~/Code/acme');

    const dry = testIo(root, { kind: 'owner' });
    expect(await runMigrate(['--root', '--dry-run'], dry, { home })).toBe(0);
    expect(dry.out).toContain('would rewrite 1 line to {root}');
    expect(dry.out).toContain('+ launch: zsh {root}/docs/tools/as-acme.sh codex');
    expect(record()).toBe(stored);

    // Only the owner writes it.
    const seat = testIo(root, SEAT_CALLER);
    expect(await runMigrate(['--root'], seat, { home })).toBe(1);
    expect(seat.err).toContain('only the owner rewrites');
    expect(record()).toBe(stored);

    const apply = testIo(root, { kind: 'owner' });
    expect(await runMigrate(['--root'], apply, { home })).toBe(0);
    expect(apply.out).toContain('rewrote 1 line to {root}');
    expect(record()).toContain('launch: zsh {root}/docs/tools/as-acme.sh codex');
    expect(record()).toContain('# the knowledge base sits beside the code');

    const again = testIo(root, { kind: 'owner' });
    expect(await runMigrate(['--root', '--dry-run', '--json'], again, { home })).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ dry_run: true, written: false, entity: 'acme', changes: [] });

    // The root form takes no import option.
    const mixed = testIo(root, { kind: 'owner' });
    expect(await runMigrate(['--root', '--keep-file'], mixed, { home })).toBe(2);
  });
});

describe('team config <entity>.root', () => {
  test('get, set and unset, the owner\'s; a team path ending in root stays the team\'s', async () => {
    const home = homeWith('acme:\n  roots: [/x]\n');
    const cwd = join(home, '..');
    const get = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['get', 'acme.root'], get, { home })).toBe(1);
    const bad = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.root', 'Code/acme'], bad, { home })).toBe(1);
    expect(bad.err).toContain('is not an absolute path');
    const dry = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.root', '/srv/acme/', '--dry-run'], dry, { home })).toBe(0);
    expect(readFileSync(entitiesPath(home), 'utf8')).not.toContain('root: /srv/acme');
    const set = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.root', '/srv/acme/'], set, { home })).toBe(0);
    expect(readFileSync(entitiesPath(home), 'utf8')).toContain('root: /srv/acme\n');
    expect(set.err).toContain('teams of entity "acme" read {root} as /srv/acme');
    const json = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['get', 'acme.root', '--json'], json, { home })).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ path: 'acme.root', value: '/srv/acme', resolved: '/srv/acme' });
    const other = testIo(cwd, SEAT_CALLER);
    expect(await runConfig(['set', 'acme.root', '/elsewhere'], other, { home })).toBe(1);
    expect(readFileSync(entitiesPath(home), 'utf8')).toContain('root: /srv/acme\n');
    const unset = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['unset', 'acme.root'], unset, { home })).toBe(0);
    expect(readFileSync(entitiesPath(home), 'utf8')).not.toContain('root:');
    // `seats.root` is a seat named root, in the team's record: not an entity's.
    const seatPath = testIo(cwd, { kind: 'owner' });
    await runConfig(['get', 'seats.root'], seatPath, { home });
    expect(seatPath.err).not.toContain('projects root');
  });
});

describe('the charter team setup signs by default', () => {
  const NOW = new Date('2026-11-14T12:00:00.000Z');
  const AGENT = { kind: 'unplaced' as const, reason: 'the agent that launched setup' };

  test('a server account: the roots are each entity\'s own root under the home, never the home or a guessed folder', () => {
    // The server shape: repositories sit under `repos`, worktrees beside it, nothing named Code.
    const home = homeWith('floor:\n  root: ~/repos\n');
    for (const folder of ['repos/vlist', 'repos/v4', 'worktrees']) mkdirSync(join(home, folder), { recursive: true });
    expect(defaultProjectRoots(home)).toEqual({ ok: true, roots: [join(home, 'repos')] });
  });

  test('a machine with two entities signs both roots, in the file\'s order, once each', () => {
    const home = homeWith('floor:\n  root: ~/Code/floor\nradiooooo:\n  root: ~/Code/radiooooo/\nother:\n  root: ~/Code/floor\n');
    for (const folder of ['Code/floor', 'Code/radiooooo']) mkdirSync(join(home, folder), { recursive: true });
    expect(defaultProjectRoots(home)).toEqual({ ok: true, roots: [join(home, 'Code', 'floor'), join(home, 'Code', 'radiooooo')] });
  });

  test('no entity names a root: refused, with the command that sets one; a folder found is only a suggestion', () => {
    const bare = defaultProjectRoots(homeWith());
    expect(bare).toEqual({
      ok: false,
      why: 'no entity names a projects root on this machine: set one with `team config set <entity>.root <folder>`, or name the charter\'s roots with --roots <dirs>; nothing was written',
    });
    const home = homeWith('floor:\n  roots: [/x]\n');
    mkdirSync(join(home, 'repos'), { recursive: true });
    const suggested = defaultProjectRoots(home);
    expect(suggested.ok).toBe(false);
    if (!suggested.ok) expect(suggested.why).toContain(`(folders found under the home: ${join(home, 'repos')})`);
    const broken = defaultProjectRoots(homeWith('floor:\n  root: repos\n'));
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.why).toContain('entity "floor" root:');
  });

  test('team setup with no root and no --roots signs nothing; with the root set it signs that root', async () => {
    const home = homeWith();
    mkdirSync(join(home, 'repos', 'vlist'), { recursive: true });
    const store = fakeOwnerStore();
    const refused = testIo(join(home, 'repos'), AGENT);
    expect(await runSetup(['--signer', 'touch-id', '--team', 'floor'], refused, { home, store, now: () => NOW })).toBe(1);
    expect(refused.err).toContain('no entity names a projects root on this machine');
    expect(store.prompts).toEqual([]);
    expect(existsSync(charterPath(home))).toBe(false);

    // A fresh machine: the root set makes the entities file and the entry.
    const set = testIo(home, { kind: 'owner' });
    expect(await runConfig(['set', 'floor.root', '~/repos'], set, { home })).toBe(0);
    expect(readFileSync(entitiesPath(home), 'utf8')).toContain('root: ~/repos');

    const signed = testIo(join(home, 'repos'), AGENT);
    expect(await runSetup(['--signer', 'touch-id', '--team', 'floor'], signed, { home, store, now: () => NOW })).toBe(0);
    const read = readCharter(home, store);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') expect(read.charter.body.roots).toEqual([join(home, 'repos')]);
  });
});

describe('the worktrees folder: {worktrees}', () => {
  // The server layout: repositories under ~/repos, worktrees beside it in ~/worktrees.
  const SERVER = 'acme:\n  root: ~/repos\n  worktrees: ~/worktrees\n';

  test('it is the entry\'s own word, else <root>/worktrees, else none', () => {
    const server = homeWith(SERVER);
    expect(entityFolders(server, 'acme')).toEqual({ ok: true, root: join(server, 'repos'), worktrees: join(server, 'worktrees'), worktreesWritten: true });
    const mac = homeWith('acme:\n  root: ~/Code/acme\n');
    expect(entityFolders(mac, 'acme')).toEqual({ ok: true, root: join(mac, 'Code', 'acme'), worktrees: join(mac, 'Code', 'acme', 'worktrees'), worktreesWritten: false });
    expect(entityFolders(homeWith('acme:\n  roots: [/x]\n'), 'acme')).toEqual({ ok: true, root: null, worktrees: null, worktreesWritten: false });
    expect(entityFolders(homeWith('acme:\n  root: ~/repos\n  worktrees: worktrees\n'), 'acme').ok).toBe(false);
  });

  test('a team file writes {worktrees} and reads each machine\'s folder', () => {
    const text = teamText({ rules: ['"Work only in {worktrees}/web/<task>, never in {root}/web."'] });
    const server = homeWith(SERVER);
    const mac = homeWith('acme:\n  root: ~/Code/acme\n');
    const onServer = validateTeamFile(text, { home: server });
    const onMac = validateTeamFile(text, { home: mac });
    expect(onServer.ok && onServer.team.rules).toEqual([`Work only in ${server}/worktrees/web/<task>, never in ${server}/repos/web.`]);
    expect(onMac.ok && onMac.team.rules).toEqual([`Work only in ${mac}/Code/acme/worktrees/web/<task>, never in ${mac}/Code/acme/web.`]);
  });

  test('{worktrees} with no folder and no root to sit under is refused, naming both commands', () => {
    const checked = validateTeamFile(teamText({ launch: 'codex', rules: ['"Worktrees: {worktrees}/web."'] }), { home: homeWith('acme:\n  roots: [/x]\n') });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.errors[0]!.message).toBe('the file writes {worktrees}, and entity "acme" names no worktrees folder on this machine, nor a projects root it would sit under: run `team config set acme.worktrees <folder>` or `team config set acme.root <folder>`');
  });

  test('the charter signs a worktrees folder outside the root as a root of its own, and not one inside it', () => {
    const server = homeWith(SERVER);
    for (const folder of ['repos', 'worktrees']) mkdirSync(join(server, folder), { recursive: true });
    expect(defaultProjectRoots(server)).toEqual({ ok: true, roots: [join(server, 'repos'), join(server, 'worktrees')] });
    const mac = homeWith('acme:\n  root: ~/Code/acme\n');
    mkdirSync(join(mac, 'Code', 'acme', 'worktrees'), { recursive: true });
    expect(defaultProjectRoots(mac)).toEqual({ ok: true, roots: [join(mac, 'Code', 'acme')] });
  });

  test('the rewrite writes worktree paths as {worktrees}, on the server and inside a root alike', () => {
    const server = homeWith(SERVER);
    const onServer = planRootRewrite(teamText({ launch: 'codex', rules: ['"Work in ~/worktrees/web, read ~/repos/docs."'] }), server);
    expect(onServer.ok && onServer.changes.map((change) => change.after.trim())).toEqual(['- "Work in {worktrees}/web, read {root}/docs."']);
    const mac = homeWith('acme:\n  root: ~/Code/acme\n');
    const onMac = planRootRewrite(teamText({ launch: 'codex', rules: ['"Work in ~/Code/acme/worktrees/web, read ~/Code/acme/docs."'] }), mac);
    expect(onMac.ok && onMac.changes.map((change) => change.after.trim())).toEqual(['- "Work in {worktrees}/web, read {root}/docs."']);
    expect(rootPathUses(teamText({ launch: 'zsh ~/worktrees/web/run.sh' }), server).map((use) => use.word)).toEqual(['{worktrees}']);
  });

  test('team config set and unset <entity>.worktrees, the owner\'s', async () => {
    const home = homeWith('acme:\n  root: ~/repos\n');
    const cwd = join(home, '..');
    const set = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.worktrees', '~/worktrees'], set, { home })).toBe(0);
    expect(set.err).toContain(`teams of entity "acme" read {worktrees} as ${home}/worktrees`);
    expect(readFileSync(entitiesPath(home), 'utf8')).toContain('worktrees: ~/worktrees');
    const get = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['get', 'acme.worktrees', '--json'], get, { home })).toBe(0);
    expect(JSON.parse(get.out)).toMatchObject({ path: 'acme.worktrees', value: '~/worktrees', resolved: `${home}/worktrees` });
    const unset = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['unset', 'acme.worktrees'], unset, { home })).toBe(0);
    expect(readFileSync(entitiesPath(home), 'utf8')).not.toContain('worktrees:');
    const bad = testIo(cwd, { kind: 'owner' });
    expect(await runConfig(['set', 'acme.worktrees', '{root}/worktrees'], bad, { home })).toBe(1);
  });
});

describe('editors keep the words', () => {
  test('a line an editor builds from the filled team is written back with {root}; other lines are left alone', () => {
    const home = homeWith('acme:\n  root: /srv/acme/repos\n');
    const before = teamText({ rules: [`"Never commit in /srv/acme/repos/site itself."`] });
    const after = before.replace('launch: zsh {root}/docs/tools/as-acme.sh codex -m gpt-6.1-sol', 'launch: zsh /srv/acme/repos/docs/tools/as-acme.sh codex -m gpt-6.2-sol');
    const kept = keptRootWords(before, after, home);
    expect(kept).toContain('launch: zsh {root}/docs/tools/as-acme.sh codex -m gpt-6.2-sol');
    // The owner's own full path on an untouched line is the owner's word, and stays.
    expect(kept).toContain('/srv/acme/repos/site itself.');
  });

  test('writeTeamText with keepWords writes the words; without it, the text as given', () => {
    const home = homeWith('acme:\n  root: /srv/acme/repos\n');
    const folder = join(home, '..', 'web');
    mkdirSync(join(folder, '.agents'), { recursive: true });
    const path = join(folder, '.agents', 'team.yaml');
    const text = teamText();
    writeFileSync(path, text);
    const edited = text.replace('{root}/docs', '/srv/acme/repos/docs');
    expect(writeTeamText(path, edited, { home, keepWords: true }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(writeTeamText(path, edited, { home }).ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(edited);
  });
});

describe('vault-root under the entity\'s folders', () => {
  test('a {root} vault reads this machine\'s folder; with no root it names no vault and says why', () => {
    expect(filledPath('{root}/docs', homeWith('acme:\n  root: /srv/acme/repos\n'), 'acme')).toEqual({ ok: true, path: '/srv/acme/repos/docs' });
    expect(filledPath('/srv/docs', homeWith(), 'acme')).toEqual({ ok: true, path: '/srv/docs' });
    expect(filledPath('{root}/docs', homeWith(), 'acme')).toEqual({ ok: false, why: 'entity "acme" names no projects root on this machine: run `team config set acme.root <folder>`' });
    expect(filledPath('{root}/docs', homeWith('acme:\n  root: /srv/acme/repos\n'), null).ok).toBe(false);
  });
});

describe('round 1 of the review: folders bound to what is signed', () => {
  test('a link is signed as the folder it resolves to, a link to the home or / is refused, and a moved root covers nothing', () => {
    const home = homeWith();
    const real = join(home, 'repos');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(home, 'link'));
    symlinkSync('/', join(home, 'everything'));
    symlinkSync(home, join(home, 'self'));
    expect(signedRoots([join(home, 'link')], home)).toEqual({ ok: true, roots: [real] });
    expect(signedRoots([join(home, 'everything')], home).ok).toBe(false);
    expect(signedRoots([join(home, 'self')], home).ok).toBe(false);
    expect(signedRoots([join(home, 'missing')], home).ok).toBe(false);
    expect(canonicalFolder(join(home, 'everything'), home).ok).toBe(false);
    // Signed as its real path, then the folder is moved and a link to / put in its place.
    expect(boundRoot(real)).toBe(real);
    renameSync(real, join(home, 'moved'));
    symlinkSync('/', real);
    expect(boundRoot(real)).toBeNull();
    expect(boundRoot(join(home, 'gone'))).toBeNull();
  });

  test('with a signed charter, a folder the entities file moves outside it refuses the file', async () => {
    const home = homeWith('acme:\n  root: ~/repos\n');
    for (const folder of ['repos/web', 'elsewhere']) mkdirSync(join(home, folder), { recursive: true });
    const store = fakeOwnerStore();
    const signed = testIo(join(home, 'repos'), { kind: 'unplaced', reason: 'the agent that launched setup' });
    expect(await runSetup(['--signer', 'touch-id', '--team', 'acme'], signed, { home, store, now: () => new Date('2026-11-14T12:00:00.000Z') }), signed.err).toBe(0);
    const text = teamText();
    const inside = validateTeamFile(text, { home, ownerSeatStore: store });
    expect(inside.ok && inside.team.seats[0]!.launch).toBe(`zsh ${home}/repos/docs/tools/as-acme.sh codex -m gpt-6.1-sol`);
    // A process of the account edits the unsigned entities file by hand.
    writeFileSync(entitiesPath(home), 'acme:\n  root: ~/elsewhere\n');
    const outside = validateTeamFile(text, { home, ownerSeatStore: store });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.errors[0]!.message).toBe(`the file writes {root}, and {root} of entity "acme" is ${home}/elsewhere, outside the owner charter's roots: the owner widens the charter with team setup --edit, or names a folder inside it`);
    // A folder inside the charter that does not exist cannot be bound: refused too.
    writeFileSync(entitiesPath(home), 'acme:\n  root: ~/repos/not-yet\n');
    const missing = validateTeamFile(text, { home, ownerSeatStore: store });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]!.message).toContain('does not resolve to a folder on this machine');
  });

  test('with no charter the folder is filled as written, and the doctor says it is bound to no signature', () => {
    const home = homeWith('acme:\n  root: /srv/acme/repos\n');
    const text = teamText();
    const checked = validateTeamFile(text, { home });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const findings = rootWordFindings(text, checked.team, '/srv/acme/repos/web', home);
    expect(findings.some((finding) => finding.text.includes('it has no owner charter'))).toBe(true);
  });

  test('a shell line is rewritten only where the word keeps what it runs; the rest is left and listed', () => {
    const home = homeWith('acme:\n  root: ~/repos\n');
    const text = teamText({ launch: `codex --add-dir "~/repos/docs" --add-dir '$HOME/repos/a' --add-dir "$HOME/repos/b" --add-dir ~/repos/c --x=~/repos/d ${home}/repos/e` });
    const plan = planRootRewrite(text, home);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.changes.map((change) => change.after.trim())).toEqual([
      `launch: codex --add-dir "~/repos/docs" --add-dir '$HOME/repos/a' --add-dir "{root}/b" --add-dir {root}/c --x=~/repos/d {root}/e`,
    ]);
    expect(plan.kept.map((one) => one.written)).toEqual(['~/repos', '$HOME/repos', '~/repos']);
    // A rule is no shell line: a home path in it is the folder, quoted or not.
    const rule = planRootRewrite(teamText({ launch: 'codex', rules: ['"Docs live in \'~/repos/docs\'."'] }), home);
    expect(rule.ok && rule.changes.map((change) => change.after.trim())).toEqual([`- "Docs live in '{root}/docs'."`]);
    // The editors keep the words by the same rule.
    const before = teamText({ launch: 'codex' });
    const after = before.replace('launch: codex', 'launch: codex --add-dir "~/repos/docs" --add-dir ~/repos/c');
    expect(keptRootWords(before, after, home)).toContain('launch: codex --add-dir "~/repos/docs" --add-dir {root}/c');
  });

  test('a seat folder and a worktree path written with a word are taken inside the entity\'s folders', () => {
    const home = homeWith('acme:\n  root: /srv/acme/repos\n  worktrees: /srv/acme/worktrees\n');
    const text = teamText({ launch: 'codex' })
      .replace('    launch: codex\n', '    launch: codex\n    cwd: "{root}/web"\n')
      .replace('workspace:\n  mode: shared\n', 'workspace:\n  mode: shared\n  path: "{worktrees}/web/{task}"\n  base: main\n');
    const checked = validateTeamFile(text, { home, root: '/srv/acme/repos/web' });
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (!checked.ok) return;
    expect(checked.team.seats[0]!.cwd).toBe('/srv/acme/repos/web');
    expect(checked.team.workspace.path).toBe('/srv/acme/worktrees/web/{task}');
    // An absolute path the file writes itself, not through a word, is still refused.
    const plain = validateTeamFile(text.replace('cwd: "{root}/web"', 'cwd: /srv/acme/repos/web'), { home });
    expect(plain.ok).toBe(false);
  });

  test('down and status read a team whose root was removed, leaving the word as written', () => {
    const home = homeWith('acme:\n  roots: [/x]\n');
    const text = teamText();
    expect(validateTeamFile(text, { home }).ok).toBe(false);
    const kept = validateTeamFile(text, { home, unfilled: 'keep' });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.team.seats[0]!.launch).toContain('{root}/docs');
  });

  test('an entity\'s rule that writes a word the machine cannot fill refuses the team, though the file writes none', () => {
    const text = teamText({ launch: 'codex', rules: ['Run the tests.'] });
    const unset = validateTeamFile(text, { home: homeWith('acme:\n  rules:\n    - "Never edit {root}/production."\n') });
    expect(unset.ok).toBe(false);
    if (!unset.ok) expect(unset.errors[0]!.message).toBe('the entity\'s or project\'s rules write {root}, and entity "acme" names no projects root on this machine: run `team config set acme.root <folder>`');
    const set = validateTeamFile(text, { home: homeWith('acme:\n  root: /srv/acme/repos\n  rules:\n    - "Never edit {root}/production."\n') });
    expect(set.ok).toBe(true);
  });
});

describe('round 2 of the review', () => {
  const NOW = new Date('2026-11-14T12:00:00.000Z');
  const AGENT = { kind: 'unplaced' as const, reason: 'the agent that launched setup' };

  async function signed(entities: string, folders: string[]): Promise<{ home: string; store: ReturnType<typeof fakeOwnerStore> }> {
    const home = homeWith(entities);
    for (const folder of folders) mkdirSync(join(home, folder), { recursive: true });
    const store = fakeOwnerStore();
    const io = testIo(home, AGENT);
    const code = await runSetup(['--signer', 'touch-id', '--team', 'acme'], io, { home, store, now: () => NOW });
    if (code !== 0) throw new Error(io.err);
    return { home, store };
  }

  test('a path that does not exist yet is resolved through its deepest folder: a link inside a root cannot carry it out', async () => {
    const { home, store } = await signed('acme:\n  root: ~/repos\n', ['repos/web', 'outside']);
    symlinkSync(join(home, 'outside'), join(home, 'repos', 'link'));
    symlinkSync(join(home, 'nowhere'), join(home, 'repos', 'dangling'));
    expect(resolvedTarget(join(home, 'repos', 'link', 'not-yet'))).toBe(join(home, 'outside', 'not-yet'));
    expect(resolvedTarget(join(home, 'repos', 'dangling', 'x'))).toBeNull();
    // Written by hand: `join` would fold the `..` away before the check sees it.
    expect(resolvedTarget(`${home}/repos/web/../../outside`)).toBeNull();
    expect(charterRootsGate(home, join(home, 'repos', 'web', 'not-yet'), store).kind).toBe('admit');
    expect(charterRootsGate(home, join(home, 'repos', 'link', 'not-yet'), store).kind).toBe('block');
    expect(charterRootsGate(home, join(home, 'repos', 'dangling', 'x'), store).kind).toBe('block');
  });

  test('the charter is verified on every read: bytes changed with size and times put back are refused', async () => {
    const { home, store } = await signed('acme:\n  root: ~/repos\n', ['repos/web']);
    const text = teamText();
    expect(validateTeamFile(text, { home, ownerSeatStore: store }).ok).toBe(true);
    const path = charterPath(home);
    const held = statSync(path);
    const bytes = readFileSync(path, 'utf8');
    const signature = /"signature":\s*"([0-9a-f])/.exec(bytes)!;
    const swapped = signature[1] === '0' ? '1' : '0';
    writeFileSync(path, bytes.replace(signature[0], signature[0].slice(0, -1) + swapped));
    utimesSync(path, held.atime, held.mtime);
    const after = validateTeamFile(text, { home, ownerSeatStore: store });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.errors[0]!.message).toContain('the owner charter does not verify');
  });

  test('a ~ is only a leading ~/: one anywhere else in a folder is refused', () => {
    for (const value of ['/srv/run~exclude', '~/repos~x', '~/~', '/srv/~/x']) {
      expect(checkedRootPath(value, '/home/owner').ok, value).toBe(false);
    }
    expect(checkedRootPath('~/repos', '/home/owner')).toEqual({ ok: true, root: '/home/owner/repos' });
  });

  test('a shell line with a substitution, a here-document or eval is left as written, and listed', () => {
    const home = homeWith('acme:\n  root: ~/repos\n');
    for (const launch of [`codex --arg "$(printf '%s' '$HOME/repos')"`, 'codex --arg `echo ~/repos/x`', 'eval codex ~/repos/x', 'codex --x <(cat ~/repos/x)']) {
      const plan = planRootRewrite(teamText({ launch }), home);
      expect(plan.ok, launch).toBe(true);
      if (!plan.ok) continue;
      expect(plan.changes.filter((change) => change.after.includes('launch:')), launch).toEqual([]);
      expect(plan.kept.length, launch).toBe(1);
      expect(plan.kept[0]!.why).toContain('command substitution');
    }
  });

  test('the launch refuses a seat whose inherited rule names a word this machine cannot fill', () => {
    const home = homeWith('acme:\n  rules:\n    - "Never edit {root}/production."\n');
    const read = validateTeamFile(teamText({ launch: 'codex', rules: ['Keep it short.'] }), { home, unfilled: 'keep' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const problem = inheritedRulesProblem(read.team, join(home, '..', 'web'), home);
    expect(problem).toBe('its entity\'s or project\'s rules write {root} or {worktrees}, and entity "acme" names no projects root on this machine: run `team config set acme.root <folder>`');
    const seat: UpSeat = {
      name: 'lead', cli: 'claude-code', launch: 'claude', vendor: 'anthropic', role: 'orchestrator',
      model: 'Claude Opus', version: '5.5', cwd: '.', label: 'lead · orchestrator', displayAgent: 'Claude Opus 5.5',
      repairLine: '`team down` then `team up`', stopped: false, rules: '', rulesProblem: problem!,
    };
    const plan = formatPlan(upPlan({ root: '/srv/acme/web', session: 'acme-web', sessionRunning: true, seats: [seat], watchAlive: true, watchLabel: 'Watch · acme-web' }));
    expect(plan).toContain(`lead: would refuse: ${problem}`);
    expect(plan).not.toContain('workspace create');
    // With the root set, nothing is left to refuse.
    const set = homeWith('acme:\n  root: /srv/acme/repos\n  rules:\n    - "Never edit {root}/production."\n');
    const ok = validateTeamFile(teamText({ launch: 'codex', rules: ['Keep it short.'] }), { home: set });
    expect(ok.ok && inheritedRulesProblem(ok.team, join(set, '..', 'web'), set)).toBeUndefined();
  });

  test('a read to stop or show a team leaves out a trust entry whose word cannot be filled', () => {
    const home = homeWith('acme:\n  roots: [/x]\n');
    const text = teamText().replace('workspace:\n', `trust:\n  - ${home}/.config/team/lobbies/acme\n  - "{root}/web"\nworkspace:\n`);
    expect(validateTeamFile(text, { home }).ok).toBe(false);
    const kept = validateTeamFile(text, { home, unfilled: 'keep' });
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    if (kept.ok) expect(kept.team.trust).toEqual([`${home}/.config/team/lobbies/acme`]);
  });

  test('a worktrees folder linked out of the root is signed where it really is', () => {
    const home = homeWith('acme:\n  root: ~/repos\n');
    mkdirSync(join(home, 'repos'), { recursive: true });
    mkdirSync(join(home, 'elsewhere', 'worktrees'), { recursive: true });
    symlinkSync(join(home, 'elsewhere', 'worktrees'), join(home, 'repos', 'worktrees'));
    expect(defaultProjectRoots(home)).toEqual({ ok: true, roots: [join(home, 'repos'), join(home, 'elsewhere', 'worktrees')] });
    // The default worktrees folder that does not exist yet adds nothing.
    const fresh = homeWith('acme:\n  root: ~/repos\n');
    mkdirSync(join(fresh, 'repos'), { recursive: true });
    expect(defaultProjectRoots(fresh)).toEqual({ ok: true, roots: [join(fresh, 'repos')] });
  });

  test('the doctor says the folders are unsigned when only an entity rule names one', () => {
    const home = homeWith('acme:\n  root: /srv/acme/repos\n  rules:\n    - "Never edit {root}/production."\n');
    const text = teamText({ launch: 'codex', rules: ['Keep it short.'] });
    const read = validateTeamFile(text, { home });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(rootWordFindings(text, read.team, '/srv/acme/repos/web', home).some((finding) => finding.text.includes('it has no owner charter'))).toBe(true);
  });
});
