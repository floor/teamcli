// Independent coverage for the shared authority editor and the grant/revoke commands.
// Delegate command-wrapper coverage belongs to the other builder; these delegate scenes
// exercise the shared editor directly. Every file and caller below is synthetic.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { approvalOf } from '../src/approve/approval.ts';
import { runAuthorityEdit, type AuthorityEdit } from '../src/authority-edit.ts';
import type { Caller, Process } from '../src/caller.ts';
import { runDelegate } from '../src/commands/delegate.ts';
import { runGrant } from '../src/commands/grant.ts';
import { runRevoke } from '../src/commands/revoke.ts';
import { delegateGate, delegateReadGate } from '../src/delegate.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { grantGate } from '../src/grant.ts';
import { DELEGATE_OUTPUT_SCHEMA, GRANT_OUTPUT_SCHEMA, REVOKE_OUTPUT_SCHEMA } from '../src/output/index.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import type { Standing } from '../src/store/store.ts';
import { testIo, type TestIo } from './helpers.ts';
import { assertJsonErrorShape, assertMatchesOutputSchema } from './helpers/output.ts';
import { intoRegistry, realRegistryTouched, storedTeam, underRegistry } from './helpers/registry-team.ts';

const HEAD = `# Preserve the file's spelling and comments.
format: 1
project: beacon
session: arena
coordinator: lead
operator: lead
`;
const OWNER_SECTIONS = `# Unrelated owner sections must survive byte for byte.
trust:
  - .
budgets:
  marks: [50]
limits:
  seats: 9
identity:
  humans: [owner@example.test]
rules:
  - 'grant: is prose, not the grant key'
  - 'delegates: is prose, not the delegates key'
workspace:
  mode: shared
`;
const SEATS = `seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const BASE = HEAD + OWNER_SECTIONS + SEATS;
const GRANT = `grant:
  session: arena
  seat: lead
  scope: [up, down]
`;
const DELEGATES = `delegates:
  - pane: outside/first
    commands: [up, down]
  - pane: outside/second
    commands: [add, remove]
`;

type Place = { root: string; home: string; file: string };
const made: string[] = [];
afterEach(() => {
  for (const root of made.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function folder(text = BASE): Place {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-authority-edit-')));
  made.push(root);
  const home = join(root, 'home');
  const file = join(root, '.agents', 'team.yaml');
  fs.mkdirSync(dirname(file));
  fs.mkdirSync(home);
  fs.writeFileSync(file, text);
  return { root, home, file };
}

function parsed(text: string) {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.team;
}

function textAt(place: Place): string {
  return fs.readFileSync(place.file, 'utf8');
}

function owner(place: Place): TestIo {
  const io = testIo(place.root);
  io.stdinIsTTY = true;
  io.callerSources = (session) => {
    expect(session).toBeUndefined();
    return {
      ancestors: () => [{ pid: 20, name: 'zsh' }, { pid: 1, name: 'launchd' }],
      agents: () => { throw new Error('owner management must not list panes'); },
      paneRootPid: () => { throw new Error('owner management must not read panes'); },
      env: {},
      stdinIsTTY: true,
    };
  };
  return io;
}

function edit(place: Place, action: AuthorityEdit, dryRun = false) {
  const command = action.kind.startsWith('revoke') ? 'revoke' : action.kind === 'grant' ? 'grant' : 'delegate';
  const io = owner(place);
  return runAuthorityEdit(command, action, io, { home: place.home, dryRun }).then((result) => ({ result, io }));
}

describe('owner edits preserve the file outside the chosen record', () => {
  test('creates a grant, replaces its complete scope, and leaves an identical grant untouched', async () => {
    const place = folder();
    const first = owner(place);
    expect(await runGrant(['lead', '--scope', 'up,down'], first, { home: place.home })).toBe(0);
    expect(first.out).toBe('grant: updated\n');
    expect(parsed(textAt(place)).grant).toEqual({ session: 'arena', seat: 'lead', scope: ['up', 'down'] });
    expect(textAt(place)).toContain(BASE);

    const replaced = owner(place);
    expect(await runGrant(['lead', '--scope', 'reload'], replaced, { home: place.home })).toBe(0);
    expect(parsed(textAt(place)).grant?.scope).toEqual(['reload']);
    expect(textAt(place)).toContain(BASE);

    const before = textAt(place);
    const inode = fs.statSync(place.file).ino;
    const same = owner(place);
    expect(await runGrant(['lead', '--scope', 'reload'], same, { home: place.home })).toBe(0);
    expect(same.out).toBe('grant: unchanged\n');
    expect(textAt(place)).toBe(before);
    expect(fs.statSync(place.file).ino).toBe(inode);
  });

  test('an omitted session uses the session resolved by the file', async () => {
    const place = folder(BASE.replace('session: arena\n', ''));
    expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['up'] })).result).toBe('ok');
    expect(parsed(textAt(place)).grant?.session).toBe('beacon');
  });

  test('quoted top-level keys and same-looking rule strings do not confuse replacement', async () => {
    const original = HEAD + GRANT.replace('grant:', '"grant":') + OWNER_SECTIONS + SEATS;
    const place = folder(original);
    expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['init'] })).result).toBe('ok');
    const after = textAt(place);
    expect(after.startsWith(HEAD)).toBe(true);
    expect(after.endsWith(OWNER_SECTIONS + SEATS)).toBe(true);
    expect(parsed(after).grant?.scope).toEqual(['init']);
  });

  test('CRLF and mixed line endings outside the grant remain byte for byte', async () => {
    for (const mixed of [false, true]) {
      const before = HEAD.replaceAll('\n', '\r\n');
      const after = mixed ? OWNER_SECTIONS + SEATS.replaceAll('\n', '\r\n') : (OWNER_SECTIONS + SEATS).replaceAll('\n', '\r\n');
      const original = before + GRANT.replaceAll('\n', '\r\n') + after;
      const place = folder(original);
      expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['reload'] })).result).toBe('ok');
      const updated = textAt(place);
      expect(updated.startsWith(before)).toBe(true);
      expect(updated.endsWith(after)).toBe(true);
      expect(parsed(updated).grant?.scope).toEqual(['reload']);
      expect((await edit(place, { kind: 'revoke-grant' })).result).toBe('ok');
      expect(textAt(place)).toBe(before + after);
    }
  });

  test('removing an authority header on the BOM line retains the BOM and the rest of the file', async () => {
    const place = folder('\uFEFF' + GRANT + BASE);
    expect((await edit(place, { kind: 'revoke-grant' })).result).toBe('ok');
    expect(textAt(place)).toBe('\uFEFF' + BASE);
    expect(parsed(textAt(place)).grant).toBeNull();
  });

  test('grant edits preserve a separate delegates section exactly', async () => {
    const place = folder(BASE + DELEGATES + GRANT);
    expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['approve'] })).result).toBe('ok');
    expect(textAt(place).startsWith(BASE + DELEGATES)).toBe(true);
    expect(parsed(textAt(place)).delegates).toEqual(parsed(BASE + DELEGATES).delegates);
  });

  test('adds a delegate, replaces only that delegate, and preserves existing order', async () => {
    const place = folder(BASE + GRANT + DELEGATES);
    const added = await edit(place, { kind: 'delegate', pane: 'outside/third', commands: ['approve'] });
    expect(added.result).toBe('ok');
    expect(added.io.out).toBe('delegate: updated\n');
    expect(parsed(textAt(place)).delegates?.map((entry) => entry.pane)).toEqual([
      'outside/first', 'outside/second', 'outside/third',
    ]);
    const replaced = await edit(place, { kind: 'delegate', pane: 'outside/second', commands: ['up'] });
    expect(replaced.result).toBe('ok');
    expect(parsed(textAt(place)).delegates).toEqual([
      { pane: 'outside/first', commands: ['up', 'down'] },
      { pane: 'outside/second', commands: ['up'] },
      { pane: 'outside/third', commands: ['approve'] },
    ]);
    expect(textAt(place).startsWith(BASE + GRANT)).toBe(true);
    const before = textAt(place);
    const same = await edit(place, { kind: 'delegate', pane: 'outside/second', commands: ['up'] });
    expect(same.result).toBe('ok');
    expect(same.io.out).toBe('delegate: unchanged\n');
    expect(textAt(place)).toBe(before);
  });

  test('quoted delegates key is located as a YAML key', async () => {
    const place = folder(HEAD + DELEGATES.replace('delegates:', "'delegates':") + OWNER_SECTIONS + SEATS);
    expect((await edit(place, { kind: 'delegate', pane: 'outside/first', commands: ['swap'] })).result).toBe('ok');
    expect(textAt(place).startsWith(HEAD)).toBe(true);
    expect(textAt(place).endsWith(OWNER_SECTIONS + SEATS)).toBe(true);
    expect(parsed(textAt(place)).delegates?.[0]?.commands).toEqual(['swap']);
  });

  test('removes the grant without touching delegates, then treats absence as unchanged', async () => {
    const place = folder(BASE + GRANT + DELEGATES);
    const io = owner(place);
    expect(await runRevoke(['grant'], io, { home: place.home })).toBe(0);
    expect(io.out).toBe('revoke: updated\n');
    expect(textAt(place)).toBe(BASE + DELEGATES);
    const absent = owner(place);
    expect(await runRevoke(['grant'], absent, { home: place.home })).toBe(0);
    expect(absent.out).toBe('revoke: unchanged\n');
    expect(textAt(place)).toBe(BASE + DELEGATES);
  });

  test('removes exactly one delegate and removes the section when its last entry is revoked', async () => {
    const place = folder(BASE + GRANT + DELEGATES);
    const first = owner(place);
    expect(await runRevoke(['delegate', 'outside/first'], first, { home: place.home })).toBe(0);
    expect(parsed(textAt(place)).delegates).toEqual([{ pane: 'outside/second', commands: ['add', 'remove'] }]);
    expect(textAt(place).startsWith(BASE + GRANT)).toBe(true);
    const last = owner(place);
    expect(await runRevoke(['delegate', 'outside/second'], last, { home: place.home })).toBe(0);
    expect(textAt(place)).toBe(BASE + GRANT);
    const absent = owner(place);
    expect(await runRevoke(['delegate', 'outside/second'], absent, { home: place.home })).toBe(0);
    expect(absent.out).toBe('revoke: unchanged\n');
  });

  test('an absent delegate leaves an existing delegate section byte for byte', async () => {
    const original = BASE + DELEGATES;
    const place = folder(original);
    expect((await edit(place, { kind: 'revoke-delegate', pane: 'outside/missing' })).result).toBe('ok');
    expect(textAt(place)).toBe(original);
  });

  test('all four edit kinds preview without changing file bytes or creating state', async () => {
    const original = BASE + GRANT + DELEGATES;
    const actions: AuthorityEdit[] = [
      { kind: 'grant', seat: 'lead', scope: ['reload'] },
      { kind: 'delegate', pane: 'outside/first', commands: ['swap'] },
      { kind: 'revoke-grant' },
      { kind: 'revoke-delegate', pane: 'outside/first' },
    ];
    for (const action of actions) {
      const place = folder(original);
      const before = fs.readdirSync(dirname(place.file));
      const preview = await edit(place, action, true);
      expect(preview.result).toBe('ok');
      expect(preview.io.out).toContain(': would change\n');
      expect(textAt(place)).toBe(original);
      expect(fs.readdirSync(dirname(place.file))).toEqual(before);
      expect(fs.readdirSync(place.home)).toEqual([]);
    }
  });
});

describe('record validation is shared with the team file', () => {
  const badEdits: { name: string; edit: AuthorityEdit }[] = [
    { name: 'empty grant scope', edit: { kind: 'grant', seat: 'lead', scope: [] } },
    { name: 'duplicate grant scope', edit: { kind: 'grant', seat: 'lead', scope: ['up', 'up'] } },
    { name: 'unknown grant scope', edit: { kind: 'grant', seat: 'lead', scope: ['grant'] } },
    { name: 'empty comma-separated scope member', edit: { kind: 'grant', seat: 'lead', scope: ['up', ''] } },
    { name: 'wrong grant seat', edit: { kind: 'grant', seat: 'helper', scope: ['up'] } },
    { name: 'same-session delegate', edit: { kind: 'delegate', pane: 'arena/external', commands: ['up'] } },
    { name: 'empty delegate commands', edit: { kind: 'delegate', pane: 'outside/first', commands: [] } },
    { name: 'duplicate delegate commands', edit: { kind: 'delegate', pane: 'outside/first', commands: ['up', 'up'] } },
    { name: 'unknown delegate command', edit: { kind: 'delegate', pane: 'outside/first', commands: ['delegate'] } },
    { name: 'empty delegate command member', edit: { kind: 'delegate', pane: 'outside/first', commands: ['up', ''] } },
    { name: 'missing delegate session', edit: { kind: 'delegate', pane: '/first', commands: ['up'] } },
    { name: 'too many target components', edit: { kind: 'delegate', pane: 'outside/first/extra', commands: ['up'] } },
    { name: 'whitespace target', edit: { kind: 'delegate', pane: 'outside/first second', commands: ['up'] } },
    { name: 'malformed revoke target', edit: { kind: 'revoke-delegate', pane: 'outside' } },
  ];
  test.each(badEdits)('$name refuses without writing', async ({ edit: action }) => {
    const original = BASE + GRANT + DELEGATES;
    const place = folder(original);
    const result = await edit(place, action);
    expect(result.result).toBe('invalid');
    expect(result.io.err).not.toBe('');
    expect(result.io.out).toBe('');
    expect(textAt(place)).toBe(original);
  });

  test('a ninth delegate refuses, while replacing one of eight is valid', async () => {
    const entries = Array.from({ length: 8 }, (_, index) => `  - pane: outside/member-${index}\n    commands: [up]\n`).join('');
    const original = BASE + 'delegates:\n' + entries;
    const place = folder(original);
    expect((await edit(place, { kind: 'delegate', pane: 'outside/ninth', commands: ['up'] })).result).toBe('invalid');
    expect(textAt(place)).toBe(original);
    expect((await edit(place, { kind: 'delegate', pane: 'outside/member-3', commands: ['down'] })).result).toBe('ok');
    expect(parsed(textAt(place)).delegates).toHaveLength(8);
    expect(parsed(textAt(place)).delegates?.[3]?.commands).toEqual(['down']);
  });

  test('a block-scalar key spoof is an invalid file and cannot be rewritten', async () => {
    const original = BASE.replace("  - 'grant: is prose, not the grant key'", '  - |\n    grant:\n      scope: [up]');
    const place = folder(original);
    const result = await edit(place, { kind: 'grant', seat: 'lead', scope: ['up'] });
    expect(result.result).toBe('invalid');
    expect(result.io.err).toContain('block scalars');
    expect(textAt(place)).toBe(original);
  });

  test('an invalid current grant cannot be repaired through an edit that skips loading validation', async () => {
    const original = BASE + GRANT.replace('seat: lead', 'seat: helper');
    const place = folder(original);
    expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['up'] })).result).toBe('invalid');
    expect(textAt(place)).toBe(original);
  });

  test('invalid previews still refuse rather than reporting a would-change success', async () => {
    const place = folder();
    const preview = await edit(place, { kind: 'grant', seat: 'lead', scope: ['unknown'] }, true);
    expect(preview.result).toBe('invalid');
    expect(preview.io.out).toBe('');
    expect(textAt(place)).toBe(BASE);
  });
});

describe('only the owner can manage authority', () => {
  const actions: AuthorityEdit[] = [
    { kind: 'grant', seat: 'lead', scope: ['up'] },
    { kind: 'delegate', pane: 'outside/first', commands: ['up'] },
    { kind: 'revoke-grant' },
    { kind: 'revoke-delegate', pane: 'outside/first' },
  ];
  const callers: Caller[] = [
    { kind: 'owner-no-tty' },
    { kind: 'seat', name: 'lead', pane: 'synthetic-lead', session: 'arena' },
    { kind: 'pane', pane: 'first', session: 'outside' },
    { kind: 'unplaced', reason: 'its ancestry is unknown' },
  ];
  test('seats, delegates, no-terminal and unknown callers cannot issue, replace, revoke or preview', async () => {
    const place = folder(BASE + GRANT + DELEGATES);
    for (const caller of callers) {
      for (const action of actions) {
        for (const dryRun of [false, true]) {
          const io = testIo(place.root, caller);
          const command = action.kind.startsWith('revoke') ? 'revoke' : action.kind === 'grant' ? 'grant' : 'delegate';
          expect(await runAuthorityEdit(command, action, io, { home: place.home, dryRun })).toBe('refused');
          expect(io.err).toContain('only the owner');
          expect(io.out).toBe('');
        }
      }
    }
    expect(textAt(place)).toBe(BASE + GRANT + DELEGATES);
  });

  test('real ancestry walk refuses agent descendants and herdr without reading the team file or panes', async () => {
    const place = folder(BASE + GRANT + DELEGATES);
    const cases: { ancestors: Process[] | null; tty: boolean; env?: Record<string, string> }[] = [
      { ancestors: [{ pid: 20, name: 'zsh' }, { pid: 10, name: 'codex' }, { pid: 1, name: 'launchd' }], tty: true },
      { ancestors: [{ pid: 20, name: 'zsh' }, { pid: 10, name: 'herdr' }, { pid: 1, name: 'launchd' }], tty: true },
      { ancestors: [{ pid: 20, name: 'zsh' }, { pid: 1, name: 'launchd' }], tty: false },
      { ancestors: [{ pid: 20, name: 'zsh' }, { pid: 1, name: 'launchd' }], tty: true, env: { AGENT_UNATTENDED: '1' } },
      { ancestors: null, tty: true },
    ];
    const originalRead = fs.readFileSync;
    const reads: string[] = [];
    const watched = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      reads.push(String(args[0]));
      return originalRead(...args);
    }) as typeof fs.readFileSync);
    try {
      for (const scene of cases) {
        const io = testIo(place.root);
        io.stdinIsTTY = scene.tty;
        io.callerSources = (session) => {
          expect(session).toBeUndefined();
          return {
            ancestors: () => scene.ancestors,
            agents: () => { throw new Error('must not list panes'); },
            paneRootPid: () => { throw new Error('must not read a pane'); },
            env: scene.env ?? {},
            stdinIsTTY: scene.tty,
          };
        };
        expect(await runAuthorityEdit('grant', actions[0]!, io, { home: place.home })).toBe('refused');
        expect(io.err).toContain('only the owner');
      }
      expect(reads).toEqual([]);
    } finally {
      watched.mockRestore();
    }
  });
});

describe('file replacement refuses links, interference and failed writes', () => {
  test('a file symlink is refused and its target is untouched, including in a git repository', async () => {
    const place = folder();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: place.root, stdio: 'ignore' });
    const target = join(place.root, 'target.yaml');
    fs.renameSync(place.file, target);
    fs.symlinkSync(target, place.file);
    expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['up'] })).result).toBe('invalid');
    expect(fs.lstatSync(place.file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(BASE);
  });

  test('a linked .agents directory is refused without touching its target', async () => {
    const place = folder();
    const target = join(place.root, 'elsewhere');
    fs.renameSync(dirname(place.file), target);
    fs.symlinkSync(target, dirname(place.file));
    expect((await edit(place, { kind: 'grant', seat: 'lead', scope: ['up'] })).result).toBe('invalid');
    expect(fs.readFileSync(join(target, 'team.yaml'), 'utf8')).toBe(BASE);
  });

  test('a concurrent edit survives and is reported as a refusal', async () => {
    const place = folder();
    const newer = BASE + '# another owner edit\n';
    const io = owner(place);
    expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up'] }, io, {
      home: place.home,
      beforeWrite: () => fs.writeFileSync(place.file, newer),
    })).toBe('refused');
    expect(textAt(place)).toBe(newer);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/changed|concurrent/i);
  });

  test('replacing the file with a symlink during the edit refuses without following it', async () => {
    const place = folder();
    const target = join(place.root, 'target.yaml');
    fs.writeFileSync(target, BASE + '# separate target\n');
    const io = owner(place);
    expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up'] }, io, {
      home: place.home,
      beforeWrite: () => {
        fs.renameSync(place.file, join(place.root, 'original.yaml'));
        fs.symlinkSync(target, place.file);
      },
    })).toBe('refused');
    expect(fs.lstatSync(place.file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(BASE + '# separate target\n');
    expect(io.out).toBe('');
  });

  test('a preexisting temporary directory refuses without changing the live file', async () => {
    const place = folder();
    fs.mkdirSync(`${place.file}.${process.pid}.tmp`);
    const io = owner(place);
    expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up'] }, io, { home: place.home })).toBe('refused');
    expect(textAt(place)).toBe(BASE);
    expect(io.out).toBe('');
    expect(io.err).not.toBe('');
  });

  test('an atomic writer error is caught and leaves the live file intact', async () => {
    const place = folder();
    const temporary = `${place.file}.${process.pid}.tmp`;
    const originalWrite = fs.writeFileSync;
    let attempted = false;
    const failing = spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === temporary) {
        attempted = true;
        throw new Error('synthetic atomic write failure');
      }
      return originalWrite(...args);
    }) as typeof fs.writeFileSync);
    try {
      const io = owner(place);
      expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up'] }, io, { home: place.home })).toBe('refused');
      expect(attempted).toBe(true);
      expect(textAt(place)).toBe(BASE);
      expect(io.out).toBe('');
      expect(io.err).toContain('synthetic atomic write failure');
    } finally {
      failing.mockRestore();
    }
  });

  test('a linked atomic temporary file cannot overwrite its target or become the live file', async () => {
    const place = folder();
    const target = join(place.root, 'other-owner-file');
    fs.writeFileSync(target, 'untouched owner data\n');
    fs.symlinkSync(target, `${place.file}.${process.pid}.tmp`);
    const io = owner(place);
    expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up'] }, io, { home: place.home })).toBe('refused');
    expect(textAt(place)).toBe(BASE);
    expect(fs.lstatSync(place.file).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched owner data\n');
    expect(io.out).toBe('');
  });

  test('preview and no-op never enter the write seam', async () => {
    const place = folder(BASE + GRANT);
    const beforeWrite = () => { throw new Error('must not enter a write path'); };
    expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up'] }, owner(place), {
      home: place.home, dryRun: true, beforeWrite,
    })).toBe('ok');
    expect(await runAuthorityEdit('grant', { kind: 'grant', seat: 'lead', scope: ['up', 'down'] }, owner(place), {
      home: place.home, beforeWrite,
    })).toBe('ok');
    expect(textAt(place)).toBe(BASE + GRANT);
  });
});

describe('grant and revoke parse the invocation before attempting an edit', () => {
  test('grant requires one seat and a scope, and does not accept authority or file overrides', async () => {
    const place = folder();
    for (const argv of [[], ['lead'], ['lead', '--scope'], ['lead', '--scope', 'up', 'extra'],
      ['lead', '--scope', 'up', '--file', 'elsewhere'], ['lead', '--scope', 'up', '--session', 'elsewhere']]) {
      const io = testIo(place.root, { kind: 'owner-no-tty' });
      expect(await runGrant(argv, io, { home: place.home })).toBe(2);
      expect(io.err).toContain('Usage: team grant');
    }
    expect(textAt(place)).toBe(BASE);
  });

  test('grant keeps duplicate and empty comma-separated scope members for validation', async () => {
    const place = folder();
    for (const value of ['up,up', 'up,', ',up', 'up,,down', 'up,unknown']) {
      const io = owner(place);
      expect(await runGrant(['lead', '--scope', value], io, { home: place.home })).toBe(2);
      expect(textAt(place)).toBe(BASE);
    }
  });

  test('a repository with no team file gets the loader refusal, never a raw lstat', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'team-authority-edit-no-file-')));
    made.push(root);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    const home = join(root, 'home');
    fs.mkdirSync(home);
    const place: Place = { root, home, file: join(root, '.agents', 'team.yaml') };

    for (const run of [
      (io: TestIo) => runGrant(['lead', '--scope', 'up'], io, { home }),
      (io: TestIo) => runDelegate(['outside/first', '--commands', 'up'], io, { home }),
      (io: TestIo) => runRevoke(['grant'], io, { home }),
    ]) {
      const io = owner(place);
      expect(await run(io)).toBe(2);
      expect(io.err).toContain('no team file here');
      expect(io.err).not.toContain('ENOENT');
      expect(io.err).not.toContain('lstat');
    }

    const json = owner(place);
    expect(await runGrant(['lead', '--scope', 'up', '--json'], json, { home })).toBe(2);
    expect(json.err).toBe('');
    assertJsonErrorShape(json.out, { id: 'grant.invalid', messageContains: 'no team file here', repair: null });
  });

  test('revoke requires an exact kind and target without a wildcard or all form', async () => {
    const place = folder(BASE + GRANT + DELEGATES);
    for (const argv of [[], ['all'], ['grant', 'lead'], ['delegate'], ['delegate', 'outside/first', 'extra'], ['grant', '--all']]) {
      const io = testIo(place.root, { kind: 'owner-no-tty' });
      expect(await runRevoke(argv, io, { home: place.home })).toBe(2);
      expect(io.err).toContain('Usage: team revoke');
    }
    expect(textAt(place)).toBe(BASE + GRANT + DELEGATES);
  });

  test('refusal output does not forward terminal controls from invalid arguments', async () => {
    const place = folder();
    const io = owner(place);
    expect(await runGrant(['lead', '--scope', '\u001b[31munknown\u001b[0m'], io, { home: place.home })).toBe(2);
    expect(io.err).toContain('unknown');
    expect(io.err).not.toContain('\u001b');
  });

  test('--json emits schema-valid envelopes and error envelopes on grant, delegate, and revoke', async () => {
    const place = folder();

    const grantDry = owner(place);
    expect(await runGrant(['lead', '--scope', 'up,down', '--dry-run', '--json'], grantDry, { home: place.home })).toBe(0);
    expect(grantDry.err).toBe('');
    const grantDryDoc = assertMatchesOutputSchema(grantDry.out, GRANT_OUTPUT_SCHEMA);
    expect(grantDryDoc).toMatchObject({
      dry_run: true,
      status: 'dry-run',
      action_summary: 'grant: would change',
      project: 'beacon',
      session: 'arena',
      target: 'lead',
      scope: ['up', 'down'],
    });

    const grantWrite = owner(place);
    expect(await runGrant(['lead', '--scope', 'up,down', '--json'], grantWrite, { home: place.home })).toBe(0);
    const grantWriteDoc = assertMatchesOutputSchema(grantWrite.out, GRANT_OUTPUT_SCHEMA);
    expect(grantWriteDoc).toMatchObject({
      dry_run: false,
      status: 'updated',
      action_summary: 'grant: updated',
      target: 'lead',
      scope: ['up', 'down'],
    });

    upsertTeam(place.home, teamIdOf(place.root), { project: 'beacon', session: 'arena', root: place.root });
    const teamTrustDry = owner(place);
    expect(await runGrant(['@team', '--capabilities', 'dialogs.trust', '--dry-run', '--json'], teamTrustDry, { home: place.home })).toBe(0);
    const teamTrustDoc = assertMatchesOutputSchema(teamTrustDry.out, GRANT_OUTPUT_SCHEMA);
    expect(teamTrustDoc).toMatchObject({
      dry_run: true,
      status: 'dry-run',
      target: '@team',
      capabilities: ['dialogs.trust'],
    });

    const delegateWrite = owner(place);
    expect(await runDelegate(['outside/first', '--commands', 'up,down', '--json'], delegateWrite, { home: place.home })).toBe(0);
    const delegateDoc = assertMatchesOutputSchema(delegateWrite.out, DELEGATE_OUTPUT_SCHEMA);
    expect(delegateDoc).toMatchObject({
      dry_run: false,
      status: 'updated',
      action_summary: 'delegate: updated',
      target: 'outside/first',
      commands: ['up', 'down'],
    });

    const revokeWrite = owner(place);
    expect(await runRevoke(['grant', '--json'], revokeWrite, { home: place.home })).toBe(0);
    const revokeDoc = assertMatchesOutputSchema(revokeWrite.out, REVOKE_OUTPUT_SCHEMA);
    expect(revokeDoc).toMatchObject({
      dry_run: false,
      status: 'updated',
      action_summary: 'revoke: updated',
      target: 'grant',
    });

    for (const [cmd, fn] of [
      ['grant', (io: TestIo, argv: string[]) => runGrant(argv, io, { home: place.home })],
      ['delegate', (io: TestIo, argv: string[]) => runDelegate(argv, io, { home: place.home })],
      ['revoke', (io: TestIo, argv: string[]) => runRevoke(argv, io, { home: place.home })],
    ] as const) {
      const bad = owner(place);
      expect(await fn(bad, ['--nope', '--json'])).toBe(2);
      expect(bad.err).toBe('');
      assertJsonErrorShape(bad.out, { id: `${cmd}.invocation`, messageContains: 'unknown option --nope', repair: null });

      const nonOwner = testIo(place.root, { kind: 'owner-no-tty' });
      const validArgs = cmd === 'grant'
        ? ['lead', '--scope', 'up', '--json']
        : cmd === 'delegate'
          ? ['outside/first', '--commands', 'up', '--json']
          : ['grant', '--json'];
      expect(await fn(nonOwner, validArgs)).toBe(1);
      expect(nonOwner.err).toBe('');
      const parsedErr = assertJsonErrorShape(nonOwner.out, {
        id: `${cmd}.refused`,
        messageContains: 'only the owner runs this, from a terminal outside herdr',
      });
      expect((parsedErr.error as { rule?: string }).rule).toBe('owner-only');
    }
  });
});

describe('revocation reaches the real admission gates', () => {
  function approved(place: Place, text: string): Standing {
    const approval = approvalOf(parsed(text), place.root, new Date('2026-10-01T00:00:00Z'));
    return { kind: 'verified', record: { approval, file: text }, generation: 1, signedAt: approval.approvedAt };
  }

  test('up, down, approve and reload cannot reuse a revoked grant from the older approval', async () => {
    const original = BASE + GRANT.replace('[up, down]', '[up, down, approve, reload]');
    const place = folder(original);
    const stateFile = join(dirname(place.file), 'team.state.json');
    const state = JSON.stringify({
      format: 1,
      sessions: { arena: { seats: { lead: { stage: 'ready', pane: 'synthetic-lead' } }, worktrees: {} } },
    });
    fs.writeFileSync(stateFile, state);
    const standing = approved(place, original);
    const io = testIo(place.root, { kind: 'seat', name: 'lead', pane: 'synthetic-lead', session: 'arena' });
    const sources = { standing: () => standing, approvedCopy: () => original };
    for (const act of ['up', 'down', 'approve', 'reload'] as const) {
      expect(grantGate({ act, io, home: place.home, sources }).kind).toBe('passed');
    }

    expect(await runRevoke(['grant'], owner(place), { home: place.home })).toBe(0);
    expect(parsed(textAt(place)).grant).toBeNull();
    for (const act of ['up', 'down', 'approve', 'reload'] as const) {
      const verdict = grantGate({ act, io, home: place.home, sources });
      expect(verdict.kind).toBe('refused');
      if (verdict.kind === 'refused') {
        // reload reads the live file since #523: a revoked grant is simply absent there, as for up and down.
        expect(verdict.id).toBe(act === 'approve' ? 'grant.not-ordinary' : 'grant.omitted');
      }
    }
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(state);
    expect(fs.readdirSync(place.home)).toEqual([]);
  });

  test('revoked delegates fail acting and read gates while an independent live delegate still acts', async () => {
    const original = BASE + `delegates:
  - pane: outside/first
    commands: [up, down, add, remove, approve]
  - pane: outside/second
    commands: [up, down, add, remove, approve]
`;
    const place = folder(original);
    const standing = approved(place, original);
    const stateFile = join(dirname(place.file), 'team.state.json');
    const state = JSON.stringify({ format: 1, sessions: {} });
    fs.writeFileSync(stateFile, state);
    const sources = {
      standing: () => standing,
      approvedCopy: () => original,
      agents: () => [],
    };
    const input = (which: 'first' | 'second') => ({
      team: parsed(textAt(place)), root: place.root, dir: dirname(place.file), flags: [],
      io: testIo(place.root, { kind: 'pane', pane: which, session: 'outside' }),
      home: place.home, sources,
    });
    for (const command of ['up', 'down', 'add', 'remove', 'approve'] as const) {
      expect(delegateGate({ ...input('first'), command }).kind).toBe('passed');
    }
    expect(delegateReadGate(input('first'))).toBe(true);

    expect(await runRevoke(['delegate', 'outside/first'], owner(place), { home: place.home })).toBe(0);
    for (const command of ['up', 'down', 'add', 'remove', 'approve'] as const) {
      expect(delegateGate({ ...input('first'), command }).kind).toBe('refused');
    }
    expect(delegateReadGate(input('first'))).toBe(false);
    expect(delegateGate({ ...input('second'), command: 'up' }).kind).toBe('passed');
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(state);
    expect(fs.readdirSync(place.home)).toEqual([]);
  });
});

describe('under the registry source', () => {
  test('grant, delegate and revoke edit the registry record and leave the file as it was', async () => {
    const place = folder();
    intoRegistry(place.root, place.home);
    await underRegistry(async () => {
      const granted = owner(place);
      expect(await runGrant(['lead', '--scope', 'up,down'], granted, { home: place.home })).toBe(0);
      expect(granted.out).toBe('grant: updated\n');
      expect(parsed(storedTeam(place.root, place.home)!.text).grant).toEqual({ session: 'arena', seat: 'lead', scope: ['up', 'down'] });
      expect(storedTeam(place.root, place.home)!.edited_by).toBe('grant');

      const { result: delegated } = await edit(place, { kind: 'delegate', pane: 'outside/first', commands: ['up'] });
      expect(delegated).toBe('ok');
      expect(parsed(storedTeam(place.root, place.home)!.text).delegates).toEqual([{ pane: 'outside/first', commands: ['up'] }]);

      const revoked = owner(place);
      expect(await runRevoke(['grant'], revoked, { home: place.home })).toBe(0);
      expect(parsed(storedTeam(place.root, place.home)!.text).grant ?? null).toBeNull();
    });
    expect(textAt(place)).toBe(BASE);
    expect(realRegistryTouched()).toBe(false);
  });
});
