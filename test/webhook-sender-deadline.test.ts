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
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { postArrivalWebhook, type LateWebhook } from '../src/bus/webhook.ts';
import { entitiesPath } from '../src/entities.ts';
import type { TeamFile } from '../src/file/types.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import { normalizePolicyName, POLICY_CATALOGUE, writePolicySet } from '../src/policy/index.ts';
import { teamIdOf } from '../src/registry/teams.ts';
import { signRecord, type RecordPayload, type SignedRecord } from '../src/send/record.ts';
import { statusOfOutcome } from '../src/send/history.ts';
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

if (process.argv.includes('--measure-exit')) {
  const specPath = process.argv[process.argv.indexOf('--measure-exit') + 1] ?? '';
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Omit<Parameters<typeof postArrivalWebhook>[0], 'now'>;
  process.stdout.write('start\n');
  void postArrivalWebhook({ ...spec, now: () => new Date() });
} else {
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

/** A transport that answers `status` after `ms`, or refuses when the request's own signal aborts.
 *  `calls` counts how many times the one request was handed over. */
function answersAfter(ms: number, status = 200, calls?: { n: number }): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (calls !== undefined) calls.n += 1;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('ok', { status })), ms);
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

async function lateOf(outcome: Awaited<ReturnType<typeof postArrivalWebhook>>): Promise<LateWebhook> {
  if (outcome.kind !== 'unknown' || outcome.late === undefined) throw new Error(`no continuation on ${outcome.kind}`);
  return outcome.late;
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
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') expect(outcome.reason).toBe('no answer within 500 ms');
    // The team's 500 ms, not the release default's 3000, and not the policy max.
    expect(elapsed).toBeLessThan(2500);
    // The claim stays in `sent` at the deadline: the bytes may have reached the routine.
    const held = JSON.parse(readFileSync(join(dir, `${ID}.posting`), 'utf8')) as { state: string };
    expect(held.state).toBe('sent');
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(false);
    // The cap elapses with no answer. The claim is still `sent`, and nothing was posted twice.
    expect(await lateOf(outcome)).toEqual({ kind: 'unanswered' });
    const after = JSON.parse(readFileSync(join(dir, `${ID}.posting`), 'utf8')) as { state: string };
    expect(after.state).toBe('sent');
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(false);
  }, 15_000);

  test('a 2xx after the deadline settles the claim and is not a second post', async () => {
    signedAtTeam('webhook-sender-deadline-ms', 500);
    const dir = dropFolder();
    const message = signRecord(messagePayload(), home);
    const calls = { n: 0 };
    const started = performance.now();
    const outcome = await post({ team: teamAt(), fetch: answersAfter(800, 200, calls), dir, message });
    expect(performance.now() - started).toBeLessThan(2500);
    expect(outcome.kind).toBe('unknown');
    const late = await lateOf(outcome);
    expect(late.kind).toBe('posted');
    if (late.kind === 'posted') expect(late.ms).toBeGreaterThanOrEqual(700);
    expect(calls.n).toBe(1);
    expect(existsSync(join(dir, `${ID}.posting`))).toBe(false);
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(true);
    expect(statusOfOutcome('delivered (late)')).toBe('delivered');
  }, 10_000);

  test('a 5xx after the deadline is failed and the claim stays sent', async () => {
    signedAtTeam('webhook-sender-deadline-ms', 500);
    const dir = dropFolder();
    const message = signRecord(messagePayload(), home);
    const calls = { n: 0 };
    const outcome = await post({ team: teamAt(), fetch: answersAfter(800, 503, calls), dir, message });
    expect(outcome.kind).toBe('unknown');
    expect(await lateOf(outcome)).toEqual({ kind: 'failed', reason: 'HTTP 503' });
    expect(calls.n).toBe(1);
    const held = JSON.parse(readFileSync(join(dir, `${ID}.posting`), 'utf8')) as { state: string };
    expect(held.state).toBe('sent');
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(false);
  }, 10_000);

  test('a real child returns the sender at the deadline, and the late 2xx settles after that process is gone', async () => {
    signedAtTeam('webhook-sender-deadline-ms', 500);
    const dir = dropFolder();
    const message = signRecord(messagePayload(), home);
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Promise((resolve) => setTimeout(() => resolve(new Response('ok', { status: 200 })), 1500)),
    });
    try {
      writeFileSync(join(root, 'hook-url'), `${server.url.href}\n`);
      const spec = join(base, 'sender.json');
      writeFileSync(spec, JSON.stringify({
        seat: 'iris',
        webhook: { urlFile: join(root, 'hook-url'), secretFile: join(root, 'hook-secret'), body: 'inbox' },
        team: teamAt(),
        root,
        session: 'beacon',
        id: ID,
        from: 'lead',
        message,
        dropDir: dir,
        home,
        project: 'beacon',
        body: messagePayload().body,
      }));
      const entry = fileURLToPath(import.meta.url);
      const sender = spawn(process.execPath, [entry, '--measure-exit', spec], { stdio: ['ignore', 'pipe', 'ignore'] });
      let mark = 0;
      sender.stdout?.setEncoding('utf8');
      sender.stdout?.on('data', (chunk: string) => {
        if (mark === 0 && chunk.includes('start')) mark = performance.now();
      });
      const exitCode = await new Promise<number | null>((resolve) => {
        const killer = setTimeout(() => {
          sender.kill('SIGKILL');
          resolve(null);
        }, 2000);
        sender.on('exit', (code) => {
          clearTimeout(killer);
          resolve(code);
        });
      });
      const elapsed = mark === 0 ? 9999 : performance.now() - mark;
      // The sender's own process is gone at the bound. It does not stay up for the slow answer.
      expect(exitCode).toBe(0);
      expect(elapsed).toBeLessThan(700);
      expect(existsSync(join(dir, `${ID}.posted`))).toBe(false);
      const posted = join(dir, `${ID}.posted`);
      const until = Date.now() + 8_000;
      while (!existsSync(posted) && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(posted)).toBe(true);
      expect(existsSync(join(dir, `${ID}.posting`))).toBe(false);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test('a child whose stdin closes before the answer still settles and exits', async () => {
    const dir = dropFolder();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Promise((resolve) => setTimeout(() => resolve(new Response('ok', { status: 200 })), 300)),
    });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/bus/webhook.ts', import.meta.url)), '--finish-late'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const job = {
      url: server.url.href,
      headers: [] as [string, string][],
      body: '{}',
      capMs: 10_000,
      dropDir: dir,
      id: ID,
      project: '',
      root,
      home,
      session: 'beacon',
      from: 'lead',
      to: 'iris',
      messageBody: 'hello',
    };
    child.stdin?.end(`${JSON.stringify(job)}\n`);
    const exitCode = await new Promise<number | null>((resolve) => {
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(null);
      }, 3_000);
      child.on('exit', (code) => {
        clearTimeout(killer);
        resolve(code);
      });
    });
    server.stop(true);
    expect(exitCode).toBe(0);
    expect(existsSync(join(dir, `${ID}.posted`))).toBe(true);
  }, 10_000);
});
}
