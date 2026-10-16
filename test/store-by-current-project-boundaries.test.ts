// The other sides of reading the current project's approval store. The builder's rows
// pin the rename's main rungs — the current folder read, the earlier one named and left
// in place, both sort orders, several stores not guessed, a linked team file not a
// project. These are the edges around them: the only matching folder holding a ledger
// and no approval is a store that approves nothing; a broken record in the current
// folder is refused with no silent fallback to the other matching store; a root with no
// team file at all does not guess between approvals either; and the overrides file
// follows the store in force through a rename, then moves with the next approval.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { overridesPath } from '../src/profiles/overrides.ts';
import {
  approvalStanding,
  findStore,
  otherMatchingStores,
  storePath,
  writeApproval,
  type Approval,
} from '../src/store/store.ts';

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'team-store-current-')));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const opus = { display: 'Claude Opus 5.5', role: 'implementer', model: 'Claude Opus', version: '5.5' };

function approval(root: string): Approval {
  return {
    format: 2,
    approvedAt: '2026-10-03T14:02:00Z',
    root,
    fingerprints: { sections: { rules: 'a' }, seats: { one: 'b' } },
    ceilings: { seats: 6, temporary: 2, vendors: { openai: 1 } },
  };
}

function projectFile(root: string, project: string | null): string {
  mkdirSync(join(root, '.agents'), { recursive: true });
  const text = project === null ? 'format: 1\n' : `format: 1\nproject: ${project}\n`;
  writeFileSync(join(root, '.agents', 'team.yaml'), text);
  return text;
}

function approve(project: string, root: string, file: string): string {
  const store = storePath(project, root, home);
  writeApproval(store, { approval: approval(root), file }, [opus], home);
  return store;
}

describe('the only matching folder', () => {
  test('holds a ledger and no approval: a store that approves nothing, not a crash', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, 'beta');
    const store = storePath('beta', root, home);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'team.log'), '2026-10-03T14:02:00Z | a line\n');
    expect(findStore(root, home)).toBe(store);
    expect(approvalStanding(root, home).kind).toBe('none');
    expect(otherMatchingStores(root, home)).toEqual([]);
  });
});

describe('a broken record in the current folder', () => {
  test('is refused, with no fallback to the other matching store', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    const text = projectFile(root, 'beta');
    const oldStore = approve('alpha', root, text);
    const current = approve('beta', root, text);
    // Tamper with the current project's own record after it was written.
    const record = JSON.parse(readFileSync(join(current, 'approval.json'), 'utf8')) as Record<string, unknown>;
    record.approval = { ...(record.approval as object), root: '/another/root' };
    writeFileSync(join(current, 'approval.json'), JSON.stringify(record));
    expect(findStore(root, home)).toBe(current);
    const standing = approvalStanding(root, home);
    expect(standing.kind).toBe('refused');
    if (standing.kind === 'refused') expect(standing.why).toContain('the record does not carry a valid signature');
    expect(otherMatchingStores(root, home)).toEqual([basename(oldStore)]);
  });
});

describe('a root with no team file naming a project', () => {
  test('two approvals are still not guessed between', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    projectFile(root, null);
    const alpha = approve('alpha', root, 'format: 1\n');
    const gamma = approve('gamma', root, 'format: 1\n');
    expect(findStore(root, home)).toBeNull();
    expect(approvalStanding(root, home).kind).toBe('none');
    expect(otherMatchingStores(root, home)).toEqual([basename(alpha), basename(gamma)].sort());
  });
});

describe('the overrides file follows the store in force', () => {
  test('found under the earlier name after a rename, and moved by the next approval', () => {
    const root = join(home, 'repo');
    mkdirSync(root);
    const text = projectFile(root, 'beta');
    const oldStore = approve('alpha', root, text);
    writeFileSync(join(oldStore, 'overrides.yaml'), '- match: "Opus 5.5"\n  effort: high\n');
    // A rename that has not been approved again: the overrides stay in force with the
    // approval they came with.
    expect(overridesPath('beta', root, home)).toBe(join(oldStore, 'overrides.yaml'));
    expect(readFileSync(overridesPath('beta', root, home), 'utf8')).toContain('effort: high');
    // The next approval is written under the current project's own folder, and the
    // overrides are read from there from then on.
    const current = approve('beta', root, text);
    expect(overridesPath('beta', root, home)).toBe(join(current, 'overrides.yaml'));
    expect(readFileSync(join(oldStore, 'overrides.yaml'), 'utf8')).toContain('effort: high');
  });
});
