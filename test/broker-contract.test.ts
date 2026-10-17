// The output contract for `team broker` (`docs/reference/output.md` row 36): a daemon surface
// with no `--json` on the loop — an unknown option is an invocation refusal on stderr, with the
// usage and exit 2 — every startup and refusal line on stderr and nothing on stdout, and a usage
// that closes with the matrix footer sentence.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBroker, USAGE } from '../src/commands/broker.ts';
import { createRepository, type Repository } from './check/repository.ts';
import { testIo } from './helpers.ts';

const PROJECT = '01234567-89ab-cdef-0123-456789abcdef';
const KEY = 'test-key-not-real';

const SEATS = `seats:
  - role: coordinator
    name: lead
    cli: claude-code
    vendor: anthropic
    model: Claude Opus
    version: "5.5"
    launch: claude --model claude-opus-5-5
`;

/** A tracker source: the broker's one served source. */
const LINEAR = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
${SEATS}tasks:
  source: linear
  linear:
    project: ${PROJECT}
    keychainService: team.linear.acme
`;

/** A file source: the refusal the broker gives before the keychain is asked. */
const FILE_SOURCE = `format: 1
project: acme
coordinator: lead
operator: lead
workspace:
  mode: shared
${SEATS}tasks:
  source: file
  path: .agents/tasks.yaml
`;

const FOOTER = "Exits 0 when it stopped, 1 when it refused to start or lost its socket, 2 when the\ninvocation can't be read or this folder is not a git checkout.\n";

let repo: Repository;
let home: string;

beforeAll(() => {
  repo = createRepository();
  home = mkdtempSync(join(tmpdir(), 'team-broker-contract-home-'));
  mkdirSync(join(repo.path, '.agents'), { recursive: true });
});

afterAll(() => {
  repo.remove();
  rmSync(home, { recursive: true, force: true });
});

/** Writes the clone's team file. */
function teamFile(text: string): void {
  writeFileSync(join(repo.path, '.agents', 'team.yaml'), text);
}

/** Polls until the broker has printed its first line, so the stop can be armed before it is
 *  awaited. A missed start fails the assertion that follows, not this loop. */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await Bun.sleep(5);
}

describe('team broker follows the output contract', () => {
  test('the usage names no --json and closes with the matrix footer sentence', () => {
    expect(USAGE).toStartWith('Usage: team broker\n');
    expect(USAGE).not.toContain('--json');
    expect(USAGE).toEndWith(FOOTER);
  });

  test('--json is an invocation refusal: on stderr, with the usage, and exit 2', async () => {
    const io = testIo(repo.path, { kind: 'owner' });
    const code = await runBroker(['--json'], io, { home });
    expect(code).toBe(2);
    expect(io.out).toBe('');
    expect(io.err).toBe(`team broker: unknown option --json\n${USAGE}`);
  });

  test('a source it does not serve is refused on stderr, with nothing on stdout', async () => {
    teamFile(FILE_SOURCE);
    const io = testIo(repo.path, { kind: 'owner' });
    const code = await runBroker([], io, {
      home,
      keyReader: async () => {
        throw new Error('the keychain must not be read for a source the broker does not serve');
      },
    });
    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe('team broker: tasks.source must be linear; the broker serves a tracker source\n');
  });

  test('a seat is refused on stderr before any file is read, with nothing on stdout', async () => {
    const io = testIo(repo.path, { kind: 'seat', name: 'worker', pane: 'w2:p1' });
    const code = await runBroker([], io, {
      home,
      keyReader: async () => {
        throw new Error('the keychain must not be read for a seat');
      },
    });
    expect(code).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toBe(
      'team broker: only the owner runs `broker`, from a terminal outside herdr; this call is worker\n',
    );
  });

  test('the serve loop writes every line to stderr and nothing to stdout', async () => {
    teamFile(LINEAR);
    const io = testIo(repo.path, { kind: 'owner' });
    let finish!: () => void;
    const running = runBroker([], io, {
      home,
      keyReader: async () => ({ ok: true, key: KEY }),
      fetch: () => {
        throw new Error('no tracker request is expected without a client');
      },
      stop: (end) => {
        finish = end;
        return () => {};
      },
    });
    await waitFor(() => io.err.includes('answering on') || io.err.includes('team broker: '));
    finish();
    expect(await running).toBe(0);
    expect(io.out).toBe('');
    expect(io.err).toBe('team broker: answering on .agents/broker.sock\nteam broker: stopped\n');
  });
});
