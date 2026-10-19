import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalOf, notInForce } from '../src/approve/approval.ts';
import { fingerprints } from '../src/approve/fingerprint.ts';
import type { CallerSources, Process } from '../src/caller.ts';
import { ADD_DELEGATE_EDIT, DELEGATE_EXIT_IDS, delegateGate, logDelegated, type DelegateVerdict } from '../src/delegate.ts';
import { ACTING_COMMANDS as DELEGATE_COMMANDS, type ActingCommand, type DelegateCommand } from '../src/delegate-types.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { State } from '../src/state.ts';
import { approvalStanding, approvedCopy, LEGACY_LINE, storePath, writeApproval, type Standing } from '../src/store/store.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const agent = (name: string | null, pane: string): HerdrAgent => ({
  name,
  agent: 'claude',
  pane,
  workspace: pane.split(':')[0] ?? '',
  status: 'idle',
  cwd: null,
});

const yaml = `format: 1
project: acme
session: alpha
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
delegates:
  - pane: other/w1:p1
    commands: [up, down, add, remove]
`;

function parsed(text: string): TeamFile {
  const result = validateTeamFile(text);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.team;
}

const base = parsed(yaml);

function verified(team: TeamFile, file: string): Standing {
  return {
    kind: 'verified',
    generation: 1,
    signedAt: '2026-10-06T00:00:00.000Z',
    record: {
      approval: {
        format: 2,
        approvedAt: '2026-10-06T00:00:00.000Z',
        root: '/proj',
        fingerprints: fingerprints(team),
        ceilings: { seats: team.limits.seats, temporary: team.limits.temporary, vendors: { ...team.limits.vendors } },
      },
      file,
      generation: 1,
      signature: 'test',
    },
  };
}

const empty: State = { format: 1, sessions: {} };
const under: Process[] = [{ pid: 100, name: 'zsh' }, { pid: 10, name: 'herdr' }];
const terminal: Process[] = [{ pid: 50, name: 'zsh' }, { pid: 40, name: 'login' }];

type Scene = {
  command?: ActingCommand;
  team?: TeamFile;
  file?: string;
  standing?: Standing;
  state?: State | null;
  stateError?: string;
  agents?: (session: string) => HerdrAgent[] | null;
  sessionRunning?: (session: string) => boolean | null;
  ancestors?: Process[] | null;
  roots?: Record<string, number | null>;
  stdinIsTTY?: boolean;
  flags?: readonly string[];
  callerSources?: (session: string | undefined) => CallerSources;
  swap?: boolean;
};

function gate(scene: Scene = {}): DelegateVerdict {
  const team = scene.team ?? base;
  const file = scene.file ?? yaml;
  const standing = scene.standing ?? verified(team, file);
  const ancestors = scene.ancestors === undefined ? under : scene.ancestors;
  const roots = scene.roots ?? { 'w1:p1': 100, 'w2:p1': 200, 'w3:p1': 300 };
  const agents = scene.agents ?? ((session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : []));
  const sources = scene.callerSources ?? ((session: string | undefined): CallerSources => ({
    ancestors: () => ancestors,
    agents: () => (session === undefined ? [] : agents(session)),
    paneRootPid: (pane) => (Object.hasOwn(roots, pane) ? roots[pane] ?? null : null),
    env: {},
    stdinIsTTY: scene.stdinIsTTY ?? true,
  }));
  return delegateGate({
    ...(scene.swap ? { swap: true } : {}),
    command: scene.command ?? 'up',
    team,
    root: '/proj',
    dir: '/proj/.agents',
    flags: scene.flags ?? [],
    io: { env: {}, stdinIsTTY: scene.stdinIsTTY ?? true },
    sources: {
      standing: () => standing,
      state: () => {
        if (scene.stateError) throw new Error(scene.stateError);
        return scene.state === undefined ? empty : scene.state;
      },
      agents,
      sessionRunning: scene.sessionRunning ?? (() => null),
      callerSources: sources,
    },
  });
}

function refused(scene: Scene): { id: string; text: string } {
  const verdict = gate(scene);
  if (verdict.kind !== 'refused') throw new Error(`passed ${verdict.pane}`);
  return { id: verdict.id, text: verdict.text };
}

describe('the audit line and the edit refusal', () => {
  test('logLine writes the delegate line, and an add that would edit has its own refusal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-delegate-'));
    made.push(dir);
    logDelegated(dir, 'other/w1:p1', 'up', new Date('2026-10-06T12:00:00.000Z'));
    // A run of logDelegated on 2026-10-06 produced this line, the same bytes logLine writes.
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toBe('2026-10-06T12:00:00.000Z delegate [delegate] other/w1:p1 up\n');
    // A detail — what a delegated approval sealed — is appended after the command; an empty
    // one adds nothing, so the four commands' lines keep their bytes.
    logDelegated(dir, 'other/w1:p1', 'approve', new Date('2026-10-06T12:01:00.000Z'), '`rules` changed');
    logDelegated(dir, 'other/w1:p1', 'approve', new Date('2026-10-06T12:02:00.000Z'));
    expect(readFileSync(join(dir, 'team.log'), 'utf8')).toBe(
      '2026-10-06T12:00:00.000Z delegate [delegate] other/w1:p1 up\n'
      + '2026-10-06T12:01:00.000Z delegate [delegate] other/w1:p1 approve: `rules` changed\n'
      + '2026-10-06T12:02:00.000Z delegate [delegate] other/w1:p1 approve\n',
    );
    expect(ADD_DELEGATE_EDIT).toEqual({
      id: 'add.delegate-edit',
      text: 'the approved delegate adds only a same-copy seat: the live file\'s own stanza, hash for hash; a missing, stopped or changed seat is the owner\'s',
    });
  });
});

describe('a matching pane passes, and only that pane', () => {
  test('the approved pane passes, including a renamed agent and an allowed flag', () => {
    expect(gate()).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ agents: () => [agent('renamed', 'w1:p1')], flags: ['dry-run'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'down', flags: ['wait', 'dry-run'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'add', flags: ['dry-run', 'restore'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'remove' })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('another pane of the delegate session is refused, and so is a pane carrying the delegate agent\'s name', () => {
    const other = refused({
      agents: () => [agent('worker', 'w1:p1'), agent('assistant', 'w2:p1')],
      ancestors: [{ pid: 200, name: 'zsh' }, { pid: 10, name: 'herdr' }],
    });
    expect(other).toEqual({
      id: 'up.delegate',
      text: 'only the owner or the approved delegate runs `up`; this call is assistant',
    });
    const renamed = refused({
      agents: () => [agent('worker', 'w2:p1')],
      ancestors: [{ pid: 200, name: 'zsh' }, { pid: 10, name: 'herdr' }],
    });
    expect(renamed.id).toBe('up.delegate');
    expect(renamed.text).toContain('this call is worker');
  });

  test('an agentless pane the grant names passes, and one it does not is named', () => {
    const shell: Process[] = [{ pid: 900, name: 'zsh' }, { pid: 10, name: 'herdr' }];
    const of = (pane: string) => (): CallerSources => ({
      ancestors: () => shell,
      agents: () => [],
      paneRootPid: (id) => (id === pane ? 900 : null),
      env: { HERDR_PANE_ID: pane },
      stdinIsTTY: true,
    });
    const granted = of('w1:p1');
    expect(gate({ callerSources: granted, command: 'up' })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ callerSources: granted, command: 'down' })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ callerSources: granted, command: 'approve' })).toEqual({
      id: 'approve.delegate-command',
      text: 'the approved delegate other/w1:p1 may not run `approve`; its approved commands are up, down, add, remove',
    });
    expect(refused({ callerSources: of('w9:p1') })).toEqual({
      id: 'up.delegate',
      text: 'only the owner or the approved delegate runs `up`; this call is it runs in pane other/w9:p1, which no grant lists',
    });
    expect(refused({
      callerSources: () => ({
        ancestors: () => shell,
        agents: () => [],
        paneRootPid: () => null,
        env: { HERDR_PANE_ID: 'w1:p1' },
        stdinIsTTY: true,
      }),
    }).text).toBe('only the owner or the approved delegate runs `up`; this call is unplaced (it runs in a herdr pane without an agent)');
  });

  test('the owner, a caller without a terminal, and an agent outside herdr are not the pane', () => {
    expect(refused({ ancestors: terminal }).text).toBe('only the owner or the approved delegate runs `up`; this call is owner');
    expect(refused({ ancestors: terminal, stdinIsTTY: false }).text).toContain('this call is unplaced (it doesn\'t run on a terminal)');
    const loose: Process[] = [{ pid: 51, name: 'bash' }, { pid: 50, name: 'claude' }];
    expect(refused({ ancestors: loose }).text).toContain('this call is unplaced (it is run by an agent (claude) outside herdr)');
  });

  test('the second entry is the one that matches, and its own command list', () => {
    const text = yaml.replace(
      'commands: [up, down, add, remove]',
      'commands: [add]\n  - pane: other/w2:p1\n    commands: [up, remove]',
    );
    const team = parsed(text);
    expect(gate({
      team,
      file: text,
      command: 'up',
      agents: () => [agent('worker', 'w1:p1'), agent('second', 'w2:p1')],
      ancestors: [{ pid: 200, name: 'zsh' }, { pid: 10, name: 'herdr' }],
    })).toEqual({ kind: 'passed', pane: 'other/w2:p1' });
    expect(refused({
      team,
      file: text,
      command: 'up',
      agents: () => [agent('worker', 'w1:p1'), agent('second', 'w2:p1')],
    }).text).toBe('the approved delegate other/w1:p1 may not run `up`; its approved commands are add');
  });
});

describe('refusal priority', () => {
  const drifted = {
    ...base,
    rules: ['a new rule'],
    seats: base.seats.map((seat, index) => (index === 0 ? { ...seat, model: 'Other' } : seat)),
  };

  test('each earlier refusal wins, and an unlisted command wins over a prohibited flag', () => {
    expect(refused({ standing: { kind: 'none' }, team: drifted, stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-approval');
    // A fingerprint difference is not a refusal for `up`: the live file is the record. Unreadable
    // evidence still is, and a prohibited flag still is, after the live file is read.
    expect(gate({ team: drifted })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ team: drifted, stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-evidence');
    const approved = verified(base, yaml);
    expect(gate({ team: drifted, standing: approved })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ team: drifted, standing: approved, stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-evidence');
    expect(refused({ stateError: 'the state can\'t be read', flags: ['session'] }).id).toBe('up.delegate-evidence');
    // The delegate pane lives in session "other", so a file whose session is "other" is a placement
    // refusal, and that check is earlier than a prohibited flag.
    expect(refused({ team: { ...base, session: 'other' }, standing: approved, flags: ['session'] }).id).toBe('up.delegate-placement');
    const outside = { ...base, delegates: [{ pane: 'alpha/w9:p9', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team: outside, standing: verified(outside, yaml), ancestors: terminal }).id).toBe('up.delegate-placement');
    expect(refused({ ancestors: terminal, flags: ['session'] }).id).toBe('up.delegate');
    const listed = parsed(yaml.replace('commands: [up, down, add, remove]', 'commands: [up]'));
    expect(refused({ command: 'down', team: listed, file: yaml.replace('commands: [up, down, add, remove]', 'commands: [up]'), flags: ['abandon'] }).id).toBe('down.delegate-command');
    expect(refused({ flags: ['session'] }).id).toBe('up.delegate-flag');
  });

  test('no earlier copy, unverified approval, or unreadable evidence authorises', () => {
    const remembered: State = { format: 1, last_valid: { read_at: '2026-10-06T00:00:00.000Z', file: yaml }, sessions: {} };
    expect(refused({ standing: { kind: 'none' }, state: remembered }).id).toBe('up.delegate-approval');
    expect(refused({ standing: { kind: 'legacy' }, state: remembered }).id).toBe('up.delegate-approval');
    expect(refused({ standing: { kind: 'refused', why: 'the signing key cannot be read (EIO): restore it from a copy — no record verifies until it is back' } }).text).toBe(
      'delegation needs a verified approval: the signing key cannot be read (EIO): restore it from a copy — no record verifies until it is back',
    );
    expect(refused({ stateError: 'team.state.json is not valid JSON' }).text).toBe(
      'delegation cannot verify its placement or seats: team.state.json is not valid JSON',
    );
  });

  test('the standing text is notInForce, and up reads the live file', () => {
    expect(refused({ standing: { kind: 'none' } }).text).toBe(`delegation needs a verified approval: ${notInForce({ kind: 'none' })}`);
    expect(refused({ standing: { kind: 'legacy' } }).text).toContain(LEGACY_LINE);
    expect(gate({ team: drifted, standing: verified(base, yaml) })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    const delegated = { ...base, delegates: [{ pane: 'other/w1:p1', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ command: 'approve', team: delegated, standing: verified(base, yaml) }).text).toContain('this change needs the owner');
  });
});

describe('placement', () => {
  test('the delegate session being the team session is refused, and so is a recorded or configured seat pane', () => {
    const recorded: State = { format: 1, sessions: { alpha: { seats: { lead: { stage: 'ready', pane: 'w4:p1' } }, worktrees: {} } } };
    const seated = { ...base, delegates: [{ pane: 'alpha/w4:p1', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team: seated, standing: verified(seated, yaml), state: recorded }).id).toBe('up.delegate-placement');
    const bare = { ...base, delegates: [{ pane: 'alpha/w9:p9', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team: bare, standing: verified(bare, yaml) }).id).toBe('up.delegate-placement');
    const configured = { ...base, delegates: [{ pane: 'alpha/w5:p1', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({
      team: configured,
      standing: verified(configured, yaml),
      agents: (session) => (session === 'alpha' ? [agent('lead', 'w5:p1')] : [agent('worker', 'w1:p1')]),
      roots: { 'w1:p1': 100, 'w5:p1': 500 },
    }).id).toBe('up.delegate-placement');
  });

  test('the same pane id in another session is not a seat of this team', () => {
    const recorded: State = { format: 1, sessions: { alpha: { seats: { lead: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} } } };
    expect(gate({ state: recorded })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('a live agent named like a configured seat is not a placement refusal, because a name is not a seat', () => {
    expect(gate({ agents: () => [agent('lead', 'w1:p1')], state: empty })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('a session entry with no seats is treated as having none', () => {
    const handed = { format: 1, sessions: { other: { worktrees: {} } } } as unknown as State;
    expect(gate({ state: handed })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('a seat recorded in the delegate session collides, and a different pane there does not', () => {
    const recorded: State = { format: 1, sessions: { other: { seats: { worker: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} } } };
    for (const command of DELEGATE_COMMANDS) {
      expect(refused({ command, state: recorded }).id).toBe(`${command}.delegate-placement`);
    }
    const otherPane: State = { format: 1, sessions: { other: { seats: { worker: { stage: 'ready', pane: 'w8:p8' } }, worktrees: {} } } };
    expect(gate({ state: otherPane })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('one colliding entry refuses the whole list', () => {
    const text = `${yaml}  - pane: alpha/w9:p9\n    commands: [up]\n`;
    expect(validateTeamFile(text).ok).toBe(false);
    const team = { ...base, delegates: [...(base.delegates ?? []), { pane: 'alpha/w9:p9', commands: ['up'] as DelegateCommand[] }] };
    expect(refused({ team, standing: verified(team, yaml) }).id).toBe('up.delegate-placement');
  });

  test('unreadable ancestors or herdr are evidence, not a non-delegate', () => {
    expect(refused({ ancestors: null }).text).toBe(`delegation cannot verify its placement or seats: its parent processes can't be read to the top`);
    expect(refused({ ancestors: [] }).id).toBe('up.delegate-evidence');
    expect(refused({
      agents: () => null,
    }).text).toBe(`delegation cannot verify its placement or seats: it runs under herdr, and herdr doesn't answer`);
    expect(refused({ ancestors: terminal, agents: () => null }).text).toBe(`delegation cannot verify its placement or seats: herdr doesn't answer`);
    expect(refused({ roots: { 'w1:p1': null } }).text).toBe(`delegation cannot verify its placement or seats: it runs under herdr, and no pane root can be read`);
  });
});

describe('the team session that is not running', () => {
  // What herdr really answers for a stopped or absent session: `agent list --session <name>`
  // fails (its server is gone), while `session list --json` still answers with running false.
  // The delegate's own session is a different session and stays readable throughout.
  const unlisted = (session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : null);

  test('a stopped or absent session has no seats to collide with: every command passes', () => {
    // The scene grants the whole vocabulary — the base file grants the four operational
    // commands — so the stopped-session path is walked for each of the five.
    const granted = yaml.replace('commands: [up, down, add, remove]', 'commands: [up, down, add, remove, approve]');
    const five = parsed(granted);
    for (const command of DELEGATE_COMMANDS) {
      expect(gate({ command, team: five, file: granted, agents: unlisted, sessionRunning: () => false })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    }
  });

  test('a running session whose list cannot be read is still refused with today\'s text', () => {
    const verdict = refused({ agents: unlisted, sessionRunning: () => true });
    expect(verdict.id).toBe('up.delegate-evidence');
    expect(verdict.text).toBe(`delegation cannot verify its placement or seats: herdr doesn't answer`);
  });

  test('a herdr that cannot say, or a read that throws, keeps the refusal', () => {
    expect(refused({ agents: unlisted, sessionRunning: () => null }).text).toBe(
      `delegation cannot verify its placement or seats: herdr doesn't answer`,
    );
    const thrown = refused({
      agents: unlisted,
      sessionRunning: () => {
        throw new Error('EIO');
      },
    });
    expect(thrown.id).toBe('up.delegate-evidence');
    expect(thrown.text).toBe(`delegation cannot verify its placement or seats: herdr doesn't answer`);
  });

  test('the delegate\'s own session is still read: a silent team session does not excuse it', () => {
    expect(refused({
      agents: (session: string) => (session === 'other' ? null : []),
      sessionRunning: () => false,
    }).text).toBe(`delegation cannot verify its placement or seats: it runs under herdr, and herdr doesn't answer`);
  });

  test('the state is still read, and the session is asked only when the list is null', () => {
    expect(refused({ agents: unlisted, sessionRunning: () => false, stateError: 'team.state.json is not valid JSON' }).text).toBe(
      'delegation cannot verify its placement or seats: team.state.json is not valid JSON',
    );
    const asked: string[] = [];
    expect(gate({
      agents: (session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : []),
      sessionRunning: (session) => {
        asked.push(session);
        return false;
      },
    })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(asked).toEqual([]);
  });
});

describe('commands and flags', () => {
  const commands = ['up', 'down', 'add', 'remove'] as const;

  test('every preflight id of the four commands', () => {
    for (const command of commands) {
      expect(refused({ command, standing: { kind: 'none' } }).id).toBe(`${command}.delegate-approval`);
      expect(gate({ command })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
      const drifted = { ...base, rules: ['changed'] };
      expect(gate({ command, team: drifted, standing: verified(base, yaml) })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
      expect(refused({ command, state: null }).id).toBe(`${command}.delegate-evidence`);
      const inside = { ...base, delegates: [{ pane: 'alpha/w9:p9', commands: [command] }] };
      expect(refused({ command, team: inside, standing: verified(inside, yaml) }).id).toBe(`${command}.delegate-placement`);
    }
  });

  test('the non-delegate text, the unlisted command, and one prohibited flag of each command', () => {
    expect(refused({ command: 'down', ancestors: terminal }).text).toBe(
      'only the owner, `leads` or the approved delegate stops the team; this call is owner',
    );
    expect(refused({ command: 'add', ancestors: terminal }).text).toBe(
      'only the owner or a standing grant (delegate) runs this, from a terminal outside herdr; this call is owner',
    );
    expect(refused({ command: 'remove', ancestors: terminal }).text).toBe(
      'only the owner, `leads` or the approved delegate removes a seat; this call is owner',
    );
    for (const command of DELEGATE_COMMANDS) {
      const only = parsed(yaml.replace('commands: [up, down, add, remove]', 'commands: [add]'));
      if (command === 'add') continue;
      const verdict = refused({ command, team: only, file: yaml.replace('commands: [up, down, add, remove]', 'commands: [add]') });
      expect(verdict.id).toBe(`${command}.delegate-command`);
      expect(verdict.text).toBe(`the approved delegate other/w1:p1 may not run \`${command}\`; its approved commands are add`);
    }
    expect(refused({ command: 'up', flags: ['file', 'session'] }).text).toBe(`--session is the owner's; the approved delegate cannot use it`);
    expect(refused({ command: 'down', flags: ['abandon'] }).id).toBe('down.delegate-flag');
    expect(refused({ command: 'add', flags: ['temporary'] }).id).toBe('add.delegate-flag');
    // `--like` is not the owner's alone: a declared copy is how a delegate adds a seat, and the
    // command admits it only when the source is the record's own (`add.delegate-edit`).
    expect(gate({ command: 'add', flags: ['like'] })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ command: 'add', flags: ['until'] }).text).toContain('--until');
    expect(refused({ command: 'add', flags: ['worktree'] }).text).toContain('--worktree');
    expect(refused({ command: 'remove', flags: ['keep'] }).id).toBe('remove.delegate-flag');
    expect(refused({ command: 'remove', flags: ['abandon'] }).text).toContain('--abandon');
  });
});

describe('the match is the whole pane string', () => {
  test('case differs, and so does the same pane id in another session', () => {
    const cased = refused({
      agents: () => [agent('worker', 'W1:P1')],
      roots: { 'W1:P1': 100 },
    });
    expect(cased.id).toBe('up.delegate');
    expect(cased.text).toContain('this call is worker');
    const recorded: State = { format: 1, sessions: { alpha: { seats: { lead: { stage: 'ready', pane: 'w1:p1' } }, worktrees: {} } } };
    expect(gate({ state: recorded })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });

  test('a reordered command list and a reordered entry admit the live pane', () => {
    const reordered = parsed(yaml.replace('commands: [up, down, add, remove]', 'commands: [remove, add, down, up]'));
    expect(gate({ team: reordered, standing: verified(base, yaml) })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    const swapped = parsed(`${yaml}  - pane: other/w2:p1\n    commands: [add]\n`.replace(
      '  - pane: other/w1:p1\n    commands: [up, down, add, remove]\n  - pane: other/w2:p1\n    commands: [add]\n',
      '  - pane: other/w2:p1\n    commands: [add]\n  - pane: other/w1:p1\n    commands: [up, down, add, remove]\n',
    ));
    const approved = parsed(`${yaml}  - pane: other/w2:p1\n    commands: [add]\n`);
    expect(gate({ team: swapped, file: yaml, standing: verified(approved, `${yaml}  - pane: other/w2:p1\n    commands: [add]\n`) })).toEqual({
      kind: 'passed',
      pane: 'other/w1:p1',
    });
  });
});

describe('the approval home', () => {
  test('a temporary home is the one that is read', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegate-home-')));
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-delegate-root-')));
    made.push(home, root);
    writeApproval(storePath(base.project, root, home), { approval: approvalOf(base, root), file: yaml }, [], home);
    expect(approvalStanding(root).kind).toBe('none');
    expect(approvedCopy(root)).toBeNull();
    const ancestors = under;
    const roots: Record<string, number | null> = { 'w1:p1': 100 };
    const agents = (session: string) => (session === 'other' ? [agent('worker', 'w1:p1')] : []);
    const verdict = delegateGate({
      command: 'up',
      team: base,
      root,
      dir: join(root, '.agents'),
      flags: [],
      home,
      io: { env: {}, stdinIsTTY: true },
      sources: {
        state: () => empty,
        agents,
        callerSources: (session) => ({
          ancestors: () => ancestors,
          agents: () => (session === undefined ? [] : agents(session)),
          paneRootPid: (pane) => (Object.hasOwn(roots, pane) ? roots[pane] ?? null : null),
          env: {},
          stdinIsTTY: true,
        }),
      },
    });
    expect(verdict).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
  });
});

describe('the exit ids', () => {
  test('lists every refusal of the five commands, the delegated approval\'s own guard included', () => {
    expect(DELEGATE_EXIT_IDS).toHaveLength(32);
    expect(DELEGATE_EXIT_IDS).toContain('approve.delegate-not-ordinary');
    expect(DELEGATE_EXIT_IDS).not.toContain('approve.delegate-drift');
    expect(new Set(DELEGATE_EXIT_IDS).size).toBe(32);
  });
});

// `swap` admits the replacement of a lead seat's agent — `remove <lead> --keep` and
// `add <lead>` — and nothing else. `remove` in an entry never reaches a lead.
describe('the swap word', () => {
  const swapping = yaml.replace('commands: [up, down, add, remove]', 'commands: [swap]');
  const only = parsed(swapping);

  test('remove of a lead needs swap; remove alone is refused and --keep stays the owner\'s for it', () => {
    const verdict = refused({ command: 'remove', swap: true, flags: ['keep'] });
    expect(verdict.id).toBe('remove.delegate-command');
    expect(verdict.text).toBe('the approved delegate other/w1:p1 may not swap a lead seat (`swap`); its approved commands are up, down, add, remove');
    expect(refused({ command: 'remove', flags: ['keep'] }).id).toBe('remove.delegate-flag');
  });

  test('an entry that lists swap passes a lead\'s remove --keep, and nothing else of remove', () => {
    expect(gate({ command: 'remove', swap: true, flags: ['keep'], team: only, file: swapping })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ command: 'remove', team: only, file: swapping }).id).toBe('remove.delegate-command');
    expect(refused({ command: 'remove', swap: true, flags: ['keep', 'abandon'], team: only, file: swapping }).id).toBe('remove.delegate-flag');
  });

  test('add of a lead passes on add or on swap', () => {
    expect(gate({ command: 'add', swap: true })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(gate({ command: 'add', swap: true, team: only, file: swapping })).toEqual({ kind: 'passed', pane: 'other/w1:p1' });
    expect(refused({ command: 'add', team: only, file: swapping }).id).toBe('add.delegate-command');
  });

  test('swap is a word of the section, never a command with exit ids of its own', () => {
    expect(DELEGATE_EXIT_IDS.some((id) => id.startsWith('swap.'))).toBe(false);
  });
});
