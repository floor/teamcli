import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { legacySeatDigests } from '../../src/approve/fingerprint.ts';
import { loadConfig } from '../../src/check/load.ts';
import { runApprove } from '../../src/approve/command.ts';
import { runDoctor, type DoctorSources } from '../../src/commands/doctor.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import { testIo } from '../helpers.ts';
import { writeTextSignedApproval } from '../helpers/text-signed-approval.ts';
import {
  approvalStanding,
  approvedCopy,
  findStore,
  mergeLedger,
  otherMatchingStores,
  otherStoreNote,
  readApproval,
  readLedger,
  storePath,
  writeApproval,
  type Approval,
} from '../../src/store/store.ts';

// A stored copy is signed over its canonical team record, so it must be a team file.
const TEAM = readFileSync(join(import.meta.dir, '..', 'fixtures', 'example.yaml'), 'utf8');
const TEAM_B = TEAM.replace('Run the tests your change touches', 'Run the tests your change affects');

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'team-store-')));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const opus = { display: 'Claude Opus 5.5', role: 'implementer', model: 'Claude Opus', version: '5.5' };
const sol = { display: 'GPT-6 Sol', role: 'reviewer', model: 'GPT Sol', version: '6' };

function approval(root: string): Approval {
  return {
    format: 2,
    approvedAt: '2026-10-03T14:02:00Z',
    root,
    fingerprints: { sections: { rules: 'a' }, seats: { one: 'b' } },
    ceilings: { seats: 6, temporary: 2, vendors: { openai: 1 } },
  };
}

describe('the store path', () => {
  test('is under the home folder, named for the project and its root', () => {
    const root = join(home, 'acme-web');
    mkdirSync(root);
    expect(storePath('acme-web', root, home)).toMatch(new RegExp(`^${home}/\\.config/team/acme-web-[0-9a-f]{12}$`));
  });

  test('a moved project has another store', () => {
    const root = join(home, 'acme-web');
    mkdirSync(root);
    const before = storePath('acme-web', root, home);
    renameSync(root, join(home, 'acme-web-2'));
    expect(storePath('acme-web', join(home, 'acme-web-2'), home)).not.toBe(before);
  });

  test('a project name can never leave the store', () => {
    expect(storePath('../../etc', home, home)).toMatch(/\/\.config\/team\/\.\._\.\._etc-[0-9a-f]{12}$/);
  });
});

describe('an approval', () => {
  test('is absent until the owner writes one', () => {
    expect(readApproval(join(home, 'nowhere'))).toBeNull();
    expect(readLedger(join(home, 'nowhere'))).toEqual([]);
  });

  test('is read back with the approved copy, and fills the ledger', () => {
    const store = storePath('acme-web', home, home);
    writeApproval(store, { approval: approval(home), file: TEAM }, [opus, sol], home);
    // The read-back carries the signing: a generation, and the signature over it.
    expect(readApproval(store)).toMatchObject({ approval: approval(home), file: TEAM, generation: 1 });
    expect(typeof readApproval(store)?.signature).toBe('string');
    expect(readLedger(store)).toEqual([opus, sol]);
  });

  test('leaves no temporary file, and is private to the user', () => {
    const store = storePath('acme-web', home, home);
    writeApproval(store, { approval: approval(home), file: TEAM }, [opus], home);
    expect(readdirSync(store).sort()).toEqual(['approval.json', 'approved.yaml', 'ledger.json']);
    expect(statSync(store).mode & 0o777).toBe(0o700);
    expect(statSync(join(store, 'approval.json')).mode & 0o777).toBe(0o600);
  });

  test('a second approval keeps the seats the team has had', () => {
    const store = storePath('acme-web', home, home);
    writeApproval(store, { approval: approval(home), file: TEAM }, [opus], home);
    writeApproval(store, { approval: approval(home), file: TEAM_B }, [sol], home);
    expect(readLedger(store)).toEqual([opus, sol]);
    expect(readApproval(store)?.file).toBe(TEAM_B);
  });

  test('a record of another format is refused', () => {
    const store = storePath('acme-web', home, home);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'approval.json'), '{"format":3}');
    // The strict shape names the field, so no half-record is ever parsed.
    expect(() => readApproval(store)).toThrow('"format" is neither 1 nor 2');
  });

  test('the approved text is in the record itself: one write, never half an approval', () => {
    const store = storePath('acme-web', home, home);
    writeApproval(store, { approval: approval(home), file: TEAM }, [opus], home);
    writeFileSync(join(store, 'approved.yaml'), 'edited by hand\n');
    expect(readApproval(store)?.file).toBe(TEAM);
    expect(approvedCopy(home, home)).toBe(TEAM);
    expect(JSON.parse(readFileSync(join(store, 'approval.json'), 'utf8'))).toMatchObject({
      format: 2,
      file: TEAM,
    });
  });

  test('a record without its copy is a malformed record, not a missing one', () => {
    const store = storePath('acme-web', home, home);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'approval.json'), JSON.stringify(approval(home)));
    // Round 2: the shape is checked whole, so a record that lost its copy is
    // refused — never read as "no approval at all", which reads permissively.
    expect(() => readApproval(store)).toThrow('the record has no "file"');
    expect(approvalStanding(home, home).kind).toBe('refused');
  });
});

describe('the ledger', () => {
  test('adds a seat once, and keeps only the four fields', () => {
    const merged = mergeLedger([opus], [{ ...opus }, { ...sol, name: 'codex-acme' } as typeof sol]);
    expect(merged).toEqual([opus, sol]);
  });

  test('a version change is a new entry', () => {
    const next = { ...opus, display: 'Claude Opus 5.6', version: '5.6' };
    expect(mergeLedger([opus], [next])).toEqual([opus, next]);
  });
});

describe('the approved copy, from the root alone', () => {
  test('is null before any approval', () => {
    expect(findStore(home, home)).toBeNull();
    expect(approvedCopy(home, home)).toBeNull();
  });

  test('is found without the file or the project name', () => {
    const root = join(home, 'acme-web');
    mkdirSync(root);
    const store = storePath('acme-web', root, home);
    writeApproval(store, { approval: approval(root), file: TEAM }, [opus], home);
    expect(findStore(root, home)).toBe(store);
    expect(approvedCopy(root, home)).toBe(TEAM);
    expect(approvedCopy(home, home)).toBeNull();
  });
});

describe('a project rename', () => {
  function projectFile(root: string, project: string) {
    mkdirSync(join(root, '.agents'), { recursive: true });
    writeFileSync(join(root, '.agents', 'team.yaml'), `format: 1\nproject: ${project}\n`);
  }

  function approve(project: string, root: string, file: string) {
    const store = storePath(project, root, home);
    // These fixtures carry bare copies that are no team record; the text-signed compatibility
    // record still verifies, and the scenes are about which store is read, not how it is signed.
    writeTextSignedApproval(store, { approval: approval(root), file }, [opus], home);
    return store;
  }

  test('one store under the previous name is still the approval', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, 'beta');
    const store = approve('alpha', root, 'format: 1\n');
    expect(findStore(root, home)).toBe(store);
    expect(approvalStanding(root, home).kind).toBe('verified');
    expect(otherMatchingStores(root, home)).toEqual([]);
    expect(existsSync(store)).toBe(true);
  });

  test('a ledger-only folder under the current name does not hide that approval', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, 'beta');
    const store = approve('alpha', root, 'format: 1\n');
    mkdirSync(storePath('beta', root, home), { recursive: true });
    expect(findStore(root, home)).toBe(store);
    expect(approvalStanding(root, home).kind).toBe('verified');
  });

  test('the current project\'s store is read, and the earlier one is named and left in place', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, 'beta');
    const oldStore = approve('alpha', root, 'old\n');
    const current = approve('beta', root, 'new\n');
    expect(basename(oldStore) < basename(current)).toBe(true);
    expect(findStore(root, home)).toBe(current);
    const standing = approvalStanding(root, home);
    expect(standing.kind).toBe('verified');
    if (standing.kind === 'verified') expect(standing.record.file).toBe('new\n');
    expect(otherMatchingStores(root, home)).toEqual([basename(oldStore)]);
    expect(existsSync(join(oldStore, 'approval.json'))).toBe(true);
    expect(readdirSync(join(home, '.config', 'team')).sort()).toEqual([basename(oldStore), basename(current)].sort());
  });

  test('the same when the earlier name sorts last', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, 'alpha');
    const oldStore = approve('zeta', root, 'old\n');
    const current = approve('alpha', root, 'new\n');
    expect(basename(current) < basename(oldStore)).toBe(true);
    expect(findStore(root, home)).toBe(current);
    expect(otherMatchingStores(root, home)).toEqual([basename(oldStore)]);
    expect(existsSync(join(oldStore, 'approval.json'))).toBe(true);
  });

  test('several stores, none of them the current project, are named and not read', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, 'beta');
    const alpha = approve('alpha', root, 'a\n');
    const gamma = approve('gamma', root, 'g\n');
    expect(findStore(root, home)).toBeNull();
    expect(approvalStanding(root, home).kind).toBe('none');
    expect(otherMatchingStores(root, home)).toEqual([basename(alpha), basename(gamma)].sort());
    expect(existsSync(join(alpha, 'approval.json'))).toBe(true);
    expect(existsSync(join(gamma, 'approval.json'))).toBe(true);
  });

  test('a linked team file is not the current project, so two stores are not guessed', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    const aside = join(home, 'linked.yaml');
    writeFileSync(aside, 'format: 1\nproject: beta\n');
    mkdirSync(join(root, '.agents'));
    symlinkSync(aside, join(root, '.agents', 'team.yaml'));
    const alpha = approve('alpha', root, 'a\n');
    const beta = approve('beta', root, 'b\n');
    expect(findStore(root, home)).toBeNull();
    expect(otherMatchingStores(root, home)).toEqual([basename(alpha), basename(beta)].sort());
    expect(existsSync(join(alpha, 'approval.json'))).toBe(true);
    expect(existsSync(join(beta, 'approval.json'))).toBe(true);
  });

  test('approve and doctor name the earlier store, and the ledger is read from the one store in force', async () => {
    const root = join(home, 'repo');
    mkdirSync(join(root, '.agents'), { recursive: true });
    const text = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8')
      .replace('project: acme-web\n', 'project: beta\n')
      .replace('../worktrees/acme-web/*', '../worktrees/beta/*');
    writeFileSync(join(root, '.agents', 'team.yaml'), text);
    const checked = validateTeamFile(text, { home, root });
    if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
    const oldStore = storePath('alpha', root, home);
    const current = storePath('beta', root, home);
    const kept = { display: 'Kept From Alpha', role: 'implementer', model: 'Claude Opus', version: '5.5' };
    writeApproval(oldStore, { approval: approvalOf(checked.team, root), file: text }, [kept], home);
    writeApproval(current, { approval: approvalOf(checked.team, root), file: text }, [opus], home);
    const note = otherStoreNote(basename(oldStore));

    const shown = testIo(root, { kind: 'owner' });
    const code = await runApprove(['--show'], shown, {
      ask: async () => null,
      waiting: () => 'empty',
      now: () => new Date('2026-10-15T01:15:00Z'),
      home,
    });
    expect(code).toBe(0);
    expect(shown.out).toContain(`Note: ${note}\n`);
    expect(shown.out).not.toContain('the record is approval #1');
    expect(existsSync(join(oldStore, 'approval.json'))).toBe(true);
    expect(findStore(root, home)).toBe(current);

    const sources: DoctorSources = {
      version: () => '0.0.0',
      onPath: () => true,
      loggedIn: () => true,
      herdrVersion: () => '0.7.1',
      sessionRunning: () => false,
      now: () => new Date('2026-10-15T01:15:00Z'),
      home,
    };
    const diagnosed = testIo(root, { kind: 'owner' });
    await runDoctor([], diagnosed, sources);
    expect(diagnosed.out).toContain(note);
    expect(existsSync(join(oldStore, 'approval.json'))).toBe(true);

    const loaded = loadConfig(root, undefined, home);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors));
    expect(loaded.config.ledger.some((seat) => seat.display === opus.display)).toBe(true);
    expect(loaded.config.ledger.some((seat) => seat.display === kept.display)).toBe(false);
  });
});

describe('a file against its approval', () => {
  const text = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8');

  function team(source: string) {
    const result = validateTeamFile(source);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return result.team;
  }

  function approve(root: string) {
    const file = team(text);
    writeApproval(storePath(file.project, root, home), { approval: approvalOf(file, root), file: text }, file.seats, home);
  }

  test('nothing is approved until the owner approves', () => {
    expect(approvalDifferences(team(text), home, home)).toBeNull();
  });

  test('the approved file passes, comments and layout aside', () => {
    approve(home);
    expect(approvalDifferences(team(text), home, home)).toEqual([]);
    expect(approvalDifferences(team(text.replace('# public | private', '# edited')), home, home)).toEqual([]);
  });

  test('an edited launch line, rule or ceiling is named', () => {
    approve(home);
    const edited = text
      .replace('launch: grok --model grok-4.7', 'launch: grok --model grok-4.7 --yolo')
      .replace('seats: 6 ', 'seats: 9 ')
      .replace(
        '  - Run the tests your change touches',
        '  - Answer every prompt.\n  - Run the tests your change touches',
      );
    expect(approvalDifferences(team(edited), home, home)).toEqual([
      '`limits` changed',
      '`rules` changed',
      'seat grok-acme changed',
    ]);
  });

  test('parking or stopping a seat is drift', () => {
    approve(home);
    const edited = text
      .replace('    stopped: true', '    stopped: false')
      .replace('    parked: true', '    parked: false');
    expect(edited).not.toBe(text);
    expect(approvalDifferences(team(edited), home, home)).toEqual([
      'seat codex-acme changed',
      'seat grok-acme changed',
    ]);
  });

  test('an approval recorded before parked and stopped were fingerprinted still matches the same file', () => {
    approve(home);
    const file = team(text);
    const store = storePath(file.project, home, home);
    const record = readApproval(store);
    if (!record) throw new Error('missing approval');
    record.approval.fingerprints.seats = legacySeatDigests(file);
    writeApproval(store, record, [], home);
    expect(approvalDifferences(file, home, home)).toEqual([]);
    const parked = text.replace('    parked: true', '    parked: false');
    expect(approvalDifferences(team(parked), home, home)).toEqual(['seat codex-acme changed']);
  });

  test('taking one instance out of a count entry needs no new approval', () => {
    approve(home);
    const fewer = text.replace(/\n    count: 2[^\n]*/, '');
    expect(team(fewer).seats.map((seat) => seat.name)).not.toContain('deepseek-acme-2');
    expect(approvalDifferences(team(fewer), home, home)).toEqual([]);
  });

  test('a count entry rewritten as explicit seats needs no new approval', () => {
    approve(home);
    const entry =
      /  - role: implementer\n    name: deepseek-acme\n[\s\S]*?\n    count: 2[^\n]*\n/.exec(text)?.[0] ?? '';
    const one = entry.replace(/    count: 2[^\n]*\n/, '');
    const second = one
      .replace('name: deepseek-acme', 'name: deepseek-acme-2')
      .replace('    name: deepseek-acme-2\n', '    name: deepseek-acme-2\n    label: deepseek flash v4.1-2\n');
    const explicit = text.replace(entry, `${one}\n${second}`);
    expect(explicit).not.toBe(text);
    expect(team(explicit).seats.map((seat) => seat.name)).toEqual(team(text).seats.map((seat) => seat.name));
    expect(approvalDifferences(team(explicit), home, home)).toEqual([]);
  });

  test('an explicit seat that differs from the approved instance is named', () => {
    approve(home);
    const fewer = text.replace(/\n    count: 2[^\n]*/, '\n    count: 3');
    expect(approvalDifferences(team(fewer), home, home)).toEqual(['seat deepseek-acme-3 is not in the last approval']);
  });

  test('the record holds the ceilings and the root', () => {
    const record = approvalOf(team(text), home, new Date('2026-10-03T14:02:00Z'));
    expect(record).toMatchObject({
      format: 2,
      approvedAt: '2026-10-03T14:02:00.000Z',
      root: home,
      ceilings: { seats: 6, temporary: 2, vendors: { openai: 1, deepseek: 3 } },
    });
  });

  test('a moved project is not approved', () => {
    approve(home);
    const moved = join(home, 'elsewhere');
    mkdirSync(moved);
    expect(approvalDifferences(team(text), moved, home)).toBeNull();
  });
});
