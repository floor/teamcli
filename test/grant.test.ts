import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { approvalOf, approvedFingerprints } from '../src/approve/approval.ts';
import { compare, describe as describeDifference, fingerprints } from '../src/approve/fingerprint.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { ORDINARY_SECTIONS } from '../src/delegate.ts';
import { GRANT_SCOPES, type LoadResult } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { grantGate } from '../src/grant.ts';
import type { Io } from '../src/io.ts';
import type { ApprovalRecord, Standing } from '../src/store/store.ts';

const BASE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

const GRANT = `grant:
  session: acme
  seat: lead
  scope:
    - up
    - down
    - approve
    - init
`;

const GRANTED = BASE + GRANT;

function teamOf(text: string) {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.team;
}

function messages(text: string): string[] {
  const checked = validateTeamFile(text);
  return checked.ok ? [] : checked.errors.map((error) => error.message);
}

function recordOf(text: string, dropGrant: boolean): ApprovalRecord {
  const approval = approvalOf(teamOf(text), '/grant/root');
  if (dropGrant) delete approval.fingerprints.sections.grant;
  return { approval, file: text };
}

describe('grant validation', () => {
  test('an omitted section is null, and a complete section keeps the file\'s order', () => {
    expect(teamOf(BASE).grant).toBeNull();
    expect(teamOf(GRANTED).grant).toEqual({
      session: 'acme',
      seat: 'lead',
      scope: ['up', 'down', 'approve', 'init'],
    });
    expect(GRANT_SCOPES).toEqual(['up', 'down', 'approve', 'init', 'swap']);
  });

  test('session, seat and scope are the closed fields', () => {
    expect(messages(BASE + 'grant:\n  session: side\n  seat: lead\n  scope: [up]\n')).toContain(
      'grant.session must be the file\'s session "acme": "side"',
    );
    expect(messages(BASE + 'grant:\n  session: acme\n  seat: helper\n  scope: [up]\n')).toContain(
      'grant.seat must name the orchestrator "lead": "helper"',
    );
    expect(messages(BASE + 'grant:\n  session: acme\n  seat: lead\n  scope: []\n')).toContain(
      'grant.scope must name at least one of: up, down, approve, init, swap',
    );
    expect(messages(BASE + 'grant:\n  session: acme\n  seat: lead\n  scope: [up, up]\n')).toContain(
      'grant.scope names "up" twice',
    );
    expect(messages(BASE + 'grant:\n  session: acme\n  seat: lead\n  scope: [worktree]\n')).toContain(
      'grant.scope must name up, down, approve, init, swap: "worktree" is not one',
    );
    expect(messages(BASE + 'grant:\n  session: acme\n  seat: lead\n  scope: up\n')).toContain(
      'grant.scope must be a list',
    );
    expect(messages(BASE + 'grant:\n  session: acme\n  seat: lead\n  scope: [up]\n  path: ../out\n')).toContain(
      'unknown field "path" in grant',
    );
    expect(messages(BASE + 'grant:\n  - up\n')).toContain('grant must be a map of fields');
  });
});

describe('the grant fingerprint baseline', () => {
  test('a record written before the section matches a file that omits it, and differs once the file adds it', () => {
    const older = recordOf(BASE, true);
    expect(older.approval.fingerprints.sections.grant).toBeUndefined();
    expect(compare(approvedFingerprints(older), fingerprints(teamOf(BASE)))).toEqual([]);
    expect(compare(approvedFingerprints(older), fingerprints(teamOf(GRANTED))).map(describeDifference)).toEqual([
      '`grant` changed',
    ]);
  });

  test('a signed grant matches, and a reordered scope differs', () => {
    const signed = recordOf(GRANTED, false);
    expect(compare(approvedFingerprints(signed), fingerprints(teamOf(GRANTED)))).toEqual([]);
    const reordered = GRANTED.replace('    - up\n    - down\n', '    - down\n    - up\n');
    expect(compare(approvedFingerprints(signed), fingerprints(teamOf(reordered))).map(describeDifference)).toEqual([
      '`grant` changed',
    ]);
  });
});

function seat(name: string, pane: string, session: string): Caller {
  return { kind: 'seat', name, pane, session };
}

function io(caller: Caller, cwd = '/grant'): Io {
  return { stdout() {}, stderr() {}, cwd, env: {}, stdinIsTTY: true, caller };
}

/** The state folder the gate reads, with a pane recorded for each named seat. An absent pane
 *  string records the seat with no pane. */
function stateDir(sessions: Record<string, Record<string, string | undefined>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-grant-state-'));
  const body = {
    format: 1,
    sessions: Object.fromEntries(Object.entries(sessions).map(([session, seats]) => [
      session,
      {
        seats: Object.fromEntries(Object.entries(seats).map(([name, pane]) => [
          name,
          pane === undefined ? { stage: 'ready' } : { stage: 'ready', pane },
        ])),
        worktrees: {},
      },
    ])),
  };
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify(body));
  return dir;
}

function standingOf(text: string, dropGrant = false): Standing {
  const record = recordOf(text, dropGrant);
  return { kind: 'verified', record, generation: 1, signedAt: record.approval.approvedAt };
}

function ask(
  act: 'up' | 'down' | 'approve' | 'init',
  live: string | ReturnType<typeof teamOf>,
  approved: string,
  caller: Caller,
  sessions: Record<string, Record<string, string | undefined>>,
  dropGrant = false,
) {
  const dir = stateDir(sessions);
  const team = typeof live === 'string' ? teamOf(live) : live;
  const text = typeof live === 'string' ? live : approved;
  const load = (): LoadResult => ({ ok: true, team, root: '/grant/root', path: join(dir, 'team.yaml'), warnings: [], text });
  return grantGate({
    act,
    io: io(caller),
    home: mkdtempSync(join(tmpdir(), 'team-grant-home-')),
    sources: {
      load,
      standing: () => standingOf(approved, dropGrant),
      approvedCopy: () => approved,
    },
  });
}

const placed = { acme: { lead: 'alpha' } };

describe('the grant gate', () => {
  test('the ordinary list stays rules, so a grant edit is the owner\'s', () => {
    expect(ORDINARY_SECTIONS).toEqual(['rules']);
    expect(ORDINARY_SECTIONS).not.toContain('grant');
  });

  test('the granted seat, on the pane the state records in the grant\'s session, passes', () => {
    expect(ask('up', GRANTED, GRANTED, seat('lead', 'alpha', 'acme'), placed)).toEqual({
      kind: 'passed',
      grant: { session: 'acme', seat: 'lead', scope: ['up', 'down', 'approve', 'init'] },
    });
  });

  test('a missing act, an omitted grant, an unverified approval and an unreadable copy refuse', () => {
    const narrow = GRANTED.replace('    - down\n    - approve\n    - init\n', '');
    expect(ask('init', narrow, narrow, seat('lead', 'alpha', 'acme'), placed)).toEqual({
      kind: 'refused',
      id: 'grant.scope',
      text: 'the grant does not list `init`',
    });
    expect(ask('up', BASE, BASE, seat('lead', 'alpha', 'acme'), placed, true)).toEqual({
      kind: 'refused',
      id: 'grant.omitted',
      text: 'the approved file grants nothing',
    });
    const dir = stateDir(placed);
    const home = mkdtempSync(join(tmpdir(), 'team-grant-home-'));
    const loaded = teamOf(GRANTED);
    const sources = {
      load: (): LoadResult => ({ ok: true, team: loaded, root: '/grant/root', path: join(dir, 'team.yaml'), warnings: [], text: GRANTED }),
      approvedCopy: () => GRANTED,
    };
    expect(grantGate({
      act: 'up',
      io: io(seat('lead', 'alpha', 'acme')),
      home,
      sources: { ...sources, standing: () => ({ kind: 'none' }) },
    })).toEqual({
      kind: 'refused',
      id: 'grant.approval',
      text: 'a grant needs a verified approval: the file was never approved on this machine: run `team approve`',
    });
    expect(grantGate({
      act: 'up',
      io: io(seat('lead', 'alpha', 'acme')),
      home,
      sources: { ...sources, standing: () => standingOf(GRANTED), approvedCopy: () => null },
    })).toEqual({
      kind: 'refused',
      id: 'grant.approved-copy',
      text: 'a grant needs a readable approved copy: run `team approve`',
    });
  });

  test('placement: another pane, no pane, another session, and the operator\'s name', () => {
    expect(ask('up', GRANTED, GRANTED, seat('lead', 'beta', 'acme'), placed)).toEqual({
      kind: 'refused',
      id: 'grant.another-pane',
      text: anotherPaneRefusal('lead', 'alpha'),
    });
    expect(ask('up', GRANTED, GRANTED, seat('lead', 'alpha', 'acme'), { acme: { lead: undefined } })).toEqual({
      kind: 'refused',
      id: 'grant.no-pane',
      text: noPaneRefusal('lead'),
    });
    // The caller stands in a second session the state also records for this seat. The grant's
    // session is the file's session, so that second session does not admit the call.
    expect(ask('up', GRANTED, GRANTED, seat('lead', 'alpha', 'side'), {
      acme: { lead: 'alpha' },
      side: { lead: 'alpha' },
    })).toEqual({
      kind: 'refused',
      id: 'grant.caller',
      text: 'only the seat the grant names runs this: this call is lead',
    });
    const two = BASE.replace('operator: lead', 'operator: helper').replace(
      '    launch: claude --model claude-opus-5-5\n',
      `    launch: claude --model claude-opus-5-5
  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`,
    ) + GRANT;
    expect(ask('up', two, two, seat('helper', 'beta', 'acme'), { acme: { lead: 'alpha', helper: 'beta' } })).toEqual({
      kind: 'refused',
      id: 'grant.caller',
      text: 'only the seat the grant names runs this: this call is helper',
    });
  });

  test('an unsigned grant edit is invisible: up drifts, and approve names the owner', () => {
    const added = ask('up', GRANTED, BASE, seat('lead', 'alpha', 'acme'), placed, true);
    expect(added).toEqual({
      kind: 'refused',
      id: 'grant.drift',
      text: 'a grant needs the approved file: the file is not the approved one (`grant` changed): run `team approve`',
    });
    const narrowed = { ...teamOf(GRANTED), grant: { session: 'acme', seat: 'lead', scope: ['up' as const] } };
    expect(ask('approve', narrowed, GRANTED, seat('lead', 'alpha', 'acme'), placed)).toEqual({
      kind: 'refused',
      id: 'grant.not-ordinary',
      text: 'this change needs the owner: `grant` changed',
    });
    const trusted = { ...teamOf(GRANTED), trust: [...teamOf(GRANTED).trust, '/tmp/grant-trust'] };
    expect(ask('approve', trusted, GRANTED, seat('lead', 'alpha', 'acme'), placed)).toEqual({
      kind: 'refused',
      id: 'grant.not-ordinary',
      text: 'this change needs the owner: `trust` changed',
    });
  });

  test('an ordinary rules edit passes when approve is in scope', () => {
    const edited = { ...teamOf(GRANTED), rules: ['Keep the tests.'] };
    expect(ask('approve', edited, GRANTED, seat('lead', 'alpha', 'acme'), placed)).toEqual({
      kind: 'passed',
      grant: { session: 'acme', seat: 'lead', scope: ['up', 'down', 'approve', 'init'] },
    });
  });

  test('with no injected load, the read is the working folder\'s own file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'team-grant-live-'));
    mkdirSync(join(cwd, '.agents'));
    writeFileSync(join(cwd, '.agents', 'team.yaml'), BASE);
    const home = mkdtempSync(join(tmpdir(), 'team-grant-home-'));
    expect(grantGate({
      act: 'up',
      io: { ...io(seat('lead', 'alpha', 'acme')), cwd },
      home,
    })).toEqual({
      kind: 'refused',
      id: 'grant.approval',
      text: 'a grant needs a verified approval: the file was never approved on this machine: run `team approve`',
    });
  });
});
