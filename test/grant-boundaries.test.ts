import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { approvalOf } from '../src/approve/approval.ts';
import { anotherPaneRefusal, noPaneRefusal, type Caller } from '../src/caller.ts';
import { runStatus, type StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { grantGate, type GrantSources } from '../src/grant.ts';
import type { Io } from '../src/io.ts';
import type { ApprovalRecord, Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

// Adversarial coverage for the orchestrator grant record's gate read. Every placement scene
// drives the real placement walk — the agent list a session answers with, the pane roots the
// caller's process chain descends from, and the pane the state records — never a caller built
// by hand, because a spoof is an attack on the walk, not on the verdict alone. The approval
// store is the one read replaced: the record is what an owner approval of the fixture would
// leave, so a scene can also predate or outdate the section.

const NOW = new Date('2026-10-14T12:00:00Z');
const ROOT = '/adversarial/root';
const ACTS = ['up', 'down', 'approve', 'init'] as const;
type Act = (typeof ACTS)[number];

const LEAD = `  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;
const HELPER = `  - role: implementer
    name: helper
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

function base(seats: string, operator = 'lead'): string {
  return `format: 1
project: adversarial
session: arena
coordinator: lead
operator: ${operator}
workspace:
  mode: shared
seats:
${seats}`;
}

const ONE = base(LEAD);
const FULL = `grant:
  session: arena
  seat: lead
  scope:
    - up
    - down
    - approve
    - init
`;
const UP_ALONE = `grant:
  session: arena
  seat: lead
  scope:
    - up
`;
const GRANTED = ONE + FULL;
const GRANTED_UP = ONE + UP_ALONE;

// The ordinary cover a smuggling approve rides on, and the sovereign payloads it rides in.
const RULES = `rules:
  - Keep the changelog current.
`;
const TRUST_NARROW = `trust:
  - .
`;
const TRUST_WIDE = `trust:
  - .
  - ../faraway/*
`;
const DELEGATES = `delegates:
  - pane: outside/distant
    commands: [up]
`;
const LIMITS = `limits:
  seats: 9
`;
const BUDGETS = `budgets:
  marks:
    - 50
`;
const IDENTITY = `identity:
  humans:
    - jane@acme.example
`;

function teamOf(text: string) {
  const checked = validateTeamFile(text);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return checked.team;
}

function messages(text: string): string[] {
  const checked = validateTeamFile(text);
  return checked.ok ? [] : checked.errors.map((error) => error.message);
}

function recordOf(text: string, dropGrant = false): ApprovalRecord {
  const approval = approvalOf(teamOf(text), ROOT, NOW);
  if (dropGrant) delete approval.fingerprints.sections.grant;
  return { approval, file: text };
}

function verified(text: string, dropGrant = false): Extract<Standing, { kind: 'verified' }> {
  const record = recordOf(text, dropGrant);
  return { kind: 'verified', record, generation: 1, signedAt: record.approval.approvedAt };
}

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function folder(text: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'team-grant-boundaries-')));
  dirs.push(dir);
  mkdirSync(join(dir, '.agents'));
  mkdirSync(join(dir, 'home'));
  writeFileSync(join(dir, '.agents', 'team.yaml'), text);
  return dir;
}

/** The pane a seat name is recorded on, or undefined to record the seat with no pane. */
type SeatRecord = string | undefined;

function stateAt(dir: string, sessions: Record<string, Record<string, SeatRecord>>): void {
  writeFileSync(join(dir, 'team.state.json'), JSON.stringify({
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
  }));
}

type Pane = { pane: string; name: string; root: number };

/** The io of a caller the real placement walk places: herdr above it, the roots its process
 *  chain descends from in `chain`, and the panes each session's agent list names. `asked`
 *  records every session the gate enquires about, so a scene can pin that the grant's session
 *  is the only one read. */
function placedIo(
  cwd: string,
  panes: Pane[],
  lists: Record<string, string[]>,
  chain: number[],
  asked: string[] = [],
  hint?: string,
): Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'> {
  const ancestors = [{ pid: 1, name: 'herdr' }, ...chain.map((pid) => ({ pid, name: `step-${pid}` }))];
  const env: Record<string, string | undefined> = hint === undefined ? {} : { HERDR_PANE_ID: hint };
  return {
    cwd,
    env,
    stdinIsTTY: true,
    callerSources: (session: string | undefined) => {
      asked.push(session ?? '(no session)');
      return {
        ancestors: () => ancestors,
        agents: () => (session === undefined ? [] : (lists[session] ?? []).map((pane) => {
          const found = panes.find((one) => one.pane === pane);
          return { pane, name: found?.name ?? '', agent: null, workspace: '', status: '', cwd: null };
        })),
        paneRootPid: (pane: string) => panes.find((one) => one.pane === pane)?.root ?? null,
        env,
        stdinIsTTY: true,
      };
    },
  };
}

/** One ask of the gate: a live file in a real folder, the state that goes with it, and the
 *  record an approval of `approved` (the live text, unless said otherwise) would leave. The
 *  load, the state and the placement walk are the real reads. */
function gate(opts: {
  act: Act;
  live: string;
  approved?: string;
  dropGrant?: boolean;
  sessions: Record<string, Record<string, SeatRecord>>;
  io: (cwd: string) => Pick<Io, 'env' | 'stdinIsTTY' | 'caller' | 'callerSources' | 'cwd'>;
}) {
  const dir = folder(opts.live);
  stateAt(join(dir, '.agents'), opts.sessions);
  const approved = opts.approved ?? opts.live;
  const sources: GrantSources = {
    standing: () => verified(approved, opts.dropGrant),
    approvedCopy: () => approved,
  };
  return grantGate({ act: opts.act, io: opts.io(dir), home: join(dir, 'home'), sources });
}

// The orchestrator's own standing: the name the grant names, on the pane the state records for
// it, placed by the walk. The refusals below mean nothing unless this caller passes.
const SEATED = { arena: { lead: 'alpha' } };
const ORCHESTRATOR = (cwd: string) => placedIo(cwd, [{ pane: 'alpha', name: 'lead', root: 20 }], { arena: ['alpha'] }, [20]);

describe('a spoofed placement', () => {
  test('the orchestrator on its recorded pane passes, asked about the grant\'s session alone', () => {
    const asked: string[] = [];
    expect(gate({ act: 'down', live: GRANTED, sessions: SEATED, io: (cwd) => placedIo(cwd, [{ pane: 'alpha', name: 'lead', root: 20 }], { arena: ['alpha'] }, [20], asked) })).toEqual({
      kind: 'passed',
      grant: { session: 'arena', seat: 'lead', scope: ['up', 'down', 'approve', 'init'] },
    });
    expect(asked).toEqual(['arena']);
  });

  test('a pane renamed to the orchestrator\'s name, on a pane the state does not record, is refused for every act', () => {
    const panes = [
      { pane: 'alpha', name: 'lead', root: 20 },
      { pane: 'gamma', name: 'lead', root: 40 },
    ];
    for (const act of ACTS) {
      expect(gate({
        act,
        live: GRANTED,
        sessions: SEATED,
        io: (cwd) => placedIo(cwd, panes, { arena: ['alpha', 'gamma'] }, [40]),
      })).toEqual({ kind: 'refused', id: 'grant.another-pane', text: anotherPaneRefusal('lead', 'alpha') });
    }
  });

  test('the state recording the spoofer\'s pane for another seat does not adopt the name', () => {
    const panes = [
      { pane: 'alpha', name: 'lead', root: 20 },
      { pane: 'gamma', name: 'lead', root: 40 },
    ];
    expect(gate({
      act: 'approve',
      live: GRANTED,
      sessions: { arena: { lead: 'alpha', helper: 'gamma' } },
      io: (cwd) => placedIo(cwd, panes, { arena: ['alpha', 'gamma'] }, [40]),
    })).toEqual({ kind: 'refused', id: 'grant.another-pane', text: anotherPaneRefusal('lead', 'alpha') });
  });

  test('the orchestrator\'s name in another session is refused, whatever the state records there', () => {
    const panes = [
      { pane: 'alpha', name: 'lead', root: 20 },
      { pane: 'delta', name: 'lead', root: 50 },
    ];
    const lists = { arena: ['alpha'], side: ['delta'] };
    const sessions = { arena: { lead: 'alpha' as SeatRecord }, side: { lead: 'delta' as SeatRecord } };
    const asked: string[] = [];
    // The grant's session cannot place this caller: its list names a pane this chain is not on.
    expect(gate({ act: 'up', live: GRANTED, sessions, io: (cwd) => placedIo(cwd, panes, lists, [50], asked) })).toEqual({
      kind: 'refused',
      id: 'grant.caller',
      text: 'only the seat the grant names runs this: this call is unplaced (it runs in a herdr pane without an agent)',
    });
    // The hint names its own pane, so the walk places it as a bare pane of the grant's session.
    // A pane is not the seat, and the state's record for the other session does not turn it ok.
    expect(gate({ act: 'up', live: GRANTED, sessions, io: (cwd) => placedIo(cwd, panes, lists, [50], asked, 'delta') })).toEqual({
      kind: 'refused',
      id: 'grant.caller',
      text: 'only the seat the grant names runs this: this call is it runs in pane arena/delta, which no grant lists',
    });
    expect(asked).toEqual(['arena', 'arena']);
  });

  test('the right name on a pane the state does not record for it, or with no pane recorded, is refused', () => {
    const panes = [{ pane: 'alpha', name: 'lead', root: 20 }];
    expect(gate({
      act: 'up',
      live: GRANTED,
      sessions: { arena: { lead: 'omega' } },
      io: (cwd) => placedIo(cwd, panes, { arena: ['alpha'] }, [20]),
    })).toEqual({ kind: 'refused', id: 'grant.another-pane', text: anotherPaneRefusal('lead', 'omega') });
    expect(gate({
      act: 'up',
      live: GRANTED,
      sessions: { arena: { lead: undefined } },
      io: (cwd) => placedIo(cwd, panes, { arena: ['alpha'] }, [20]),
    })).toEqual({ kind: 'refused', id: 'grant.no-pane', text: noPaneRefusal('lead') });
  });

  test('the operator\'s seat, on its own recorded pane, is refused for every act', () => {
    const panes = [
      { pane: 'alpha', name: 'lead', root: 20 },
      { pane: 'beta', name: 'helper', root: 30 },
    ];
    const two = base(LEAD + HELPER, 'helper') + FULL;
    for (const act of ACTS) {
      expect(gate({
        act,
        live: two,
        sessions: { arena: { lead: 'alpha', helper: 'beta' } },
        io: (cwd) => placedIo(cwd, panes, { arena: ['alpha', 'beta'] }, [30]),
      })).toEqual({ kind: 'refused', id: 'grant.caller', text: 'only the seat the grant names runs this: this call is helper' });
    }
  });
});

describe('the grant\'s scope', () => {
  test('an act the list does not name is refused', () => {
    expect(gate({ act: 'approve', live: GRANTED_UP, sessions: SEATED, io: ORCHESTRATOR })).toEqual({
      kind: 'refused',
      id: 'grant.scope',
      text: 'the grant does not list `approve`',
    });
  });

  test('a token outside the closed set never validates, alone or beside a real one', () => {
    expect(messages(`${ONE}grant:\n  session: arena\n  seat: lead\n  scope: [ship]\n`)).toContain(
      'grant.scope must name up, down, approve, init: "ship" is not one',
    );
    expect(messages(`${ONE}grant:\n  session: arena\n  seat: lead\n  scope:\n    - up\n    - ship\n`)).toContain(
      'grant.scope must name up, down, approve, init: "ship" is not one',
    );
  });

  test('an empty list, and a list left blank, never validate', () => {
    const empty = `${ONE}grant:\n  session: arena\n  seat: lead\n  scope: []\n`;
    const blank = `${ONE}grant:\n  session: arena\n  seat: lead\n  scope:\n`;
    for (const text of [empty, blank]) {
      expect(messages(text)).toContain('grant.scope must name at least one of: up, down, approve, init');
    }
  });

  test('an unknown key never validates, and the gate refuses the file that carries it unread', () => {
    const aimed = `${ONE}grant:\n  session: arena\n  seat: lead\n  scope: [up]\n  path: ../outside\n`;
    expect(messages(aimed)).toContain('unknown field "path" in grant');
    const verdict = gate({ act: 'up', live: aimed, sessions: SEATED, io: ORCHESTRATOR });
    expect(verdict.kind).toBe('refused');
    if (verdict.kind === 'refused') {
      expect(verdict.id).toBe('grant.file');
      expect(verdict.text).toContain('unknown field "path" in grant');
    }
  });
});

describe('the signature the gate trusts', () => {
  test('a grant added to the live file and not yet approved is invisible to every act', () => {
    expect(gate({ act: 'up', live: GRANTED, approved: ONE, sessions: SEATED, io: ORCHESTRATOR })).toEqual({
      kind: 'refused',
      id: 'grant.drift',
      text: 'a grant needs the approved file: the file is not the approved one (`grant` changed): run `team approve`',
    });
    expect(gate({ act: 'approve', live: GRANTED, approved: ONE, sessions: SEATED, io: ORCHESTRATOR })).toEqual({
      kind: 'refused',
      id: 'grant.not-ordinary',
      text: 'this change needs the owner: `grant` changed',
    });
  });

  test('a record from before the section still matches a file that still omits it', () => {
    // The record predates the section, so it carries no grant fingerprint. The file still omits
    // the section. The pair matches — the refusal is that nothing is granted, never that the
    // file drifted or that the change needs the owner.
    for (const act of ['up', 'approve'] as const) {
      expect(gate({ act, live: ONE, approved: ONE, dropGrant: true, sessions: SEATED, io: ORCHESTRATOR })).toEqual({
        kind: 'refused',
        id: 'grant.omitted',
        text: 'the approved file grants nothing',
      });
    }
  });
});

describe('an ordinary approve that also moves a sovereign section', () => {
  test('each sovereign section rides no rules change through', () => {
    const cases: Array<[string, string, string]> = [
      ['trust', GRANTED + TRUST_NARROW, GRANTED + TRUST_WIDE + RULES],
      ['delegates', GRANTED, GRANTED + DELEGATES + RULES],
      ['limits', GRANTED, GRANTED + LIMITS + RULES],
      ['budgets', GRANTED, GRANTED + BUDGETS + RULES],
      ['identity', GRANTED, GRANTED + IDENTITY + RULES],
    ];
    for (const [section, approved, live] of cases) {
      expect(gate({ act: 'approve', live, approved, sessions: SEATED, io: ORCHESTRATOR })).toEqual({
        kind: 'refused',
        id: 'grant.not-ordinary',
        text: `this change needs the owner: \`${section}\` changed`,
      });
    }
  });

  test('the grant itself, widened by the granted seat\'s own approve, is the owner\'s, and the record is not rewritten in passing', () => {
    const dir = folder(GRANTED);
    stateAt(join(dir, '.agents'), SEATED);
    const standing = verified(GRANTED_UP);
    const verdict = grantGate({
      act: 'approve',
      io: ORCHESTRATOR(dir),
      home: join(dir, 'home'),
      sources: { standing: () => standing, approvedCopy: () => GRANTED_UP },
    });
    expect(verdict).toEqual({ kind: 'refused', id: 'grant.not-ordinary', text: 'this change needs the owner: `grant` changed' });
    expect(standing.record).toEqual(recordOf(GRANTED_UP));
  });

  test('a roster add on a file that declares no limits is the owner\'s', () => {
    const live = base(LEAD + HELPER) + FULL;
    expect(gate({ act: 'approve', live, approved: GRANTED, sessions: SEATED, io: ORCHESTRATOR })).toEqual({
      kind: 'refused',
      id: 'grant.not-ordinary',
      text: 'this change needs the owner: `limits` changed',
    });
  });
});

describe('the granted seat aiming the owner\'s flags', () => {
  const SEAT: Caller = { kind: 'seat', name: 'lead', pane: 'alpha', session: 'arena' };

  // Every read the command could make after the flag refusal throws: the refusal must come
  // before any of them, so the bytes are the same whatever the flag names.
  function unreadSources(dir: string): StatusSources {
    return {
      live: () => { throw new Error('a session was read'); },
      branch: () => { throw new Error('a branch was read'); },
      standing: () => { throw new Error('the approval was read'); },
      now: () => NOW,
      home: dir,
      gate: {
        standing: () => { throw new Error('the gate read the approval'); },
        agents: () => { throw new Error('the gate read a session'); },
      },
    };
  }

  test('the seat the grant names passes the gate and still cannot aim --file', async () => {
    const dir = folder(GRANTED);
    stateAt(join(dir, '.agents'), SEATED);
    expect(grantGate({
      act: 'up',
      io: testIo(dir, SEAT),
      home: join(dir, 'home'),
      sources: { standing: () => verified(GRANTED), approvedCopy: () => GRANTED },
    })).toEqual({ kind: 'passed', grant: { session: 'arena', seat: 'lead', scope: ['up', 'down', 'approve', 'init'] } });

    const text = `team status: --file is the owner's, from a terminal outside herdr; this call is lead\n`;
    const other = folder(GRANTED);
    const missing = testIo(dir, SEAT);
    const missingCode = await runStatus(['--file', join(dir, 'no-such-team.yaml')], missing, unreadSources(dir));
    expect({ code: missingCode, out: missing.out, err: missing.err }).toEqual({ code: 1, out: '', err: text });
    const aimed = testIo(dir, SEAT);
    const aimedCode = await runStatus(['--file', join(other, '.agents', 'team.yaml')], aimed, unreadSources(dir));
    expect({ code: aimedCode, out: aimed.out, err: aimed.err }).toEqual({ code: 1, out: '', err: text });
  });

  test('--session is refused the same, before any session is read', async () => {
    const dir = folder(GRANTED);
    stateAt(join(dir, '.agents'), SEATED);
    const io = testIo(dir, SEAT);
    const code = await runStatus(['--session', 'elsewhere'], io, unreadSources(dir));
    expect({ code, out: io.out, err: io.err }).toEqual({
      code: 1,
      out: '',
      err: `team status: --session is the owner's, from a terminal outside herdr; this call is lead\n`,
    });
  });
});
