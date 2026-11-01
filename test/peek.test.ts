// `team peek`: the last lines of a seat's screen, read and printed, never typed into. Every
// scene pins its caller and hands in its own source: no scene reads a real pane or asks a real
// process where it stands.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_LINES, MAX_LINES, runPeek, type PeekSources } from '../src/commands/peek.ts';
import { currentTeam } from '../src/file/current.ts';
import { KEY_PREFIXES, maskSecretsLine } from '../src/file/secrets.ts';
import { emptySession, updateState } from '../src/state.ts';
import { herdrStatusSource, type StatusSource } from '../src/watch/status-events.ts';
import { testIo, type TestIo } from './helpers.ts';

const TEAM = `format: 1
project: acme
coordinator: clerk
operator: clerk
session: acme
workspace:
  mode: shared
seats:
  - role: coordinator
    name: clerk
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude
    leads: true
  - role: worker
    name: worker-1
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude
  - role: worker
    name: desk
    cli: claude-code
    vendor: anthropic
    model: Claude Sonnet
    version: "5.5"
    launch: claude
    human: true
`;

const NOW = new Date('2026-11-01T12:00:00.000Z');
const bases: string[] = [];

afterEach(() => {
  for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Place = { root: string; home: string };

function place(withFile = true): Place {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'team-peek-')));
  bases.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (withFile) writeFileSync(join(root, '.agents', 'team.yaml'), TEAM);
  return { root, home };
}

/** The fixture must load before any scene runs, so a broken fixture fails once and loudly. */
function checkFixture(where: Place): void {
  const current = currentTeam(where.root, undefined, NOW, where.home, false);
  if (!current.ok) throw new Error(`the fixture file did not load: ${JSON.stringify(current.errors)}`);
  if (current.team.session !== 'acme') throw new Error(`the fixture session is ${current.team.session}`);
}

function recordSeat(where: Place, name: string, pane: string): void {
  updateState(join(where.root, '.agents'), (state) => {
    (state.sessions.acme ??= emptySession()).seats[name] = { stage: 'ready', pane };
  });
}

const owner = (where: Place): TestIo => testIo(where.root, { kind: 'owner' });
// A placed seat carries the session it was placed in: a seat built by hand without one is
// refused by the read gate, whatever pane it names.
const seat = (where: Place, name: string, pane = 'pane1'): TestIo =>
  testIo(where.root, { kind: 'seat', name, pane, session: 'acme' });

type Seen = { seat?: string; pane?: string; lines?: number };

function screen(text: string | null, seen?: Seen): StatusSource {
  return {
    async waitStatus() {
      return { outcome: 'timeout', at: NOW.getTime() };
    },
    screenText(reading, lines) {
      if (seen) {
        seen.seat = reading.name;
        seen.pane = reading.pane;
        seen.lines = lines;
      }
      return text;
    },
  };
}

/** A source with no screen reader at all: the contract member is optional. */
const NO_READER: StatusSource = {
  async waitStatus() {
    return { outcome: 'timeout', at: NOW.getTime() };
  },
};

async function peek(
  where: Place,
  argv: string[],
  io: TestIo,
  source?: StatusSource,
  env: Record<string, string | undefined> = {},
): Promise<number> {
  io.env = env;
  const sources: PeekSources = {
    home: where.home,
    now: () => NOW,
    ...(source ? { source } : {}),
  };
  return runPeek(argv, io, sources);
}

function logOf(where: Place): string {
  try {
    return readFileSync(join(where.root, '.agents', 'team.log'), 'utf8');
  } catch {
    return '';
  }
}

describe('team peek', () => {
  test('prints the last lines of a seat\'s screen, and reads the pane the state recorded', async () => {
    const where = place();
    checkFixture(where);
    recordSeat(where, 'worker-1', 'pane1');
    const seen: Seen = {};
    const io = owner(where);
    expect(await peek(where, ['worker-1'], io, screen('first\nsecond\nthird\n', seen))).toBe(0);
    expect(io.out).toBe('first\nsecond\nthird\n');
    expect(io.err).toBe('');
    expect(seen).toEqual({ seat: 'worker-1', pane: 'pane1', lines: DEFAULT_LINES });
    expect(DEFAULT_LINES).toBe(50);
  });

  test('--lines bounds the screen, within 1 and the maximum', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const sixty = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
    const seen: Seen = {};
    const io = owner(where);
    expect(await peek(where, ['worker-1', '--lines', '2'], io, screen(sixty, seen))).toBe(0);
    expect(io.out).toBe('line 58\nline 59\n');
    expect(seen.lines).toBe(2);

    const all = owner(where);
    expect(await peek(where, ['worker-1'], all, screen(sixty))).toBe(0);
    expect(all.out.split('\n').filter((line) => line !== '')).toHaveLength(50);
    expect(all.out.startsWith('line 10\n')).toBe(true);

    const most = owner(where);
    const sixHundred = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n');
    expect(await peek(where, ['worker-1', '--lines', String(MAX_LINES)], most, screen(sixHundred))).toBe(0);
    expect(most.out.split('\n').filter((line) => line !== '')).toHaveLength(500);
    expect(MAX_LINES).toBe(500);
  });

  test('an out-of-range or malformed --lines is a usage error, and no screen is read', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    for (const asked of ['0', '501', 'abc', '-1', '1.5']) {
      const seen: Seen = {};
      const io = owner(where);
      expect(await peek(where, ['worker-1', '--lines', asked], io, screen('hello', seen))).toBe(2);
      expect(io.out).toBe('');
      expect(io.err).toContain('--lines is a whole number from 1 to 500');
      expect(seen.lines).toBeUndefined();
    }
  });

  test('a seat name is required, one seat only, and no other option', async () => {
    const where = place();
    const missing = owner(where);
    expect(await peek(where, [], missing, screen('hello'))).toBe(2);
    expect(missing.err).toContain('a <seat> is required');

    const two = owner(where);
    expect(await peek(where, ['worker-1', 'clerk'], two, screen('hello'))).toBe(2);
    expect(two.err).toContain('unexpected "clerk"');

    const unknown = owner(where);
    expect(await peek(where, ['worker-1', '--json'], unknown, screen('hello'))).toBe(2);
    expect(unknown.err).toContain('unknown option --json');
  });

  test('a seat the state places on its recorded pane reads its own team', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const io = seat(where, 'worker-1', 'pane1');
    expect(await peek(where, ['worker-1'], io, screen('hello\n'))).toBe(0);
    expect(io.out).toBe('hello\n');
    expect(io.err).toBe('');
  });

  test('a seat on another pane learns nothing, and the refusal is logged', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const io = seat(where, 'worker-1', 'pane2');
    expect(await peek(where, ['worker-1'], io, screen('hello'))).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toBe('team peek: this team is not yours to read\n');
    expect(logOf(where)).toContain('peek [worker-1] refused peek.not-yours');
  });

  test('a machine in dev mode lifts the read gate, and says so in the warning and the log', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const io = testIo(where.root, { kind: 'seat', name: 'nobody', pane: 'pane9', session: 'acme' });
    expect(await peek(where, ['worker-1'], io, screen('hello\n'), { TEAMCLI_DEV_MODE: '1' })).toBe(0);
    expect(io.out).toBe('hello\n');
    expect(io.err).toBe('warning: this team is not yours to read; dev mode continues\n');
    expect(logOf(where)).toContain('warning: this team is not yours to read; dev mode continues');
  });

  test('a name the team does not declare is an unknown seat, and the refusal is logged', async () => {
    const where = place();
    const io = owner(where);
    expect(await peek(where, ['ghost'], io, screen('hello'))).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team peek: no seat named "ghost" in this team\n');
    expect(logOf(where)).toContain('peek [owner] refused peek.unknown: seat ghost');
  });

  test('the owner\'s pane is never read, and the refusal is logged', async () => {
    const where = place();
    const io = owner(where);
    expect(await peek(where, ['desk'], io, screen('a private screen'))).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team peek: "desk" is the owner\'s pane, and the owner\'s pane is never read\n');
    expect(logOf(where)).toContain('peek [owner] refused peek.owner-pane: seat desk');
    expect(logOf(where)).not.toContain('a private screen');
  });

  test('a seat with no recorded pane, no screen reader, or an unreadable pane has no screen', async () => {
    const where = place();
    const unrecorded = owner(where);
    expect(await peek(where, ['worker-1'], unrecorded, screen('hello'))).toBe(2);
    expect(unrecorded.err).toBe('team peek: no screen is readable for seat "worker-1"\n');

    recordSeat(where, 'worker-1', 'pane1');
    const noReader = owner(where);
    expect(await peek(where, ['worker-1'], noReader, NO_READER)).toBe(2);
    expect(noReader.err).toBe('team peek: no screen is readable for seat "worker-1"\n');

    const unreadable = owner(where);
    expect(await peek(where, ['worker-1'], unreadable, screen(null))).toBe(2);
    expect(unreadable.err).toBe('team peek: no screen is readable for seat "worker-1"\n');

    const log = logOf(where);
    expect(log.match(/refused peek\.no-screen: seat worker-1/g)).toHaveLength(3);
  });

  test('the owner reads the file\'s load failure; anyone else gets the one sentence and no log', async () => {
    const bare = place(false);
    const ownerIo = owner(bare);
    expect(await peek(bare, ['worker-1'], ownerIo, screen('hello'))).toBe(2);
    expect(ownerIo.out).toBe('');
    expect(ownerIo.err.startsWith('team peek: ')).toBe(true);
    expect(ownerIo.err.trim().split('\n').length).toBeGreaterThan(0);
    expect(logOf(bare)).toBe('');

    const other = seat(bare, 'worker-1', 'pane1');
    expect(await peek(bare, ['worker-1'], other, screen('hello'))).toBe(2);
    expect(other.err).toBe('team peek: this team is not yours to read\n');
    expect(logOf(bare)).toBe('');
  });

  test('the window is the last lines, and one trailing blank line is the screen\'s own', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const io = owner(where);
    expect(await peek(where, ['worker-1', '--lines', '2'], io, screen('one\ntwo\nthree\n\n'))).toBe(0);
    expect(io.out).toBe('three\n\n');
    expect(logOf(where)).toContain('seat worker-1, 2 lines');
  });

  test('the log records who looked, at which seat and how many lines, and never the screen', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const io = owner(where);
    expect(await peek(where, ['worker-1'], io, screen('a quiet\nthree line\nscreen\n'))).toBe(0);
    const line = logOf(where).trimEnd().split('\n').at(-1) as string;
    expect(line.endsWith(` peek [owner] team acme: seat worker-1, 3 lines`)).toBe(true);
    expect(line.startsWith(NOW.toISOString())).toBe(true);
    expect(logOf(where)).not.toContain('a quiet');
    expect(logOf(where)).not.toContain('screen');
  });
});

describe('a screen is masked before it is printed', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const shortSha = 'a1b2c3d';
  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  test('a 40-character sha, a 7-character short sha and a UUID render as they stand', () => {
    // What looksRandom says, as measured — not tuned: hex and a UUID sit under its entropy
    // threshold, so a pane full of commit ids stays readable.
    expect(maskSecretsLine(`commit ${sha}`)).toBe(`commit ${sha}`);
    expect(maskSecretsLine(`short ${shortSha}`)).toBe(`short ${shortSha}`);
    expect(maskSecretsLine(`request ${uuid}`)).toBe(`request ${uuid}`);
  });

  test('keys, private-key headers, URL userinfo and random-looking words are masked', () => {
    const token = `sk-${'a'.repeat(20)}`;
    expect(maskSecretsLine(`token ${token}`)).toBe('token [masked]');
    expect(maskSecretsLine('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe('[masked]');
    expect(maskSecretsLine('clone https://alice:hunter2@example.test/repo.git')).toBe('clone https://[masked]@example.test/repo.git');
    expect(maskSecretsLine('value Zx9Kq2LmN4pR7sT1uV3wY6aB8cD0eF2gH5jK9mN')).toBe('value [masked]');
  });

  test('every userinfo URL on a line is masked, not only the first', () => {
    // A line can carry two remotes; the second one is no less a credential than the first.
    expect(maskSecretsLine('fetch https://alice:first-secret@one.test/a https://bob:second-secret@two.test/b'))
      .toBe('fetch https://[masked]@one.test/a https://[masked]@two.test/b');
  });

  test('a token of every key prefix is masked in every wrapper', () => {
    // The body is 16 characters: enough after every prefix, and too plain and too short for the
    // randomness rule, so only the prefix shape can mask these lines.
    const body = 'abcdefghijklmnop';
    const wrappers: { where: string; line: (token: string) => string }[] = [
      { where: 'bare at the start and end', line: (token) => token },
      { where: 'backtick', line: (token) => `key \`${token}\`` },
      { where: 'parenthesis', line: (token) => `key (${token})` },
      { where: 'bracket', line: (token) => `key [${token}]` },
      { where: 'brace', line: (token) => `key {${token}}` },
      { where: 'double quote', line: (token) => `key "${token}"` },
      { where: 'single quote', line: (token) => `key '${token}'` },
      { where: 'colon', line: (token) => `key:${token}` },
      { where: 'equals', line: (token) => `key=${token}` },
      { where: 'comma', line: (token) => `before,${token},after` },
      { where: 'line start', line: (token) => `${token} after` },
      { where: 'line end', line: (token) => `before ${token}` },
    ];
    for (const prefix of KEY_PREFIXES) {
      const token = `${prefix}${body}`;
      for (const wrapper of wrappers) {
        const line = wrapper.line(token);
        expect({ prefix, where: wrapper.where, masked: maskSecretsLine(line) })
          .toEqual({ prefix, where: wrapper.where, masked: line.replace(token, '[masked]') });
      }
    }
  });

  test('several secrets on one line are all masked', () => {
    const one = `ghp_${'a'.repeat(20)}`;
    const two = `glpat-${'b'.repeat(20)}`;
    const three = `npm_${'c'.repeat(20)}`;
    const line = `a \`${one}\` b (${two}) c https://u:p@one.test/x https://v:q@two.test/y ${three}`;
    const masked = 'a `[masked]` b ([masked]) c https://[masked]@one.test/x https://[masked]@two.test/y [masked]';
    expect(maskSecretsLine(line)).toBe(masked);
  });

  test('masking a masked line changes nothing more', () => {
    // The masker re-scans what it produced: no known prefix or userinfo URL may survive a pass.
    const once = maskSecretsLine('a `ghp_aaaaaaaaaaaaaaaaaaaa` https://u:p@one.test/x');
    expect(maskSecretsLine(once)).toBe(once);
  });

  test('a prefix shape inside a longer word is not a token', () => {
    // `risk-` contains `sk-`, but a token starts where a non-token character precedes it.
    expect(maskSecretsLine('risk-assessment-strategy-document')).toBe('risk-assessment-strategy-document');
  });

  test('a peek masks its printed screen and still logs no text', async () => {
    const where = place();
    recordSeat(where, 'worker-1', 'pane1');
    const token = `sk-${'a'.repeat(20)}`;
    const body = [
      `deploy token ${token}`,
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      `commit ${sha}`,
    ].join('\n');
    const io = owner(where);
    expect(await peek(where, ['worker-1'], io, screen(body))).toBe(0);
    expect(io.out).toContain('[masked]');
    expect(io.out).not.toContain(token);
    expect(io.out).toContain(sha);
    expect(logOf(where)).not.toContain('deploy');
    expect(logOf(where)).not.toContain(token);
  });
});

describe('team peek is a read path by construction', () => {
  test('the module imports nothing outside its read-only allowlist', () => {
    // The allowlist is the call graph: argv, the read gate and dev mode, the team file, the
    // screen source, the masker and the log. A later edit that adds a typing or sending path
    // fails here before it can run.
    const allowed = [
      'node:os',
      '../args.ts',
      '../caller.ts',
      '../delegate.ts',
      '../dev_mode.ts',
      '../file/current.ts',
      '../file/load.ts',
      '../file/secrets.ts',
      '../file/types.ts',
      '../io.ts',
      '../launch/plain.ts',
      '../log.ts',
      '../read-gate.ts',
      '../state.ts',
      '../watch/status-events.ts',
    ];
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'commands', 'peek.ts'), 'utf8');
    const imports = [...source.matchAll(/^import(?: type)?[^'"]*from '([^']+)';?$/gm)].map((match) => match[1] as string);
    expect(imports.sort()).toEqual([...allowed].sort());
    expect(source).not.toMatch(/\b(sendKeys|typeText|paneType|paneSend|pressEnter)\b/);
  });
});

describe('the screen source', () => {
  test('reads the pane through its own reader and reports a person\'s pane as no screen', () => {
    const calls: Array<[string, number, string | undefined]> = [];
    const source = herdrStatusSource({
      session: 'acme',
      readPane: (pane, lines, session) => {
        calls.push([pane, lines, session]);
        return 'one\ntwo';
      },
    });
    expect(source.screenText?.({ name: 'worker-1', pane: 'pane1', cli: 'claude-code' }, 20)).toBe('one\ntwo');
    expect(calls).toEqual([['pane1', 20, 'acme']]);
    // A seat's own session names the one it stands in, over the source's default.
    expect(source.screenText?.({ name: 'worker-1', pane: 'pane1', cli: 'claude-code', session: 'other' }, 5)).toBe('one\ntwo');
    expect(calls.at(-1)).toEqual(['pane1', 5, 'other']);
    // A human seat has no screen a tool reads, and the reader is never called for it.
    expect(source.screenText?.({ name: 'desk', pane: 'pane2', cli: 'claude-code', human: true }, 20)).toBeNull();
    expect(calls).toHaveLength(2);
  });
});
