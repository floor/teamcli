// What `doctor` says of a seat whose launch names no model the profile knows: silence only when
// the launch runs the CLI's own binary, bare, and the profile's screen can name the declared
// model; every other shape warns or notes with what the owner can do. The fixture holds one seat
// of each shape; the matrix over launch lines is the review's table. The exact-output test is the
// contract `bun run contract` regenerates.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caller } from '../../src/caller.ts';
import { runApprove } from '../../src/approve/command.ts';
import { modelFlagFinding, runDoctor, type DoctorSources, type Finding } from '../../src/commands/doctor.ts';
import { profileFor } from '../../src/profiles/index.ts';
import { statusModelRules, statusModelRulesOf, statusOnLine, type ModelRule, type Profile } from '../../src/profiles/profile.ts';
import { canShowModel, runningModel, type Running } from '../../src/status/statusline.ts';
import { installKey } from '../../src/store/keys.ts';
import { screenData, statusRow } from '../../src/watch/screen.ts';
import { YamlError } from '../../src/yaml.ts';
import { testIo } from '../helpers.ts';

const FIXTURE = readFileSync(join(import.meta.dir, '../fixtures/doctor-models.yaml'), 'utf8');
const FILE = ['--file', '.agents/team.yaml'];
const OWNER: Caller = { kind: 'owner' };
const NOW = new Date('2026-10-03T14:02:00Z');

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-doctor-models-')));
  root = join(base, 'pilot');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
  installKey(home, JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/key.json'), 'utf8')));
  writeFileSync(join(root, '.agents/team.yaml'), FIXTURE);
});

// The whole file is thrown away with the temporary directory it was written in.
afterEach(() => rmSync(base, { recursive: true, force: true }));

const edit = (change: (text: string) => string) =>
  writeFileSync(join(root, '.agents/team.yaml'), change(readFileSync(join(root, '.agents/team.yaml'), 'utf8')));

async function approve() {
  const io = testIo(root, OWNER);
  return runApprove(FILE, io, { ask: async () => '7', waiting: () => 'empty', now: () => NOW, home });
}

// Every CLI at its tested version, claude overridable to one past the range.
const versions = (claude: string) => (binary: string): string | null =>
  binary === 'claude'
    ? claude
    : binary === 'codex'
      ? 'codex-cli 0.157.0'
      : binary === 'agy'
        ? '1.2.16'
        : binary === 'cursor-agent'
          ? '2026.10.01'
          : null;

function sources(overrides: Partial<DoctorSources> = {}): DoctorSources {
  return {
    version: versions('2.1.288 (Claude Code)'),
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
    ...overrides,
  };
}

async function doctor(overrides: Partial<DoctorSources> = {}) {
  const io = testIo(root, OWNER);
  const code = await runDoctor([...FILE], io, sources(overrides));
  return { code, out: io.out, err: io.err };
}

describe('team doctor on a file of every model shape', () => {
  test('the seven seats, exactly', async () => {
    await approve();
    const run = await doctor();
    expect(run.err).toBe('');
    expect(run.out).toBe(
      [
        'team pilot, session "pilot"',
        // The fixture still spells the lead `coordinator:`, on line 4: doctor prints the file's
        // notice before the seats' own warnings, and counts it.
        'warn  the file, line 4: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
        // the message seats' rules files: written by `up`, absent in this fixture
        'warn  plain-codex: its rules file is missing; run team reload plain-codex',
        'warn  plain-voyager: its rules file is missing; run team reload plain-voyager',
        'warn  plain-reviewer: its rules file is missing; run team reload plain-reviewer',
        'ok    herdr 0.7.1',
        'note  session pilot is not running',
        'ok    claude 2.1.288 (Claude Code)',
        'ok    claude-code: logged in',
        'warn  script-seat: the launch runs zsh, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
        'warn  other-model: the launch starts Claude Fable 5.1, the file says Opus 5.5 (dev)',
        'ok    codex codex-cli 0.157.0',
        'ok    codex: logged in',
        'ok    agy 1.2.16',
        'ok    antigravity: logged in',
        'ok    cursor-agent 2026.10.01',
        'ok    cursor: logged in',
        'ok    the lobby ~/.config/team/lobby: will be created at the first launch',
        'note  the file is legacy: migrate to ~/.config/team/lobby by writing:',
        'trust:',
        '  - ~/.config/team/lobby',
        `  - ${root}`,
        `~/.config/team/lobby is the machine lobby, where every seat starts now; ${root} is the project root`,
        'team doctor: nothing missing, 6 warnings',
        'what 0.5.0 must not pretend:',
        '  The checks in 0.5.0 — including the owner check — stop mistakes by agents in herdr panes, not a process running as the same OS user that sets out to get around those checks.',
        '  A right given to a team or a seat stands until it is revoked, and may carry an end date; a seat cannot lend a right to another seat for a task and take it back when the task is done.',
        '  Three ways of sharing control are not built yet — a grant co-signed by a second person, a seat approving an identical copy of another seat, and an agent creating a team within pre-set limits — so only the owner grants rights and adds seats.',
        '  Four things are not checked yet: which project files a seat may see, acting under an account the owner holds — GitHub, Linear, email — using the broker, and deploying a release.',
        '  Apart from one lead seat per team and no seat starting with two exclusive rights, nothing else about how a team is put together is enforced: no limit on how many seats hold a right, no rule that a change is merged by a different seat from the one that wrote it, and no rule that a reviewer comes from another lab.',
        '',
      ].join('\n'),
    );
    expect(run.code).toBe(0);
  });

  test('a launch naming the same model in another word order is no warning', async () => {
    // agy's flag splits the vendor's display order: the launch starts Gemini Argon 4 and the file
    // writes Gemini 4 Argon with the same version. One model, so the doctor says nothing of it.
    edit((text) =>
      text
        .replace('launch: agy', 'launch: agy --model gemini-4-argon')
        .replace('    model: Gemini Flash\n    version: "3.8"', '    model: Gemini 4 Argon\n    version: "4"'),
    );
    await approve();
    const run = await doctor();
    expect(run.out).not.toContain('plain-voyager: the launch starts');
    // A seat launched on another model still warns, spelled as launcher and file spell it.
    expect(run.out).toContain('warn  other-model: the launch starts Claude Fable 5.1, the file says Opus 5.5 (dev)\n');
  });

  test('a declared model_from makes the note say what really happens', async () => {
    edit((text) => text.replace('launch: zsh launcher.sh', 'launch: claude\n    model_from: launcher'));
    await approve();
    const run = await doctor();
    // claude-code's screen names the seat's declared model, so the running seat is checked
    expect(run.out).toContain('note  script-seat: the model is chosen by its launcher; checked on the running seat\n');
    expect(run.out).not.toContain('script-seat: the launch');
    // the three message seats' rules files count with the one model warning, and the file's
    // notice counts too
    expect(run.out).toContain('team doctor: nothing missing, 5 warnings\nwhat 0.5.0 must not pretend:\n');
  });

  test('model_from edited after the record is not a doctor miss', async () => {
    await approve();
    edit((text) => text.replace('launch: zsh launcher.sh', 'launch: zsh launcher.sh\n    model_from: launcher'));
    const run = await doctor();
    expect(run.out).not.toContain('team approve');
    expect(run.out).not.toContain('seat script-seat changed');
  });

  test('an all-correct running team warns only where a version is untested or the owner must act', async () => {
    edit((text) => text.replace('launch: claude --model claude-fable-5-1', 'launch: claude --model claude-opus-5-5'));
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({ format: 1, sessions: { pilot: { seats: {}, worktrees: {}, watch: { pid: 1, heartbeat: NOW.toISOString() } } } }),
    );
    const run = await doctor({ sessionRunning: () => true, version: versions('2.2.0 (Claude Code)') });
    const warns = run.out.split('\n').filter((line) => line.startsWith('warn'));
    expect(warns).toEqual([
      'warn  the file, line 4: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read',
      'warn  plain-codex: its rules file is missing; run team reload plain-codex',
      'warn  plain-voyager: its rules file is missing; run team reload plain-voyager',
      'warn  plain-reviewer: its rules file is missing; run team reload plain-reviewer',
      'warn  claude 2.2.0 (Claude Code) is newer than the tested 2.1.288 to 2.1.302: its screens are untested with this version; a seat that isn\'t read at launch is left out, never typed into',
      'warn  script-seat: the launch runs zsh, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
    ]);
    expect(run.out).toContain('ok    the watch is running\n');
    expect(run.out).toContain('team doctor: nothing missing, 6 warnings\nwhat 0.5.0 must not pretend:\n');
    expect(run.code).toBe(0);
  });
});

// A seat the state records from a launch that predates the process identity: neither `status` nor
// the watch can tell whether its pane still holds what team launched, so the doctor names the
// repair that relaunches it for it. A seat whose identity was recorded, a stopped seat
// (`up` never starts it) and a seat the state doesn't hold at all draw nothing.
describe('the note for a seat launched before team recorded its process', () => {
  test('one note per recorded seat without the identity, and none for the others', async () => {
    await approve();
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          pilot: {
            seats: {
              'plain-codex': { stage: 'ready', pane: 'w2:p1', workspace: 'w2' },
              'other-model': { stage: 'ready', pane: 'w6:p1', workspace: 'w6' },
              lead: { stage: 'ready', pane: 'w5:p1', workspace: 'w5', launched: { shell: 400, cli: [401] } },
              'parked-one': { stage: 'ready' },
            },
          },
        },
      }),
    );
    const run = await doctor();
    expect(run.code).toBe(0);
    const notes = run.out.split('\n').filter((line) => line.includes('launched before team recorded its process'));
    expect(notes).toEqual([
      'note  plain-codex: launched before team recorded its process; run `team register plain-codex` to record its process',
      'note  other-model: launched before team recorded its process; run `team register other-model` to record its process',
    ]);
  });
});

// The review's matrix: every launch-line shape × a model the screen can name or not × model_from
// declared or not. Main printed one warning for every row; this version may fall silent only
// where the launch runs the CLI's own binary, bare, and the screen can name the declared model.
describe('modelFlagFinding', () => {
  const profile = profileFor('claude-code');
  if (!profile) throw new Error('claude-code must have a profile');
  // claude-code's screen names Claude's families; a model another maker spells is unread on it.
  const READABLE: { cli: string; model: string; version: string; display: string } = {
    cli: 'claude-code',
    model: 'Claude Opus',
    version: '5.5',
    display: 'Claude Opus 5.5',
  };
  const FOREIGN: { cli: string; model: string; version: string; display: string } = {
    cli: 'claude-code',
    model: 'DeepSeek Flash',
    version: 'V4.1',
    display: 'DeepSeek Flash V4.1',
  };
  const LINES = [
    'claude',
    'VAR=1 claude',
    'env claude',
    'env -i A=1 claude',
    'command claude',
    'exec claude',
    'nice -n 5 claude',
    '/opt/x/claude',
    './claude',
    'claude-wrapper',
    'zsh -c claude',
    'zsh script.sh',
    'npx claude',
    'bunx @scope/claude',
    'echo claude',
  ];
  // The own binary, bare: assignments in front are the pane's environment; anything else — a
  // path, a wrapper, a shell — is another program, and what it does with the model is not this
  // version's to know.
  const BARE = new Set(['claude', 'VAR=1 claude']);
  const seat = (launch: string, shape: typeof READABLE, modelFrom?: 'launcher') => ({
    name: 'one-seat',
    launch,
    ...(modelFrom ? { modelFrom } : {}),
    ...shape,
  });

  test.each(LINES)('%s: bare, wrapped, declared, unread', (line) => {
    // model_from declared: the owner wrote the key, and the note says the truth for the seat
    expect(modelFlagFinding(seat(line, READABLE, 'launcher'), profile)).toEqual({
      level: 'note',
      text: 'one-seat: the model is chosen by its launcher; checked on the running seat',
    });
    expect(modelFlagFinding(seat(line, FOREIGN, 'launcher'), profile)).toEqual({
      level: 'note',
      text: 'one-seat: the model is chosen by its launcher (declared in the file); this version can\'t read DeepSeek Flash V4.1 on this CLI\'s screen, so nothing checks it',
    });
    if (BARE.has(line)) {
      // the own binary: the screen settles it, or nothing can
      expect(modelFlagFinding(seat(line, READABLE), profile)).toBeNull();
      expect(modelFlagFinding(seat(line, FOREIGN), profile)).toEqual({
        level: 'warn',
        text: 'one-seat: no model flag, and this version can\'t read DeepSeek Flash V4.1 on this CLI\'s screen: nothing checks that it runs it',
      });
      return;
    }
    // anything else runs a launcher the file says nothing about: the warning names the repair
    const first = line.trim().split(/\s+/).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? '';
    const warn: Finding = {
      level: 'warn',
      text: `one-seat: the launch runs ${first}, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher`,
    };
    expect(modelFlagFinding(seat(line, READABLE), profile)).toEqual(warn);
    expect(modelFlagFinding(seat(line, FOREIGN), profile)).toEqual(warn);
  });

  test('no row is silent where main warned unless the running seat is really checked', () => {
    for (const line of LINES) {
      for (const shape of [READABLE, FOREIGN]) {
        for (const declared of [false, true]) {
          const finding = modelFlagFinding(seat(line, shape, declared ? 'launcher' : undefined), profile);
          if (!declared && BARE.has(line) && shape === READABLE) expect(finding).toBeNull();
          else expect(finding).not.toBeNull();
        }
      }
    }
  });

  test('a CLI that starts on its last-used model keeps its warning, bare or not', () => {
    const lastUsed: Pick<Profile, 'binary' | 'lastUsedModel'> = { binary: 'claude', lastUsedModel: true };
    const warn: Finding = {
      level: 'warn',
      text: 'one-seat: the launch names no model this version knows; the file says Claude Opus 5.5',
    };
    expect(modelFlagFinding(seat('claude', READABLE), lastUsed)).toEqual(warn);
    expect(modelFlagFinding(seat('VAR=1 claude', READABLE), lastUsed)).toEqual(warn);
    expect(modelFlagFinding(seat('zsh run.sh', READABLE), lastUsed)).toEqual({
      level: 'warn',
      text: 'one-seat: the launch runs zsh, not claude, and names no model: if the launcher chooses the model, say so with model_from: launcher',
    });
    // the owner's declaration still wins over the CLI's memory
    expect(modelFlagFinding(seat('claude', READABLE, 'launcher'), lastUsed)).toEqual({
      level: 'note',
      text: 'one-seat: the model is chosen by its launcher; checked on the running seat',
    });
  });

  // What the screen can name is settled by the real reader: a line the rule's pattern accepts,
  // with the declared model's own words in the capture its templates name, must read back as
  // exactly this model — and this version when the seat has one. A yes here is a reading the
  // reader really gives, never a claim about what a template might spell.
  test('what the screen can name is what the reader reads back, and nothing else', () => {
    // The shipped rule reads Opus, Sonnet, Haiku and Fable; Terra is a name it cannot spell, so
    // the reader never returns it and no line the pattern accepts reads it back.
    expect(runningModel('claude-code', 'Opus 5.5')).toEqual({ model: 'Claude Opus', version: '5.5' });
    expect(runningModel('claude-code', 'Terra 5.5')).toBeNull();
    expect(canShowModel({ cli: 'claude-code', model: 'Claude Terra' })).toBe(false);
    // the seat's own name; without a version the reader is asked about the model alone
    expect(canShowModel({ cli: 'claude-code', model: 'Claude Opus' })).toBe(true);
    expect(canShowModel({ cli: 'codex', model: 'GPT Sol' })).toBe(true);
    expect(canShowModel({ cli: 'cursor', model: 'Grok' })).toBe(true);
    expect(canShowModel({ cli: 'antigravity', model: 'Gemini Flash' })).toBe(true);
    // cursor's rules spell its new families too; their rows are read in place, so the witness
    // is tried inside the frame the place pins, and the fixtures show the reading is real
    expect(canShowModel({ cli: 'cursor', model: 'Composer', version: '2.5' })).toBe(true);
    expect(canShowModel({ cli: 'cursor', model: 'GPT Sol', version: '5.6' })).toBe(true);
    expect(canShowModel({ cli: 'cursor', model: 'Gemini Flash', version: '3.8' })).toBe(true);
    // another maker's name, and a name no family matches: not readable on this screen
    expect(canShowModel({ cli: 'claude-code', model: 'DeepSeek Flash' })).toBe(false);
    expect(canShowModel({ cli: 'claude-code', model: 'GLM' })).toBe(false);
    // a made-up name is not readable on any other profile either
    expect(canShowModel({ cli: 'codex', model: 'GPT Nova', version: '6' })).toBe(false);
    expect(canShowModel({ cli: 'antigravity', model: 'Gemini Ultra', version: '3.8' })).toBe(false);
    expect(canShowModel({ cli: 'cursor', model: 'Muse Spark', version: '1.3' })).toBe(false);
    // a version the capture cannot spell is no more readable than the model
    expect(canShowModel({ cli: 'claude-code', model: 'Claude Opus', version: 'dev' })).toBe(false);
    // codex's unreadable-line rule names a group its pattern does not have: it yields nothing
    expect(canShowModel({ cli: 'codex', model: 'Grok' })).toBe(false);
  });

  // The evidence behind the table: every model any shipped launch fixture shows is one the
  // profile must call readable — read from the screens themselves, not listed by hand.
  test('every model the shipped fixtures show is readable', () => {
    const dirs: [string, string][] = [
      ['claude-code', 'claude-code/2.1.289'],
      ['codex', 'codex/0.157.0'],
      ['cursor', 'cursor/2026.10.01'],
      ['antigravity', 'antigravity/1.2.16'],
      ['gemini', 'gemini/0.64.0'],
      ['grok', 'grok/1.0.50'],
      ['muse', 'muse/1.4.9'],
    ];
    for (const [cli, dir] of dirs) {
      const shown = readdirSync(join(import.meta.dir, '../fixtures', dir))
        .filter((file) => file.endsWith('.txt'))
        .map((file) => runningModel(cli, readFileSync(join(import.meta.dir, '../fixtures', dir, file), 'utf8')))
        .filter((running): running is Running => running !== null);
      // The profile's fixtures show its model at least once: an empty sweep is not a pass.
      expect(shown.length).toBeGreaterThan(0);
      for (const running of shown) expect(canShowModel({ cli, model: running.model, version: running.version })).toBe(true);
    }
  });
});

// The declaration's promises, kept on real screens. `yields` says exactly which names the rule
// reads; the reader itself is the judge: the declared name's own words put into the row the reader
// reads, on a captured fixture's own text, must read back as exactly that name — a name no capture
// carries fails naming the rule instead of passing unproven. `version_like` says the version
// shapes the rule can spell: a shape a carried row admits and the declaration accepts must read
// back as that version, and the shapes the captures themselves show must all be accepted.
describe('the declared models and versions, on the captured screens', () => {
  // A profile's carriers may span several tested folders: a later version can bring a model row
  // only its own capture shows (Cursor's Gemini Argon row, captured at 2026.10.19 only).
  const DIRS: [string, string | string[]][] = [
    ['claude-code', 'claude-code/2.1.289'],
    ['codex', 'codex/0.157.0'],
    ['cursor', ['cursor/2026.10.01', 'cursor/2026.10.19']],
    ['antigravity', 'antigravity/1.2.16'],
    ['gemini', 'gemini/0.64.0'],
    ['grok', 'grok/1.0.50'],
    ['muse', 'muse/1.4.9'],
  ];
  const VERSIONS = ['9.8.7', '9.8', '9'];

  type Carried = { file: string; screen: string; row: string; index: number; hit: Running };

  // The row the reader reads, its line in the capture, and what it reads. A placed profile goes
  // through its own row; the rest walk the last six lines as `runningModel` does, last hit
  // winning and a line the rules claim but cannot name clearing the earlier one. Null when the
  // screen names no model at all.
  function readRow(cli: string, screen: string): { row: string; index: number; hit: Running } | null {
    const lines = screen.split('\n');
    const data = screenData(cli);
    const composer = data?.composer;
    const placed = composer && (composer.mode === 'status-last' || composer.mode === 'status-then-one') && composer.statusBelow;
    let index = -1;
    if (placed) {
      const row = statusRow(data, screen);
      if (row !== null) index = lines.lastIndexOf(row);
    } else {
      for (let i = Math.max(0, lines.length - 6); i < lines.length; i++) {
        const hit = statusOnLine(cli, lines[i] as string);
        if (hit === 'unreadable') index = -1;
        else if (hit) index = i;
      }
    }
    if (index < 0) return null;
    const row = lines[index] as string;
    const hit = statusOnLine(cli, row);
    if (hit === null || hit === 'unreadable') return null;
    return { row, index, hit };
  }

  // The first rule that claims the row, the one `statusOnLine` reads it through. -1 when none does.
  function ruleOf(cli: string, row: string): number {
    return statusModelRules(cli).findIndex((rule) => rule.match.test(row));
  }

  // A captured fixture whose screen names a model through this rule: the first in name order,
  // carrying the reading the whole screen carries. Plain captures only — the row is rebuilt in
  // the capture's own text, so nothing may have to be stripped to find it.
  function carrierFor(cli: string, dirs: string | string[], wanted: number): Carried | null {
    for (const dir of typeof dirs === 'string' ? [dirs] : dirs) {
      const found = carrierIn(cli, dir, wanted);
      if (found !== null) return found;
    }
    return null;
  }

  function carrierIn(cli: string, dir: string, wanted: number): Carried | null {
    const root = join(import.meta.dir, '../fixtures', dir);
    for (const file of readdirSync(root).filter((name) => name.endsWith('.txt')).sort()) {
      const screen = readFileSync(join(root, file), 'utf8');
      if (screen.includes('\u001b')) continue;
      const read = readRow(cli, screen);
      if (read === null || ruleOf(cli, read.row) !== wanted) continue;
      const overall = runningModel(cli, screen);
      if (overall === null || overall.model !== read.hit.model || overall.version !== read.hit.version) continue;
      return { file, screen, ...read };
    }
    return null;
  }

  // The words a template pins to one capture, read from the declared text: the text around the
  // `{n}` must fit the template's literal parts, and what remains is the capture's. None when the
  // template has no hole — the row already reads the template's own literal, and the assertion on
  // the reading is what keeps that literal the declared name. `{n:title}` folds the words, so the
  // remainder must be exactly what it reads back.
  function pin(template: string, text: string, what: string): { group: number; words: string } | null {
    const holes = [...template.matchAll(/\{(\d+)(?::title)?\}/g)];
    if (holes.length === 0) return null;
    if (holes.length > 1) throw new Error(`${what}: template "${template}" pins more than one capture`);
    const hole = holes[0] as RegExpMatchArray;
    const at = hole.index ?? 0;
    const head = template.slice(0, at);
    const tail = template.slice(at + hole[0].length);
    if (!text.startsWith(head) || !text.endsWith(tail) || text.length < head.length + tail.length) {
      throw new Error(`${what}: "${text}" does not fit template "${template}"`);
    }
    const words = text.slice(head.length, text.length - tail.length);
    if (words === '') throw new Error(`${what}: "${text}" leaves the capture empty`);
    if (hole[0].includes(':title')) {
      const titled = `${words.slice(0, 1).toUpperCase()}${words.slice(1).toLowerCase()}`;
      if (titled !== words) throw new Error(`${what}: "${words}" does not read back through ":title"`);
    }
    return { group: Number(hole[1]), words };
  }

  // The row with the declared text's words in the capture its template names, and nothing else
  // changed. Null when the rebuilt row is not one the rule claims — a shape the rule's own
  // pattern refuses; the caller reads that as "the row cannot carry this text", never as a pass.
  function substitute(row: string, rule: ModelRule, template: string, text: string, what: string): string | null {
    const pinned = pin(template, text, what);
    if (pinned === null) return row;
    const match = new RegExp(rule.match.source, 'ud').exec(row);
    const span = match?.indices?.[pinned.group];
    if (!span) throw new Error(`${what}: the pattern has no capture the template names`);
    const rebuilt = row.slice(0, span[0]) + pinned.words + row.slice(span[1]);
    return rule.match.test(rebuilt) ? rebuilt : null;
  }

  function replaceLine(screen: string, index: number, row: string): string {
    const lines = screen.split('\n');
    lines[index] = row;
    return lines.join('\n');
  }

  test('every declared name really reads on a captured screen, or the rule is named', () => {
    for (const [cli, dir] of DIRS) {
      const rules = statusModelRules(cli);
      for (let at = 0; at < rules.length; at++) {
        const rule = rules[at] as ModelRule;
        if (rule.yields.length === 0) continue;
        const carrier = carrierFor(cli, dir, at);
        if (carrier === null) throw new Error(`no capture carries rule ${at} of ${cli}: ${rule.match.source}`);
        for (const name of rule.yields) {
          const what = `${cli} rule ${at} (${rule.match.source}), name "${name}", ${carrier.file}`;
          const row = substitute(carrier.row, rule, rule.model, name, what);
          if (row === null) throw new Error(`${what}: the row refuses the declared name`);
          const read = runningModel(cli, replaceLine(carrier.screen, carrier.index, row));
          if (read === null || read.model !== name || read.version !== carrier.hit.version) {
            throw new Error(`${what}: read ${JSON.stringify(read)}`);
          }
        }
      }
    }
  });

  test('every version shape the row can carry and the declaration accepts reads back as that version', () => {
    for (const [cli, dir] of DIRS) {
      const rules = statusModelRules(cli);
      for (let at = 0; at < rules.length; at++) {
        const rule = rules[at] as ModelRule;
        if (rule.versionLike === null) continue;
        const carrier = carrierFor(cli, dir, at);
        if (carrier === null) throw new Error(`no capture carries rule ${at} of ${cli}: ${rule.match.source}`);
        // The shape the capture itself shows is one the rule must accept, or a real reading would
        // be refused.
        if (!rule.versionLike.test(carrier.hit.version)) {
          throw new Error(`${cli} rule ${at} (${rule.match.source}) refuses the shown version ${carrier.hit.version}`);
        }
        for (const version of VERSIONS) {
          const what = `${cli} rule ${at} (${rule.match.source}), version "${version}", ${carrier.file}`;
          const row = substitute(carrier.row, rule, rule.version, version, what);
          if (row === null || !rule.versionLike.test(version)) continue;
          const read = runningModel(cli, replaceLine(carrier.screen, carrier.index, row));
          if (read === null || read.model !== carrier.hit.model || read.version !== version) {
            throw new Error(`${what}: read ${JSON.stringify(read)}`);
          }
        }
      }
    }
  });

  test('version_like is refused as the rule loads unless anchored at both ends', () => {
    const rule = (versionLike: string) => `
- match: '^M-([0-9]+)$'
  model: 'M {1}'
  version: '{1}'
  yields: [M]
  version_like: '${versionLike}'
`;
    for (const loose of ['[0-9]+', '^[0-9]+', '[0-9]+$']) {
      expect(() => statusModelRulesOf(rule(loose))).toThrow(YamlError);
      expect(() => statusModelRulesOf(rule(loose))).toThrow(/anchored at both ends/);
    }
  });

  test('the version check is the rule\'s own: a shape the rule cannot spell is not readable', () => {
    // One shipped rule spells a single optional dot, another any number of them; the same model
    // name is readable with one version shape and not the other, and a shape with a stray space
    // is refused however many digits it has.
    expect(canShowModel({ cli: 'codex', model: 'GPT Terra' })).toBe(true);
    expect(canShowModel({ cli: 'codex', model: 'GPT Terra', version: '5.6' })).toBe(true);
    expect(canShowModel({ cli: 'codex', model: 'GPT Terra', version: '5.6.1' })).toBe(false);
    expect(canShowModel({ cli: 'claude-code', model: 'Claude Opus', version: '5.5.1' })).toBe(true);
    expect(canShowModel({ cli: 'claude-code', model: 'Claude Opus', version: '5.5 ' })).toBe(false);
  });

  // A declared name is a name, not a family of spellings: `canShowModel` compares the seat's
  // model with `yields` exactly, so case, an edge space or a doubled space is a different string —
  // one no rule lists, and a seat running it is not one its screen can name. A truthy here would
  // silence `doctor`'s warning for a seat whose screen cannot show what the file declares.
  test('a declared name is exact: case and spaces are not the name', () => {
    const CASES: [string, string, string[]][] = [
      ['claude-code', 'Claude Opus', ['claude opus', 'CLAUDE OPUS', 'Claude Opus ', ' Claude Opus', 'Claude  Opus']],
      ['codex', 'GPT Sol', ['gpt sol', 'GPT SOL', 'GPT Sol ', ' GPT Sol', 'GPT  Sol']],
      // cursor spells single words: its doubled-space case is its other multi-word name
      ['cursor', 'Grok', ['grok', 'GROK', 'Grok ', ' Grok', 'GPT  Sol']],
      ['antigravity', 'Gemini Flash', ['gemini flash', 'GEMINI FLASH', 'Gemini Flash ', ' Gemini Flash', 'Gemini  Flash']],
      ['gemini', 'Gemini Pro', ['gemini pro', 'GEMINI PRO', 'Gemini Pro ', ' Gemini Pro', 'Gemini  Pro']],
      ['muse', 'Muse Wonder', ['muse wonder', 'MUSE WONDER', 'Muse Wonder ', ' Muse Wonder', 'Muse  Wonder']],
      ['grok', 'Grok', ['grok', 'GROK', 'Grok ', ' Grok', 'Grok  Fast']],
    ];
    for (const [cli, declared, variants] of CASES) {
      expect(canShowModel({ cli, model: declared })).toBe(true);
      for (const variant of variants) {
        expect(canShowModel({ cli, model: variant })).toBe(false);
        expect(canShowModel({ cli, model: variant, version: '5.5' })).toBe(false);
      }
    }
  });

  test('a duplicate name in yields is refused as the rule loads', () => {
    const rule = (yields: string) => `
- match: '^M-([0-9]+)$'
  model: 'M {1}'
  version: '{1}'
  yields: ${yields}
`;
    expect(() => statusModelRulesOf(rule('[M, M]'))).toThrow(YamlError);
    expect(() => statusModelRulesOf(rule('[M, M]'))).toThrow(/"yields" lists "M" twice/);
    // a trailing space makes the string a different name, not a duplicate
    expect(statusModelRulesOf(rule('[M, "M "]')).flatMap((one) => one.yields)).toEqual(['M', 'M ']);
  });

  test('a constructed rule carries its version shapes, and one without the keys yields nothing', () => {
    const declared = statusModelRulesOf(`
- match: '^M-([0-9]+(?:\\.[0-9]+)*)$'
  model: 'M {1}'
  version: '{1}'
  yields: [M]
  version_like: '^[0-9]+(?:\\.[0-9]+)*$'
`);
    const rule = declared[0] as ModelRule;
    expect(rule.versionLike?.test('5')).toBe(true);
    expect(rule.versionLike?.test('5.5.1')).toBe(true);
    expect(rule.versionLike?.test('5x')).toBe(false);
    expect(rule.versionLike?.test('dev')).toBe(false);
    expect(rule.versionLike?.test('x5')).toBe(false);
    const bare = statusModelRulesOf(`
- match: '^M-([0-9]+)$'
  model: 'M {1}'
  version: '{1}'
`);
    expect((bare[0] as ModelRule).yields).toEqual([]);
    expect((bare[0] as ModelRule).versionLike).toBeNull();
  });
});
