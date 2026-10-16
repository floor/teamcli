// `team brief`: the snapshot, the record, the delivery through `team send`, `--done` and
// `--list`. The seats are the fixture team's (a native codex seat takes the drop path); no pane
// is read and no live session is touched.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBrief } from '../src/commands/brief.ts';
import { BRIEF_MAX, briefDir, readCurrent } from '../src/brief/store.ts';
import { LOG_FILE, updateState } from '../src/state.ts';
import { testIo } from './helpers.ts';
import { dropDir, nativeHost, owner, world, type World } from './send-native-fixtures.ts';

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
});

function use(made: World): World {
  cleanup = made.cleanup;
  return made;
}

const BRIEF = '# Brief\n\nBuild the thing.\nThen say done.\n';

function brief(made: World, name = 'brief.md', text = BRIEF): string {
  const path = join(made.root, name);
  writeFileSync(path, text);
  return path;
}

function recorded(made: World): void {
  updateState(made.dir, (state) => {
    state.sessions.acme = {
      seats: {
        native: { stage: 'launched', pane: 'w9:p1', workspace: 'w9' },
        lead: { stage: 'launched', pane: 'w1:p1', workspace: 'w1' },
        helper: { stage: 'launched', pane: 'w2:p1', workspace: 'w2' },
      },
      worktrees: {},
    };
  });
}

const seatIo = (made: World, name: string, pane: string) => testIo(made.root, { kind: 'seat', name, pane, session: 'acme' });
const logOf = (made: World) => readFileSync(join(made.dir, LOG_FILE), 'utf8');

describe('team brief <seat> <file>', () => {
  test('the owner hands a brief: a 0600 snapshot, a delivered record, the text in the drop file', async () => {
    const made = use(world());
    const source = brief(made);
    const { host, pane } = nativeHost(made, ['idle', 'working']);
    const io = owner(made.root);
    expect(await runBrief(['native', source], io, host), io.err).toBe(0);
    expect(io.out).toMatch(/^native: briefed \([0-9a-f]{8}, [0-9a-f]{12}\)\n$/);

    const record = readCurrent(made.dir, 'acme', 'native');
    expect(record?.status).toBe('delivered');
    expect(record?.source).toBe('brief.md');
    expect(record?.assigned_by).toBe('owner');
    expect(record?.delivered_at).toBeDefined();
    const snapshot = join(briefDir(made.dir, 'acme', 'native'), `${record?.id}.md`);
    expect(readFileSync(snapshot, 'utf8')).toBe(BRIEF);
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(statSync(briefDir(made.dir, 'acme', 'native')).mode & 0o777).toBe(0o700);

    // The delivery is send's: the body whole in one drop file, and one trigger typed.
    const drops = readdirSync(dropDir(made.dir));
    expect(drops).toHaveLength(1);
    expect(readFileSync(join(dropDir(made.dir), drops[0] as string), 'utf8')).toBe(BRIEF);
    expect(pane.typed).toHaveLength(1);
    expect(logOf(made)).toContain(`brief [owner] native: delivered ${record?.id}`);
  });

  test('editing the file afterwards leaves the snapshot as it was handed', async () => {
    const made = use(world());
    const source = brief(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    await runBrief(['native', source], owner(made.root), host);
    writeFileSync(source, 'changed\n');
    const record = readCurrent(made.dir, 'acme', 'native');
    expect(readFileSync(join(briefDir(made.dir, 'acme', 'native'), `${record?.id}.md`), 'utf8')).toBe(BRIEF);
  });

  test('a seat with an unsent draft holds the brief: recorded as held, exit 1, nothing typed', async () => {
    const made = use(world());
    const source = brief(made);
    const { host, pane } = nativeHost(made, ['idle', 'working']);
    host.agents = () => [{ name: 'helper', pane: 'w2:p1' }];
    host.native.paneText = () => `${'─'.repeat(40)}\n❯ a draft the user is typing\n${'─'.repeat(40)}`;
    const io = owner(made.root);
    expect(await runBrief(['helper', source], io, host)).toBe(1);
    expect(io.err).toContain('team brief: helper: held:');
    expect(io.err).toContain('the same command sends it again');
    expect(readCurrent(made.dir, 'acme', 'helper')?.status).toBe('held');
    expect(pane.typed).toHaveLength(0);
  });

  test('a seat that is not running is recorded unreachable', async () => {
    const made = use(world());
    const source = brief(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    host.agents = () => [];
    const io = owner(made.root);
    expect(await runBrief(['native', source], io, host)).toBe(1);
    expect(io.err).toContain('team brief: native: unreachable:');
    expect(readCurrent(made.dir, 'acme', 'native')?.status).toBe('unreachable');
  });

  test('a worker seat may not hand a brief, and nothing is written', async () => {
    const made = use(world());
    recorded(made);
    const source = brief(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = seatIo(made, 'helper', 'w2:p1');
    expect(await runBrief(['native', source], io, host)).toBe(1);
    expect(io.err).toContain('team brief: refused: a seat may not send');
    expect(existsSync(join(made.dir, 'briefs'))).toBe(false);
  });

  test('the orchestrator from its own seat may hand a brief', async () => {
    const made = use(world());
    recorded(made);
    const source = brief(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = seatIo(made, 'lead', 'w1:p1');
    expect(await runBrief(['native', source], io, host), io.err).toBe(0);
    expect(readCurrent(made.dir, 'acme', 'native')?.assigned_by).toBe('orchestrator');
  });

  test('a seat the file does not declare is refused', async () => {
    const made = use(world());
    const source = brief(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = owner(made.root);
    expect(await runBrief(['ghost', source], io, host)).toBe(1);
    expect(io.err).toContain('ghost: it is not a declared seat');
    expect(existsSync(join(made.dir, 'briefs'))).toBe(false);
  });

  test('a brief file that is a link, empty, missing, binary or too large is refused before any write', async () => {
    const made = use(world());
    const { host } = nativeHost(made, ['idle', 'working']);
    const real = brief(made);
    const link = join(made.root, 'link.md');
    symlinkSync(real, link);
    const empty = brief(made, 'empty.md', '  \n');
    const binary = join(made.root, 'binary.md');
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    const large = brief(made, 'large.md', 'x'.repeat(BRIEF_MAX + 1));
    mkdirSync(join(made.root, 'folder.md'));
    const cases: [string, string][] = [
      [link, 'it is a link'],
      [empty, 'it is empty'],
      [join(made.root, 'missing.md'), 'it cannot be read'],
      [binary, 'it is not UTF-8 text'],
      [large, `it is over ${String(BRIEF_MAX)} bytes`],
      [join(made.root, 'folder.md'), 'it is not a regular file'],
    ];
    for (const [path, why] of cases) {
      const io = owner(made.root);
      expect(await runBrief(['native', path], io, host), path).toBe(1);
      expect(io.err, path).toContain(why);
    }
    expect(existsSync(join(made.dir, 'briefs'))).toBe(false);
  });

  test('--dry-run says what it would do and writes nothing', async () => {
    const made = use(world());
    const source = brief(made);
    const { host, pane } = nativeHost(made, ['idle', 'working']);
    const io = owner(made.root);
    expect(await runBrief(['native', source, '--dry-run'], io, host)).toBe(0);
    expect(io.out).toContain('native: would hand brief.md');
    expect(existsSync(join(made.dir, 'briefs'))).toBe(false);
    expect(existsSync(dropDir(made.dir))).toBe(false);
    expect(pane.typed).toHaveLength(0);
  });

  test('--json prints one document', async () => {
    const made = use(world());
    const source = brief(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = owner(made.root);
    expect(await runBrief(['native', source, '--json'], io, host)).toBe(0);
    const doc = JSON.parse(io.out) as { seat: string; status: string; exit: number; id: string; sha256: string };
    expect(doc).toMatchObject({ seat: 'native', status: 'delivered', exit: 0 });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readCurrent(made.dir, 'acme', 'native')?.id).toBe(doc.id);
  });

  test('a usage error exits 2', async () => {
    const made = use(world());
    const { host } = nativeHost(made, ['idle', 'working']);
    for (const argv of [[], ['native'], ['--done', '--list'], ['--seat', 'native', 'x'], ['--list', '--dry-run'], ['--done', 'loose words']]) {
      const io = owner(made.root);
      expect(await runBrief(argv, io, host), argv.join(' ')).toBe(2);
      expect(io.err).toContain('Usage: team brief');
    }
  });
});

describe('team brief --done', () => {
  async function handed(made: World): Promise<ReturnType<typeof nativeHost>> {
    const fixture = nativeHost(made, ['idle', 'working']);
    expect(await runBrief(['native', brief(made)], owner(made.root), fixture.host)).toBe(0);
    return fixture;
  }

  test('a seat marks its own brief done with a one-line summary', async () => {
    const made = use(world());
    recorded(made);
    const { host } = await handed(made);
    const io = seatIo(made, 'native', 'w9:p1');
    expect(await runBrief(['--done', '--summary', 'built it\nsecond line \u001b[31mred'], io, host), io.err).toBe(0);
    expect(io.out).toBe('native: marked done\n');
    const record = readCurrent(made.dir, 'acme', 'native');
    expect(record?.status).toBe('done');
    expect(record?.done_by).toBe('seat');
    expect(record?.done_at).toBeDefined();
    expect(record?.summary).not.toContain('\u001b');
    expect(record?.summary).not.toContain('\n');
    expect(logOf(made)).toContain('brief [seat] native: done');
  });

  test('a brief already done, or never handed, has no active brief', async () => {
    const made = use(world());
    recorded(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    const none = seatIo(made, 'native', 'w9:p1');
    expect(await runBrief(['--done'], none, host)).toBe(1);
    expect(none.err).toContain('no active brief is recorded for native');

    await handed(made);
    expect(await runBrief(['--done'], seatIo(made, 'native', 'w9:p1'), host)).toBe(0);
    const again = seatIo(made, 'native', 'w9:p1');
    expect(await runBrief(['--done'], again, host)).toBe(1);
    expect(again.err).toContain('no active brief is recorded for native');
  });

  test("a seat may not mark another seat's brief, nor from a pane the state does not record", async () => {
    const made = use(world());
    recorded(made);
    const { host } = await handed(made);
    const other = seatIo(made, 'helper', 'w2:p1');
    expect(await runBrief(['--done', '--seat', 'native'], other, host)).toBe(1);
    expect(other.err).toContain("may not mark native's brief done");
    const wrongPane = seatIo(made, 'native', 'w7:p7');
    expect(await runBrief(['--done'], wrongPane, host)).toBe(1);
    expect(readCurrent(made.dir, 'acme', 'native')?.status).toBe('delivered');
  });

  test('the owner and the orchestrator may name the seat', async () => {
    const made = use(world());
    recorded(made);
    const { host } = await handed(made);
    expect(await runBrief(['--done', '--seat', 'native', '--summary', 'closed by owner'], owner(made.root), host)).toBe(0);
    expect(readCurrent(made.dir, 'acme', 'native')?.summary).toBe('closed by owner');
    await runBrief(['native', brief(made, 'second.md')], owner(made.root), nativeHost(made, ['idle', 'working']).host);
    expect(await runBrief(['--done', '--seat', 'native'], seatIo(made, 'lead', 'w1:p1'), host)).toBe(0);
    expect(readCurrent(made.dir, 'acme', 'native')?.done_by).toBe('orchestrator');
  });

  test('without --seat, a caller that is not a seat is told to name one', async () => {
    const made = use(world());
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = owner(made.root);
    expect(await runBrief(['--done'], io, host)).toBe(2);
    expect(io.err).toContain('a seat is required');
  });
});

describe('team brief --list', () => {
  test('one row per seat: none until handed, then the status, file and summary', async () => {
    const made = use(world());
    recorded(made);
    const { host } = nativeHost(made, ['idle', 'working']);
    const before = owner(made.root);
    expect(await runBrief(['--list'], before, host)).toBe(0);
    expect(before.out.trim().split('\n')).toHaveLength(3);
    expect(before.out).toMatch(/native\s+none\s+-\s+-/);

    await runBrief(['native', brief(made)], owner(made.root), host);
    await runBrief(['--done', '--summary', 'all green'], seatIo(made, 'native', 'w9:p1'), host);
    const after = owner(made.root);
    expect(await runBrief(['--list'], after, host)).toBe(0);
    expect(after.out).toMatch(/native\s+done\s+brief\.md\s+0s\s+all green/);
  });

  test('--json is an array, and listing writes nothing and needs no terminal', async () => {
    const made = use(world());
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = testIo(made.root, { kind: 'owner-no-tty' });
    expect(await runBrief(['--list', '--json'], io, host)).toBe(0);
    const rows = JSON.parse(io.out) as { seat: string; status: string }[];
    expect(rows.map((row) => row.seat)).toEqual(['lead', 'helper', 'native']);
    expect(rows.every((row) => row.status === 'none')).toBe(true);
    expect(existsSync(join(made.dir, 'briefs'))).toBe(false);
  });
});

describe('team brief with no terminal', () => {
  test('a run with no terminal is refused before the file is read', async () => {
    const made = use(world());
    const { host } = nativeHost(made, ['idle', 'working']);
    const io = testIo(made.root, { kind: 'owner-no-tty' });
    expect(await runBrief(['native', brief(made)], io, host)).toBe(1);
    expect(io.err).toContain('team brief: only the owner runs this');
    expect(existsSync(join(made.dir, 'briefs'))).toBe(false);
  });
});
