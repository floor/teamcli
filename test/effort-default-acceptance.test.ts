// Acceptance for rc.3.1's effort default. A seat whose file declares no effort is compared
// against the effort its CLI profile names as the default; a profile that names none cannot
// make a seen word a drift. An effort-only drift is worded as effort and never repeats the
// model; a real model change keeps the model line. The rule is read through `team status` and
// `team check`, which share `src/status/compare.ts`'s modelOf; the screens are the captured
// antigravity 1.3.5 idle pane (its footer reads `Gemini 4 Argon · medium`) and the captured
// cursor 2026.10.01 startup pane (its row reads `Grok 4.7 256K High`). Cursor's launch takes
// no effort flag, so its profile names no default: a seen word with no declared effort is not
// a difference there. Every IO pins its caller; nothing reads the real process ancestry. The
// fixture seat has no rules file, so `team check` also reports that file as missing (its repair
// is `team reload`); the no-difference scenes therefore name the two drift forms — the model
// line and the effort-only line — instead of forbidding every difference line.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { verifiedOf } from '../src/approve/approval.ts';
import type { Caller } from '../src/caller.ts';
import { runTeamCheck } from '../src/check/team.ts';
import { runStatus } from '../src/commands/status.ts';
import type { StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { emptySession, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import type { Standing } from '../src/store/store.ts';
import { testIo } from './helpers.ts';

const AGY_IDLE = readFileSync(new URL('./fixtures/antigravity/1.3.5/idle.txt', import.meta.url), 'utf8');
const CURSOR_STARTUP = readFileSync(new URL('./fixtures/cursor/2026.10.01/startup.txt', import.meta.url), 'utf8');
const NOW = new Date('2026-10-17T06:00:00Z');
const OWNER: Caller = { kind: 'owner' };
const FILE = '.agents/team.yaml';

/** One seat, in the smallest file that validates: the seat is the team's lead, so nothing but
 *  the model comparison is in play. `effort` is written only when the scene declares one. */
function teamFile(seat: { cli: string; vendor: string; model: string; version: string; effort?: string }): string {
  return [
    'format: 1',
    'project: effort-acceptance',
    'session: effort-acceptance',
    'operator: effort-seat',
    '',
    'workspace:',
    '  mode: shared',
    '',
    'seats:',
    '  - role: implementer',
    '    name: effort-seat',
    `    cli: ${seat.cli}`,
    `    vendor: ${seat.vendor}`,
    `    model: ${seat.model}`,
    `    version: "${seat.version}"`,
    ...(seat.effort ? [`    effort: ${seat.effort}`] : []),
    '    leads: true',
    `    launch: ${seat.cli === 'antigravity' ? 'agy' : 'cursor-agent'}`,
    '',
  ].join('\n');
}

function agent(kind: string): HerdrAgent {
  return { name: 'effort-seat', agent: kind, pane: 'w1:p1', workspace: 'w1', status: 'idle', cwd: null };
}

function live(kind: string, screen: string): Live {
  return {
    running: true,
    agents: [agent(kind)],
    workspaces: [{ id: 'w1', label: 'effort-seat' }],
    screens: { 'w1:p1': screen },
  };
}

let base: string;
let root: string;
let home: string;
let file: string;
let standing: Standing;

function writeTeam(seat: Parameters<typeof teamFile>[0]) {
  const text = teamFile(seat);
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the fixture does not validate: ${JSON.stringify(parsed.errors)}`);
  writeFileSync(file, text);
  standing = verifiedOf(parsed.team, text, root, NOW);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-effort-default-')));
  root = join(base, 'effort-acceptance');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  file = join(root, FILE);
  updateState(join(root, '.agents'), (state) => {
    state.sessions['effort-acceptance'] = {
      ...emptySession(),
      watch: { pid: 1, heartbeat: '2026-10-17T05:59:00Z' },
    };
  });
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function sources(read: Live): StatusSources {
  return { live: () => read, branch: () => 'main', standing: () => standing, now: () => NOW };
}

async function status(read: Live) {
  const io = testIo(root, OWNER);
  const code = await runStatus(['--file', file], io, sources(read));
  return { code, out: io.out, err: io.err };
}

function check(read: Live) {
  const io = testIo(root, OWNER);
  const code = runTeamCheck({ file: FILE }, io, {
    live: () => read,
    branch: () => 'main',
    standing: () => standing,
    now: () => NOW,
    home,
  });
  return { code, out: io.out, err: io.err };
}

describe('the effort a profile names as its default', () => {
  test('an agy seat with no file effort, its screen showing medium: no difference', async () => {
    writeTeam({ cli: 'antigravity', vendor: 'google', model: 'Gemini Argon', version: '4' });
    const read = live('antigravity', AGY_IDLE);
    const run = await status(read);
    expect(run.err).toBe('');
    expect(run.out).toContain('no differences');
    expect(run.code).toBe(0);
    const checked = check(read);
    expect(checked.out).not.toContain('difference: effort-seat: running ');
    expect(checked.out).not.toContain('difference: effort-seat: effort ');
  });

  test('the file says high, the screen says medium: the effort-only line, the model never repeated', async () => {
    writeTeam({ cli: 'antigravity', vendor: 'google', model: 'Gemini Argon', version: '4', effort: 'high' });
    const read = live('antigravity', AGY_IDLE);
    const run = await status(read);
    expect(run.err).toBe('');
    expect(run.out).toContain('difference: effort-seat: effort medium, file says high');
    expect(run.out).toContain('1 difference');
    expect(run.code).toBe(1);
    const line = run.out.split('\n').find((one) => one.startsWith('difference: effort-seat: '));
    expect(line).toBe('difference: effort-seat: effort medium, file says high');
    expect(line).not.toContain('Gemini');
    expect(line).not.toContain('running');
    const checked = check(read);
    expect(checked.out).toContain('difference: effort-seat: effort medium, file says high');
  });

  test('a different model keeps the model line', async () => {
    writeTeam({ cli: 'antigravity', vendor: 'google', model: 'Gemini Flash', version: '3.8' });
    const read = live('antigravity', AGY_IDLE);
    const run = await status(read);
    expect(run.err).toBe('');
    expect(run.out).toContain('difference: effort-seat: running Gemini Argon 4 medium, file says Gemini Flash 3.8');
    expect(run.out).not.toContain('effort-seat: effort');
    expect(run.code).toBe(1);
    const checked = check(read);
    expect(checked.out).toContain('difference: effort-seat: running Gemini Argon 4 medium, file says Gemini Flash 3.8');
    expect(checked.out).not.toContain('effort-seat: effort');
  });

  test('a profile with no default effort, a seen word and no file word: no difference', async () => {
    writeTeam({ cli: 'cursor', vendor: 'xai', model: 'Grok', version: '4.7' });
    const read = live('cursor', CURSOR_STARTUP);
    const run = await status(read);
    expect(run.err).toBe('');
    expect(run.out).toContain('no differences');
    expect(run.code).toBe(0);
    const checked = check(read);
    expect(checked.out).not.toContain('difference: effort-seat: running ');
    expect(checked.out).not.toContain('difference: effort-seat: effort ');
  });
});
