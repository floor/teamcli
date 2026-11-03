// The `webhook-sender-deadline-ms` policy: how long a send's own arrival post waits on the
// receiving seat's webhook routine. The catalogue entry is enforced, entity to project to team,
// 3000 milliseconds by default and whole milliseconds from 500 to 10000, a shorter word being the
// tighter one; the reader resolves the receiving team's chain to the team level and leaves the
// default in force when the chain cannot be read. A routine that answers in 1.2 s is posted under
// the default; a signed team word of 500 ms cuts the same post off at 500 ms and reports the
// answer unknown, never failed, with the claim kept so nobody posts the record again.
//
// Every policy write here is signed with the scratch home's own key; nothing reads a live policy.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { postArrivalWebhook } from '../src/bus/webhook.ts';
import { entitiesPath } from '../src/entities.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { normalizePolicyName, POLICY_CATALOGUE, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { signRecord, type RecordPayload, type SignedRecord } from '../src/send/record.ts';
import { WEBHOOK_SENDER_DEADLINE_MS } from '../src/settings/webhook-sender.ts';
import { webhookSenderDeadlineMs } from '../src/settings/webhook-sender-policy.ts';

const TEAM = `format: 1
entity: floor
project: beacon
session: beacon
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
    launch: claude
`;

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let base = '';
let root = '';
let home = '';

beforeEach(() => {
  base = realpathSync(mkdtempSync(join('/private/tmp', 'team-webhook-deadline-')));
  root = join(base, 'acme');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  writeFileSync(join(root, 'hook-url'), 'http://127.0.0.1:1/routine\n');
  writeFileSync(join(root, 'hook-secret'), 'synthetic-secret-value\n', { mode: 0o600 });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function teamAt(): TeamFile {
  const parsed = validateTeamFile(readFileSync(join(root, '.agents', 'team.yaml'), 'utf8'));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.team;
}

function deadline(): number {
  return webhookSenderDeadlineMs({ home, root, team: teamAt() });
}

function signedAtTeam(name: string, value: number): void {
  const wrote = writePolicySet(home, { level: 'team', target: teamIdOf(root), teamRoot: root, name, value }, { now: new Date() });
  if (!wrote.ok) throw new Error(`the signed ${name} was refused: ${wrote.why}`);
}

function signedAtEntity(name: string, value: number): void {
  const wrote = writePolicySet(home, { level: 'entity', target: 'floor', name, value }, { now: new Date() });
  if (!wrote.ok) throw new Error(`the signed ${name} was refused: ${wrote.why}`);
}

function messagePayload(): RecordPayload {
  return {
    kind: 'message',
    id: ID,
    to: 'iris',
    to_id: null,
    root,
    session: 'beacon',
    at: '2026-11-03T00:00:00.000Z',
    body: 'from lead\n\nhello from the deadline scene\n',
    from: 'lead',
    from_id: null,
    rule: 'a synthetic admission',
    thread: ID,
  };
}

function dropFolder(): string {
  const dir = join(root, '.agents', 'send-drops', 'beacon', 'iris');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A transport that answers 2xx after `ms`, or refuses when the request's own signal aborts. */
function answersAfter(ms: number): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('ok', { status: 200 })), ms);
      const signal = init?.signal;
      if (signal === null || signal === undefined) return;
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          const error = new Error('the answer never came');
          error.name = 'TimeoutError';
          reject(error);
        },
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
}

async function post(
  init: { team?: TeamFile; fetch: typeof fetch; dir: string; message: SignedRecord },
): Promise<Awaited<ReturnType<typeof postArrivalWebhook>>> {
  return postArrivalWebhook({
    seat: 'iris',
    webhook: { urlFile: join(root, 'hook-url'), secretFile: join(root, 'hook-secret'), body: 'inbox' },
    ...(init.team === undefined ? {} : { team: init.team }),
    root,
    session: 'beacon',
    id: ID,
    from: 'lead',
    message: init.message,
    dropDir: init.dir,
    home,
    now: () => new Date(),
    fetch: init.fetch,
  });
}

describe('the webhook-sender-deadline catalogue entry', () => {
  test('enforced, entity to team, 3000 ms by default, whole milliseconds 500 to 10000', () => {
    const entry = POLICY_CATALOGUE['webhook-sender-deadline-ms'];
    expect(entry.kind).toBe('enforced');
    expect(entry.levels).toEqual(['entity', 'project', 'team']);
    expect(entry.defaultValue).toBe(3000);
    expect(entry.defaultValue).toBe(WEBHOOK_SENDER_DEADLINE_MS);
    expect(entry.parseValue(500)).toBe(500);
    expect(entry.parseValue(3000)).toBe(3000);
    expect(entry.parseValue('3500')).toBe(3500);
    expect(entry.parseValue(10_000)).toBe(10_000);
    expect(entry.parseValue(499)).toBeNull();
    expect(entry.parseValue(10_001)).toBeNull();
    expect(entry.parseValue('1.5')).toBeNull();
    expect(entry.valueProblem?.(10)).toContain('whole number of milliseconds from 500 to 10000');
    // A shorter or equal bound is the tighter one.
    expect(entry.isWithin?.(500, 3000)).toBe(true);
    expect(entry.isWithin?.(3000, 500)).toBe(false);
    expect(entry.isWithin?.(3000, 3000)).toBe(true);
    expect(normalizePolicyName('webhook_sender_deadline_ms')).toBe('webhook-sender-deadline-ms');
    expect(normalizePolicyName('webhook_sender_deadline')).toBe('webhook-sender-deadline-ms');
  });
});

describe('the deadline the receiving team resolves', () => {
  test('nothing declared reads the release default', () => {
    expect(deadline()).toBe(3000);
  });

  test('a signed team word is the one in force', () => {
    signedAtTeam('webhook-sender-deadline-ms', 800);
    expect(deadline()).toBe(800);
  });

  test('a looser word above a tighter team word cannot be read: the default stands', () => {
    // The team word lands first, when it has nothing above it; the entity word that would make
    // it a loosening lands second, and only the load sees the pair.
    signedAtTeam('webhook-sender-deadline-ms', 5000);
    signedAtEntity('webhook-sender-deadline-ms', 800);
    expect(deadline()).toBe(3000);
  });

  test('a chain that cannot be read keeps the default', () => {
    signedAtEntity('webhook-sender-deadline-ms', 900);
    expect(deadline()).toBe(900);
    writeFileSync(entitiesPath(home), 'entities: [unclosed\n');
    expect(deadline()).toBe(3000);
  });
});

describe("the send's own post under the deadline", () => {
  test('a routine that answers in 1.2 s is posted under the default', async () => {
    const dir = dropFolder();
    const message = signRecord(messagePayload(), home);
    const started = performance.now();
    const outcome = await post({ team: teamAt(), fetch: answersAfter(1200), dir, message });
    const elapsed = performance.now() - started;
    expect(outcome.kind).toBe('posted');
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    // The claim ended as the mark the bus adapter skips.
    expect(existsSync(join(dir, `${ID}.posting`))).toBe(false);
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(true);
  }, 10_000);

  test('a signed team word of 500 ms narrows the bound, and the answer is unknown, never failed', async () => {
    signedAtTeam('webhook-sender-deadline-ms', 500);
    const dir = dropFolder();
    const message = signRecord(messagePayload(), home);
    const started = performance.now();
    const outcome = await post({ team: teamAt(), fetch: answersAfter(60_000), dir, message });
    const elapsed = performance.now() - started;
    expect(outcome).toEqual({ kind: 'unknown', reason: 'no answer within 500 ms' });
    // The team's 500 ms, not the release default's 3000.
    expect(elapsed).toBeLessThan(2500);
    // The claim stays in `sent`: the bytes may have reached the routine, so nobody posts again.
    const held = JSON.parse(readFileSync(join(dir, `${ID}.posting`), 'utf8')) as { state: string };
    expect(held.state).toBe('sent');
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(false);
  }, 10_000);
});
