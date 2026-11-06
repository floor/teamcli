// Independent verification for `fix/rc-reds-grant-widened`:
// 1. A specific-ops grant cannot reach `order` or `trace` without naming them.
// 2. A grant naming `order` or `trace` admits them (and refuses unlisted ops).
// 3. Option values (`VALUED`, including `order`'s `--file`/`--session` and `daemon`'s `--inherited`)
//    are never read as flags.
// 4. Wildcard grants admit `order` and `trace` immediately while following the unreleased-ops rule
//     in `OP_FIRST_SHIPPED` / `wildcardGrantsWidened`.
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commands } from '../src/cli.ts';
import { generalDoor, VALUED, type Door } from '../src/client/general-door.ts';
import {
  admitGeneral,
  GENERAL_OPS,
  issueHeldGeneralGrant,
  issueOwnerGeneralGrant,
  OP_FIRST_SHIPPED,
  parseOps,
  wildcardGrantsWidened,
  type GeneralOp,
  type GrantOp,
} from '../src/client/general-grant.ts';
import { newClientKeyPair, writeClientKeyFiles } from '../src/client/records.ts';
import type { Io } from '../src/io.ts';
import { teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { installKey } from '../src/store/keys.ts';
import { fixtureBase, gitEnv } from './helpers.ts';
import { intoRegistry } from './helpers/registry-team.ts';

const base = fixtureBase('.rc-reds-grant-widened-ind-');
const home = join(base, 'home');
const root = join(base, 'alpha');

const TEAM_YAML = `format: 1
project: alpha
entity: alpha
coordinator: lead
operator: lead
workspace:
  mode: shared
seats:
  - role: coordinator
    name: lead
    leads: true
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

mkdirSync(home, { recursive: true });
installKey(home, JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'key.json'), 'utf8')));

const pairA = newClientKeyPair();
const writtenA = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-a'), pairA);
if (!writtenA.ok) throw new Error(writtenA.why);
const keyPathA = writtenA.keyPath;

const pairB = newClientKeyPair();
const writtenB = writeClientKeyFiles(join(home, '.config', 'team-client', 'client-b'), pairB);
if (!writtenB.ok) throw new Error(writtenB.why);
const keyPathB = writtenB.keyPath;

mkdirSync(join(root, '.agents'), { recursive: true });
writeFileSync(join(root, '.agents', 'team.yaml'), TEAM_YAML);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env: gitEnv() });
intoRegistry(root, home);
upsertTeam(home, teamIdOf(root), {
  project: 'alpha',
  entity: 'alpha',
  session: 'alpha',
  root,
  roster: [],
  lifecycle: 'running',
  by: 'owner',
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function makeIo(cwd: string = root): Io & { out: string; err: string } {
  const state = {
    out: '',
    err: '',
    stdout: (text: string) => {
      state.out += text;
    },
    stderr: (text: string) => {
      state.err += text;
    },
    cwd,
    env: { HOME: home },
    stdinIsTTY: false,
  };
  return state as Io & { out: string; err: string };
}

function issueGrant(ops: GrantOp[], options: { mayIssue?: boolean; issuedAt?: Date } = {}): string {
  const issued = issueOwnerGeneralGrant(
    home,
    {
      clientId: 'client-a',
      publicKey: pairA.publicKey,
      entities: ['*'],
      ops,
      mayIssue: options.mayIssue ?? false,
      expires: new Date('2027-06-01T00:00:00Z'),
    },
    options.issuedAt ?? new Date('2026-11-04T00:00:00Z'),
  );
  if (!issued.ok) throw new Error(issued.why);
  return issued.path;
}

function runDoor(name: string, args: string[], grantPath: string): Door {
  return generalDoor(name, [...args, '--general', grantPath, '--key', keyPathA], makeIo());
}

describe('fix/rc-reds-grant-widened independent verification', () => {
  test('probe 1: a specific-ops grant cannot reach order or trace without naming them', () => {
    const specificWithoutOrderOrTrace = issueGrant(
      ['status', 'send', 'messages', 'reply', 'daemon', 'down', 'config'],
      { mayIssue: true },
    );

    const orderDoor = runDoor('order', ['--session', 'alpha'], specificWithoutOrderOrTrace);
    expect(orderDoor.kind).toBe('refused');
    if (orderDoor.kind === 'refused') {
      expect(orderDoor.why).toContain('does not cover order');
    }

    const traceDoor = runDoor('trace', ['msg-123'], specificWithoutOrderOrTrace);
    expect(traceDoor.kind).toBe('refused');
    if (traceDoor.kind === 'refused') {
      expect(traceDoor.why).toContain('does not cover trace');
    }

    const admitOrder = admitGeneral(home, specificWithoutOrderOrTrace, keyPathA, 'order', null);
    expect(admitOrder.ok).toBe(false);
    if (!admitOrder.ok) expect(admitOrder.why).toContain('does not cover order');

    const admitTrace = admitGeneral(home, specificWithoutOrderOrTrace, keyPathA, 'trace', null);
    expect(admitTrace.ok).toBe(false);
    if (!admitTrace.ok) expect(admitTrace.why).toContain('does not cover trace');

    // A holder of a grant without `order` or `trace` cannot delegate `order` or `trace` to a child grant:
    for (const missingOp of ['order', 'trace'] as const) {
      const child = issueHeldGeneralGrant(home, specificWithoutOrderOrTrace, keyPathA, {
        clientId: 'client-b',
        publicKey: pairB.publicKey,
        entities: ['*'],
        ops: [missingOp],
        mayIssue: false,
        expires: new Date('2027-05-01T00:00:00Z'),
      });
      expect(child.ok).toBe(false);
      if (!child.ok) {
        expect(child.why).toContain(`op "${missingOp}" is outside the parent grant`);
      }
    }
  });

  test('probe 2: a grant naming order and trace works and admits both commands', () => {
    expect(parseOps('order,trace')).toEqual(['order', 'trace']);

    const orderTraceGrant = issueGrant(['order', 'trace'], { mayIssue: true });

    const orderDoor = runDoor('order', ['--session', 'alpha', '--file', '.agents/team.yaml'], orderTraceGrant);
    expect(orderDoor.kind).toBe('admitted');
    if (orderDoor.kind === 'admitted') {
      expect(orderDoor.argv).toEqual(['--session', 'alpha', '--file', '.agents/team.yaml']);
      expect(orderDoor.io.caller).toEqual({ kind: 'owner' });
    }

    const traceDoor = runDoor('trace', ['msg-123', '--json'], orderTraceGrant);
    expect(traceDoor.kind).toBe('admitted');
    if (traceDoor.kind === 'admitted') {
      expect(traceDoor.argv).toEqual(['msg-123', '--json']);
      expect(traceDoor.json).toBe(true);
    }

    // Unlisted ops remain refused on that grant:
    const statusDoor = runDoor('status', [], orderTraceGrant);
    expect(statusDoor.kind).toBe('refused');
    if (statusDoor.kind === 'refused') {
      expect(statusDoor.why).toContain('does not cover status');
    }

    // Holder can delegate a narrower child grant covering `trace` to client-b:
    const child = issueHeldGeneralGrant(home, orderTraceGrant, keyPathA, {
      clientId: 'client-b',
      publicKey: pairB.publicKey,
      entities: ['*'],
      ops: ['trace'],
      mayIssue: false,
      expires: new Date('2027-05-01T00:00:00Z'),
    });
    expect(child.ok).toBe(true);
    if (child.ok) {
      const childTrace = generalDoor(
        'trace',
        ['msg-123', '--general', child.path, '--key', keyPathB],
        makeIo(),
      );
      expect(childTrace.kind).toBe('admitted');
      const childOrder = generalDoor(
        'order',
        ['--general', child.path, '--key', keyPathB],
        makeIo(),
      );
      expect(childOrder.kind).toBe('refused');
    }
  });

  test('probe 3: option values are never read as flags (daemon --inherited, order --file/--session, down --session)', () => {
    // 3a. VALUED entries for daemon, order, and trace match contract/cli.json:
    expect(VALUED.daemon).toEqual(['home', 'inherited', 'root', 'route', 'started-by']);
    expect(VALUED.order).toEqual(['file', 'session']);
    expect(VALUED.trace).toEqual([]);

    // 3b. `down --session --abandon` under a `down`-only grant consumes `--abandon` as the value of `--session`,
    // never reading `--abandon` as the op-changing flag:
    const downOnlyGrant = issueGrant(['down']);
    const downWithValuedSession = runDoor('down', ['--session', '--abandon'], downOnlyGrant);
    expect(downWithValuedSession.kind).toBe('admitted');
    // Whereas real `--abandon` flag is refused by a `down`-only grant:
    const downWithRealAbandon = runDoor('down', ['--abandon'], downOnlyGrant);
    expect(downWithRealAbandon.kind).toBe('refused');
    if (downWithRealAbandon.kind === 'refused') {
      expect(downWithRealAbandon.why).toContain('does not cover abandon');
    }

    // 3c. `daemon` with `--inherited` taking a flag-shaped value (`--abandon` or `--request`) consumes it as a value:
    const daemonOnlyGrant = issueGrant(['daemon']);
    const daemonDoor = runDoor(
      'daemon',
      ['run', '--inherited', '--abandon', '--root', root, '--started-by', '--request'],
      daemonOnlyGrant,
    );
    expect(daemonDoor.kind).toBe('admitted');
    if (daemonDoor.kind === 'admitted') {
      expect(daemonDoor.argv).toEqual([
        'run',
        '--inherited',
        '--abandon',
        '--root',
        root,
        '--started-by',
        '--request',
      ]);
    }

    // 3d. `order` with `--file` and `--session` taking flag-shaped values consumes them as values:
    const orderOnlyGrant = issueGrant(['order']);
    const orderDoor = runDoor('order', ['--file', '--abandon', '--session', '--request'], orderOnlyGrant);
    expect(orderDoor.kind).toBe('admitted');
    if (orderDoor.kind === 'admitted') {
      expect(orderDoor.argv).toEqual(['--file', '--abandon', '--session', '--request']);
    }

    // 3e. `up` (an OWN_GENERAL command) with `--session --request` consumes `--request` as `--session`'s value
    // instead of triggering the `--general is its own door: it takes no --request` refusal:
    const upOnlyGrant = issueGrant(['up']);
    const upPass = runDoor('up', ['--session', '--request'], upOnlyGrant);
    expect(upPass.kind).toBe('pass');
    // Contrast with real `--request` flag on `up`:
    const upRealRequest = runDoor('up', ['--request'], upOnlyGrant);
    expect(upRealRequest.kind).toBe('usage');
    if (upRealRequest.kind === 'usage') {
      expect(upRealRequest.why).toContain('--general is its own door: it takes no --request');
    }
  });

  test('probe 4: wildcards admit order and trace immediately and follow the unreleased-ops rule', () => {
    // 4a. Every command in the dispatcher is in GENERAL_OPS. An op no release has shipped stays
    // unreleased, so an older wildcard does not gain it. checkpoint and show have no release yet.
    for (const cmd of Object.keys(commands)) {
      expect(GENERAL_OPS as readonly string[]).toContain(cmd);
    }
    const unreleased = GENERAL_OPS.filter((op: GeneralOp) => OP_FIRST_SHIPPED[op] === null).sort();
    expect(unreleased).toEqual(['checkpoint', 'show']);

    // 4b. A wildcard grant signed at v0.5.11 admits `order` and `trace` right now, and reports the
    // four ops 0.5.12 first shipped as having shipped in a later release:
    const wildcardAt0511 = issueGrant(['*'], { issuedAt: new Date('2026-11-02T12:21:36+01:00') });
    expect(runDoor('order', ['--session', 'alpha'], wildcardAt0511).kind).toBe('admitted');
    expect(runDoor('trace', ['msg-1'], wildcardAt0511).kind).toBe('admitted');

    const widened = wildcardGrantsWidened(home, new Date('2026-11-06T00:00:00Z'));
    const at0511 = widened.find(
      (w) => w.grant.grant_id === wildcardAt0511.split('/').pop()?.replace('.json', ''),
    );
    expect(at0511?.ops).toEqual(['fallback', 'order', 'trace', 'waits']);

    // A wildcard grant signed at v0.5.12's own time has no later release to reach.
    const wildcardAt0512 = issueGrant(['*'], { issuedAt: new Date('2026-11-05T22:50:33Z') });
    const later = wildcardGrantsWidened(home, new Date('2026-11-06T00:00:00Z'));
    expect(
      later.find((w) => w.grant.grant_id === wildcardAt0512.split('/').pop()?.replace('.json', '')),
    ).toBeUndefined();
  });
});
