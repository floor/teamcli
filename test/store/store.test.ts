import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalDifferences, approvalOf } from '../../src/approve/approval.ts';
import { legacySeatDigests } from '../../src/approve/fingerprint.ts';
import { validateTeamFile } from '../../src/file/validate.ts';
import {
  approvalStanding,
  approvedCopy,
  findStore,
  mergeLedger,
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
