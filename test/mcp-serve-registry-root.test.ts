// `team mcp serve` with no `--file`: the registry's roster names the team, and the folder the
// server starts in never does. Each scene starts the server from a lobby, from another team's
// folder or from the seat's own root, and reads the listener marker it writes while serving to
// say which team's inbox it opened. Fixtures are synthetic: temporary folders, invented seats,
// literal ids. No live team and no herdr.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenerPath } from '../src/mcp/inbox.ts';
import { runMcpServe, type ServeOptions } from '../src/mcp/serve.ts';
import { teamIdOf, teamsFile, upsertTeam } from '../src/registry/teams.ts';
import { testIo } from './helpers.ts';

type Seat = { name: string; cli: string; role?: string };

type Fixture = { root: string; id: string; project: string; session: string; seats: readonly Seat[] };

type Serving = ServeOptions;

function teamText(project: string, session: string, seats: readonly Seat[]): string {
  const rows = seats
    .map((seat, at) => `  - role: ${seat.role ?? (at === 0 ? 'coordinator' : 'worker')}
    name: ${seat.name}
    cli: ${seat.cli}
    vendor: synthetic
    model: Grok
    version: "4.7"
    launch: ${seat.cli === 'claude-code' ? 'claude' : 'codex'}`)
    .join('\n');
  return `format: 1
project: ${project}
coordinator: ${seats[0]!.name}
operator: ${seats[0]!.name}
session: ${session}
workspace:
  mode: shared
seats:
${rows}
`;
}

function world() {
  const made: string[] = [];
  let agents = 0;
  const folder = (tag: string): string => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), `team-serve-${tag}-`)));
    made.push(path);
    return path;
  };
  const home = folder('home');
  const place = (root: string, project: string, session: string, seats: readonly Seat[]): void => {
    // A team's root is a checkout: a folder inside a repository. The server must not take the
    // file it finds there for the team, so the scene gives it one to find.
    spawnSync('git', ['init', '--quiet'], { cwd: root });
    mkdirSync(join(root, '.agents'));
    writeFileSync(join(root, '.agents', 'team.yaml'), teamText(project, session, seats));
    return;
  };
  const rosterOf = (seats: readonly Seat[]) =>
    seats.map((seat, at) => ({
      agent: `agt_${String(++agents).padStart(12, '0')}`,
      seat: seat.name,
      role: seat.role ?? (at === 0 ? 'coordinator' : 'worker'),
    }));
  /** A team that exists in both places: its folder holds the file, the registry holds the roster. */
  const registered = (project: string, session: string, seats: readonly Seat[]): Fixture => {
    const root = folder(project);
    place(root, project, session, seats);
    const id = teamIdOf(root);
    upsertTeam(home, id, { project, session, root, roster: rosterOf(seats) });
    return { root, id, project, session, seats };
  };
  /** A folder holding a team file the registry knows nothing about. */
  const checkout = (project: string, session: string, seats: readonly Seat[]): string => {
    const root = folder(project);
    place(root, project, session, seats);
    return root;
  };
  const lobby = (): string => folder('lobby');
  return {
    home,
    registered,
    checkout,
    lobby,
    cleanup: () => {
      for (const path of made) rmSync(path, { recursive: true, force: true });
    },
  };
}

/** The marker the server writes into the drop folder of the team it serves, while it serves it. */
function marker(root: string, session: string, seat = 'lead'): string {
  return listenerPath(join(root, '.agents', 'send-drops', session, seat));
}

/** A stream whose lines only end when the scene says so, so a marker can be read mid-serve. */
function feed() {
  let ended = false;
  let wake: (() => void) | null = null;
  const lines = (async function* () {
    for (;;) {
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    streams: { lines, write: (_line: string): void => {} },
    end: (): void => {
      ended = true;
      const resume = wake;
      wake = null;
      resume?.();
    },
  };
}

async function startServing(
  from: string,
  options: Serving,
  candidates: readonly string[],
  home: string,
) {
  const io = testIo(from);
  const stream = feed();
  const ran = runMcpServe(options, io, stream.streams, { home });
  let settled = false;
  void ran.then(() => {
    settled = true;
  });
  let found: string | null = null;
  for (let wait = 0; wait < 600 && found === null && !settled; wait++) {
    found = candidates.find((path) => existsSync(path)) ?? null;
    if (found === null && !settled) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return { io, stream, ran, found };
}

/** Serves and asserts which team it served, by the marker's folder, root and session. */
async function servesTeam(input: {
  from: string;
  home: string;
  options: Serving;
  expected: { root: string; session: string; cli: string };
  others: readonly string[];
}): Promise<void> {
  const expected = marker(input.expected.root, input.expected.session);
  const run = await startServing(input.from, input.options, [expected, ...input.others], input.home);
  expect(run.found).toBe(expected);
  const listener = run.found === null ? null : (JSON.parse(readFileSync(run.found, 'utf8')) as Record<string, unknown>);
  expect(listener).toMatchObject({
    v: 1,
    seat: input.options.seat ?? 'lead',
    session: input.expected.session,
    root: input.expected.root,
    cli: input.expected.cli,
    pid: process.pid,
  });
  for (const other of input.others) expect(existsSync(other)).toBe(false);
  run.stream.end();
  expect(await run.ran).toBe(0);
  expect(run.io.err).toBe('');
  expect(existsSync(expected)).toBe(false);
}

async function refusal(from: string, options: Serving, home: string) {
  const io = testIo(from);
  const code = await runMcpServe(
    options,
    io,
    {
      lines: (async function* () {
        // It refuses before it reads a line.
      })(),
      write: (_line: string): void => {},
    },
    { home },
  );
  return { code, err: io.err };
}

const LEAD_CLAUDE: readonly Seat[] = [{ name: 'lead', cli: 'claude-code' }];
const LEAD_CODEX: readonly Seat[] = [{ name: 'lead', cli: 'codex' }, { name: 'worker', cli: 'codex' }];

describe('team mcp serve without --file: the registry names the team', () => {
  test('a lobby folder serves the team the roster holds the seat on', async () => {
    const at = world();
    try {
      const team = at.registered('acme', 'acme', LEAD_CLAUDE);
      const lobby = at.lobby();
      await servesTeam({
        from: lobby,
        home: at.home,
        options: { seat: 'lead', session: undefined },
        expected: { root: team.root, session: 'acme', cli: 'claude-code' },
        others: [],
      });
      // Nothing was read from, or written under, the folder the server started in.
      expect(existsSync(join(lobby, '.agents'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a folder holding another team file does not decide the team', async () => {
    const at = world();
    try {
      const team = at.registered('acme', 'acme', LEAD_CLAUDE);
      // The same seat name, a different team, in the very folder the server starts in.
      const other = at.checkout('beta', 'beta', LEAD_CODEX);
      await servesTeam({
        from: other,
        home: at.home,
        options: { seat: 'lead', session: undefined },
        expected: { root: team.root, session: 'acme', cli: 'claude-code' },
        others: [marker(other, 'beta')],
      });
      expect(existsSync(join(other, '.agents', 'send-drops'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('--session picks between two registered teams that both hold the seat name', async () => {
    const at = world();
    try {
      const acme = at.registered('acme', 'acme', LEAD_CLAUDE);
      const beta = at.registered('beta', 'beta', LEAD_CODEX);
      const lobby = at.lobby();
      await servesTeam({
        from: lobby,
        home: at.home,
        options: { seat: 'lead', session: 'beta' },
        expected: { root: beta.root, session: 'beta', cli: 'codex' },
        others: [marker(acme.root, 'acme')],
      });
    } finally {
      at.cleanup();
    }
  });

  test('without --session two holders are refused by id, and one is named', async () => {
    const at = world();
    try {
      const acme = at.registered('acme', 'acme', LEAD_CLAUDE);
      const beta = at.registered('beta', 'beta', LEAD_CODEX);
      const lobby = at.lobby();
      const ids = [acme.id, beta.id].sort();
      const refused = await refusal(lobby, { seat: 'lead', session: undefined }, at.home);
      expect(refused.code).toBe(2);
      expect(refused.err).toBe(
        `team mcp serve: seat "lead" is on 2 registered teams (${ids.join(', ')}); pass --file to say which\n`,
      );
      for (const team of [acme, beta]) expect(existsSync(join(team.root, '.agents', 'send-drops'))).toBe(false);
      // A session neither team serves is still two holders: the refusal is the same one.
      const unknown = await refusal(lobby, { seat: 'lead', session: 'gamma' }, at.home);
      expect(unknown.code).toBe(2);
      expect(unknown.err).toBe(
        `team mcp serve: seat "lead" is on 2 registered teams (${ids.join(', ')}); pass --file to say which\n`,
      );
    } finally {
      at.cleanup();
    }
  });

  test('--file still wins over the registry, even where the roster is ambiguous', async () => {
    const at = world();
    try {
      const acme = at.registered('acme', 'acme', LEAD_CLAUDE);
      const beta = at.registered('beta', 'beta', LEAD_CODEX);
      const lobby = at.lobby();
      await servesTeam({
        from: lobby,
        home: at.home,
        options: { seat: 'lead', session: undefined, file: join(beta.root, '.agents', 'team.yaml') },
        expected: { root: beta.root, session: 'beta', cli: 'codex' },
        others: [marker(acme.root, 'acme')],
      });
    } finally {
      at.cleanup();
    }
  });

  test('a lone holder with another session is refused, naming the session it serves', async () => {
    const at = world();
    try {
      const team = at.registered('acme', 'acme', LEAD_CLAUDE);
      const lobby = at.lobby();
      const refused = await refusal(lobby, { seat: 'lead', session: 'beta' }, at.home);
      expect(refused.code).toBe(2);
      expect(refused.err).toBe('team mcp serve: the team\'s session is "acme", not "beta"\n');
      expect(existsSync(join(team.root, '.agents', 'send-drops'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test("the seat's own folder with no --file serves the registered team", async () => {
    const at = world();
    try {
      const team = at.registered('acme', 'acme', LEAD_CLAUDE);
      await servesTeam({
        from: team.root,
        home: at.home,
        options: { seat: 'lead', session: undefined },
        expected: { root: team.root, session: 'acme', cli: 'claude-code' },
        others: [],
      });
    } finally {
      at.cleanup();
    }
  });

  test('an unreadable registry refuses instead of reading the folder', async () => {
    const at = world();
    try {
      const team = at.registered('acme', 'acme', LEAD_CLAUDE);
      // The folder would serve this team; the registry is the surface that cannot be read.
      writeFileSync(teamsFile(at.home), 'teams: [unclosed\n');
      const refused = await refusal(team.root, { seat: 'lead', session: undefined }, at.home);
      expect(refused.code).toBe(2);
      expect(refused.err.startsWith('team mcp serve: the team registry cannot be read: ')).toBe(true);
      expect(refused.err).toContain(teamsFile(at.home));
      expect(existsSync(join(team.root, '.agents', 'send-drops'))).toBe(false);
    } finally {
      at.cleanup();
    }
  });

  test('a seat no registered roster holds is refused, naming --file', async () => {
    const at = world();
    try {
      at.registered('acme', 'acme', [{ name: 'worker', cli: 'codex' }]);
      const lobby = at.lobby();
      const refused = await refusal(lobby, { seat: 'lead', session: undefined }, at.home);
      expect(refused.code).toBe(2);
      expect(refused.err).toBe('team mcp serve: no registered team holds seat "lead"; pass --file\n');
    } finally {
      at.cleanup();
    }
  });
});
