import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReadings, saveSpendReadings, type Seen } from '../src/budgets/readings.ts';
import { verifiedOf } from '../src/approve/approval.ts';
import { runStatus } from '../src/commands/status.ts';
import type { StatusSources } from '../src/commands/status.ts';
import { validateTeamFile } from '../src/file/validate.ts';
import type { Seat, TeamFile } from '../src/file/types.ts';
import { rulesOf } from '../src/launch/rules.ts';
import { rulesFileHash, rulesFilePathOf, writeRulesFile } from '../src/launch/rules-file.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import type { Standing } from '../src/store/store.ts';
import { emptySession, readState, updateState } from '../src/state.ts';
import type { Live } from '../src/status/compare.ts';
import { runningModel } from '../src/status/statusline.ts';
import { testIo, withWas } from './helpers.ts';

const example = readFileSync(new URL('./fixtures/example.yaml', import.meta.url), 'utf8');
const NOW = new Date('2026-10-03T14:10:00Z');

/** The notice the example fixture carries: it still spells the lead `coordinator:`, on line 5. */
const WARNING = 'team status: warning, line 5: `coordinator:` is now `leads: true` on the lead\'s seat, and is still read\n';

const claudeScreen = (model: string) => `❯ \n${'─'.repeat(40)}\n  main · …/acme · ${model} · S: $1.2 · W: 12%\n  ⏵⏵ bypass permissions on\n`;
const codexScreen = (name: string) => readFileSync(new URL(`./fixtures/codex/0.157.0/${name}.txt`, import.meta.url), 'utf8');

function agent(name: string | null, workspace: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane: `${workspace}:p1`, workspace, status, cwd: null };
}

// The example's team as herdr would show it, fully built: grok-acme is stopped in the file.
function built(): Live {
  return {
    running: true,
    agents: [
      agent('claude-coordinator-acme', 'w1', 'working'),
      agent('codex-acme', 'w2', 'idle', 'codex'),
      agent('deepseek-acme', 'w3', 'done'),
      agent('deepseek-acme-2', 'w4'),
    ],
    workspaces: [
      { id: 'w1', label: 'claude opus 5.5' }, { id: 'w2', label: 'gpt sol 6' },
      { id: 'w3', label: 'deepseek flash v4.1' }, { id: 'w4', label: 'deepseek flash v4.1-2' }, { id: 'w9', label: 'watchdog' },
    ],
    screens: { 'w1:p1': claudeScreen('Opus 5.5') },
  };
}

let dir: string;
let file: string;
let live: Live | null;
let branch: string | null;

// The standing the report runs on: by default the file as approved, with no drift.
let standing: Standing;
const sources: StatusSources = {
  live: () => live,
  branch: () => branch,
  standing: () => standing,
  now: () => NOW,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'team-status-'));
  mkdirSync(join(dir, '.agents'));
  file = join(dir, '.agents', 'team.yaml');
  writeFileSync(file, example);
  live = built();
  branch = 'main';
  const checked = validateTeamFile(example);
  if (!checked.ok) throw new Error('the example fixture does not validate');
  standing = verifiedOf(checked.team, example, dir, NOW);
  updateState(join(dir, '.agents'), (state) => {
    state.sessions['acme-web'] = { ...emptySession(), watch: { pid: 1, heartbeat: '2026-10-03T14:09:00Z' } };
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function status(...argv: string[]) {
  // Every run here aims `--file` at the fixture, and that flag is the owner's: the io carries the
  // owner, as a terminal run of the command would.
  const io = testIo(dir, { kind: 'owner' });
  const code = await runStatus(['--file', file, ...argv], io, sources);
  return { code, out: io.out, err: io.err };
}

// Approve whatever the file on disk now holds: the tests below rewrite the file and mean the
// change to be in force, not a drift against the record beforeEach built.
function approveOnDisk() {
  const text = readFileSync(file, 'utf8');
  const parsed = validateTeamFile(text);
  if (!parsed.ok) throw new Error(`the rewritten file does not validate: ${JSON.stringify(parsed.errors)}`);
  standing = verifiedOf(parsed.team, text, dir, NOW);
}

describe('team status', () => {
  test('a team that matches its file reads clean and exits 0', async () => {
    const { code, out } = await status();
    expect(out).toContain('team acme-web, session "acme-web"');
    expect(out).toMatch(/claude-coordinator-acme\s+working\s+Claude Opus 5\.5\s+w1:p1/);
    expect(out).toMatch(/codex-acme\s+idle \(screen not recognised\), parked/);
    expect(out).toMatch(/grok-acme\s+stopped/);
    // The suffix is a reading, not a difference: a team that matches its file still reads clean.
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('a seat whose model can\'t be read is a note, not a difference', async () => {
    const { code, out } = await status();
    expect(out).toContain('note: codex-acme: version unread');
    expect(code).toBe(0);
  });

  test('a missing seat, with its repair', async () => {
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const { code, out } = await status();
    expect(out).toContain('difference: deepseek-acme-2 is in the file and is not running\n  repair: team add deepseek-acme-2');
    expect(out).toContain('1 difference(s)');
    expect(code).toBe(1);
  });

  test('a session that is not running: every seat is missing, and the repair is team up', async () => {
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const { code, out } = await status();
    expect(out).toContain('note: the herdr session "acme-web" is not running');
    expect(out).toContain('repair: the owner runs team up');
    expect(out).not.toContain('grok-acme is in the file');
    expect(out).toContain('4 difference(s)');
    expect(code).toBe(1);
  });

  test('an agent in a seat\'s workspace under another name, or none', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = state.sessions['acme-web'] ?? emptySession();
      session.seats['deepseek-acme'] = { stage: 'ready', workspace: 'w3', pane: 'w3:p1' };
      session.seats['codex-acme'] = { stage: 'ready', workspace: 'w2', pane: 'w2:p1' };
      state.sessions['acme-web'] = session;
    });
    const agents = built().agents.map((one) => (one.name === 'deepseek-acme' ? { ...one, name: null } : one.name === 'codex-acme' ? { ...one, name: 'codex-old' } : one));
    live = {
      ...built(),
      agents,
      screens: { ...built().screens, 'w2:p1': codexScreen('idle'), 'w3:p1': claudeScreen('Opus 5.5') },
    };
    const { out } = await status();
    expect(out).toContain('deepseek-acme: the agent in w3:p1 is unnamed\n  repair: herdr --session acme-web agent rename w3:p1 deepseek-acme');
    expect(out).toContain('codex-acme: the agent in w2:p1 is named "codex-old"');
    // The model column is what the screen names. Codex's captured footer names GPT Terra 5.6.
    // DeepSeek's seat runs through Claude Code, whose screen cannot name that model, so the
    // cell is unread — never the file's display, and never the workspace label.
    expect(out).toMatch(/codex-acme\s+wrong name\s+GPT Terra 5\.6\s+w2:p1/);
    expect(out).toMatch(/deepseek-acme\s+wrong name\s+\(unread\)\s+w3:p1/);
    expect(out).not.toMatch(/codex-acme\s+wrong name\s+GPT-6 Sol/);
    expect(out).not.toMatch(/deepseek-acme\s+wrong name\s+DeepSeek/);
    expect(out).toContain('2 difference(s)');
  });

  test('an agent the file doesn\'t hold; the watch\'s own workspace is not one', async () => {
    live = { ...built(), agents: [...built().agents, agent('stranger', 'w7'), agent(null, 'w9')] };
    const { out } = await status();
    expect(out).toContain('difference: stranger (w7:p1) is running and is not in the file');
    expect(out).toContain('1 difference(s)');
  });

  test('a seat that runs another model than the file\'s', async () => {
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Fable 5.1') } };
    const { code, out } = await status();
    expect(out).toContain('difference: claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5');
    expect(code).toBe(1);
  });

  // The example's lead is both orchestrator and operator. `remove --keep` is refused for it;
  // an ordinary seat still gets that sequence. Correcting the file remains a repair for both.
  test('a lead model mismatch names team down, and an ordinary seat keeps remove --keep', async () => {
    live = {
      ...built(),
      screens: { 'w1:p1': claudeScreen('Fable 5.1'), 'w2:p1': codexScreen('idle') },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain(
      'difference: claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5\n' +
        '  repair: restart the seat on the file\'s model (team down, then team up (to restart the whole team)), or correct the file and run team approve\n',
    );
    expect(out).toContain(
      'difference: codex-acme runs GPT Terra 5.6; the file says GPT-6 Sol\n' +
        '  repair: restart the seat on the file\'s model (team remove codex-acme --keep, then team add codex-acme), or correct the file and run team approve\n',
    );
    expect(out).not.toContain('team remove claude-coordinator-acme --keep');
  });

  // The example names one seat as both orchestrator and operator. These two runs split that:
  // codex is unparked so it can lead, and only the mismatched seat holds one of the two roles.
  function splitLeads(coordinator: string, operatorName: string) {
    const text = example
      .replace('coordinator: claude-coordinator-acme', `coordinator: ${coordinator}`)
      .replace('operator: claude-coordinator-acme', `operator: ${operatorName}`)
      .replace('    parked: true\n', '');
    writeFileSync(file, text);
    approveOnDisk();
  }

  test('an orchestrator who is not the operator is told team down for a model mismatch', async () => {
    splitLeads('claude-coordinator-acme', 'codex-acme');
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Fable 5.1') } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain(
      'difference: claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5\n' +
        '  repair: restart the seat on the file\'s model (team down, then team up (to restart the whole team)), or correct the file and run team approve\n',
    );
    expect(out).not.toContain('team remove claude-coordinator-acme --keep');
    expect(out).not.toContain('codex-acme runs');
  });

  test('an operator who is not the orchestrator is told team down for a model mismatch', async () => {
    splitLeads('codex-acme', 'claude-coordinator-acme');
    live = { ...built(), screens: { 'w1:p1': claudeScreen('Fable 5.1') } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain(
      'difference: claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5\n' +
        '  repair: restart the seat on the file\'s model (team down, then team up (to restart the whole team)), or correct the file and run team approve\n',
    );
    expect(out).not.toContain('team remove claude-coordinator-acme --keep');
    expect(out).not.toContain('codex-acme runs');
  });

  // Each profile's own status line, through the same comparison: the codex seat's captured
  // footer names another model, and an id the map doesn't know is unread, never a difference.
  test('a codex seat whose captured status line names another model', async () => {
    live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { code, out } = await status();
    expect(out).toContain('difference: codex-acme runs GPT Terra 5.6; the file says GPT-6 Sol');
    expect(code).toBe(1);
  });

  // A seat with a `display` is spelled by it everywhere: the table's model column and the
  // difference line name the declared model in the same spelling (doctor's lines and the
  // watch's drift notice are held to the same one by their own tests).
  test('the table and the difference line spell a display seat alike', async () => {
    live = { ...built(), screens: { ...built().screens, 'w2:p1': codexScreen('idle') } };
    const { out } = await status();
    expect(out).toContain('(file: GPT-6 Sol)');
    expect(out).toContain('the file says GPT-6 Sol');
    expect(out).not.toContain('the file says GPT Sol 6');
  });

  test('a status-line id the map doesn\'t know is unread: a note, never a difference', async () => {
    const screen = codexScreen('idle').replace('GPT-5.6-Terra medium ·', 'GPT-9-Nova medium ·');
    live = { ...built(), screens: { ...built().screens, 'w2:p1': screen } };
    const { code, out } = await status();
    expect(out).toContain('note: codex-acme: version unread');
    expect(out).not.toContain('codex-acme runs');
    expect(code).toBe(0);
  });

  // Claude Code's line names Claude's families only: the DeepSeek seat's own status line says
  // nothing to compare, so it is unread rather than wrong.
  test('a seat that runs another maker\'s model through Claude Code is unread, never a mismatch', async () => {
    live = { ...built(), screens: { ...built().screens, 'w3:p1': claudeScreen('Opus 5.5') } };
    const { code, out } = await status();
    expect(out).toContain('note: deepseek-acme: version unread');
    expect(out).not.toContain('deepseek-acme runs');
    expect(code).toBe(0);
  });

  test('a stored classification outside the closed list reads unknown in the row and the difference', async () => {
    // A state file as a hand-edited or corrupted one can hold: an escape sequence and a forged
    // line where the classification belongs. The row, the difference and its repair carry the
    // validated reading — `unknown` — never the stored bytes.
    const raw = JSON.parse(readFileSync(join(dir, '.agents', 'team.state.json'), 'utf8'));
    raw.sessions['acme-web'].seats['deepseek-acme'] = {
      stage: 'launched',
      pane: 'w3:p1',
      workspace: 'w3',
      waiting: { state: 'waiting-owner', classification: 'trust\x1b[2J\r\ninjected' },
    };
    writeFileSync(join(dir, '.agents', 'team.state.json'), JSON.stringify(raw));
    const { code, out } = await status();
    expect(out).toContain('deepseek-acme: waiting for owner (unknown)');
    expect(out).not.toContain('injected');
    expect(out).not.toContain('\x1b[2J');
    expect(code).toBe(1);
  });

  test('a stopped seat that runs', async () => {
    live = { ...built(), agents: [...built().agents, agent('grok-acme', 'w5', 'idle', 'grok')] };
    const { out } = await status();
    expect(out).toContain('grok-acme is marked stopped in the file and is running');
  });

  test('what the state records: a launch that stopped, rules not delivered, a temporary seat, a failed setup', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = state.sessions['acme-web'] ?? emptySession();
      session.seats['codex-acme'] = { stage: 'named' };
      session.seats['deepseek-acme'] = { stage: 'ready', rules: 'undelivered' };
      session.seats['codex-acme-tmp-1'] = { stage: 'ready', temporary: { like: 'codex-acme', until: 'merged:fix/select-width' } };
      session.seats['codex-acme-tmp-2'] = { stage: 'ready', temporary: { like: 'codex-acme', until: 'result:out.md' } };
      session.worktrees['select-width'] = { path: '../worktrees/acme-web/select-width', branch: 'fix/select-width', setup: 'failed' };
    });
    live = { ...built(), agents: [...built().agents, agent('codex-acme-tmp-1', 'w6', 'working', 'codex')] };
    const { out } = await status();
    expect(out).toContain('codex-acme: its launch stopped at "named"\n  repair: the owner runs team up (it resumes the launch)');
    expect(out).toContain('deepseek-acme: its rules were not delivered');
    expect(out).toContain('note: codex-acme-tmp-1 is temporary, until merged:fix/select-width');
    expect(out).toContain('codex-acme-tmp-2: a temporary seat is recorded and is not running');
    expect(out).toContain('worktree select-width: its setup failed\n  repair: team worktree remove select-width');
    expect(out).toContain('4 difference(s)');
  });

  test('a watch whose last pass is older than two intervals, and no watch at all', async () => {
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ?? emptySession()).watch = { pid: 1, heartbeat: '2026-10-03T14:00:00Z' };
    });
    expect((await status()).out).toContain('the watch\'s last pass was 10 minute(s) ago\n  repair: team watch --session acme-web');
    updateState(join(dir, '.agents'), (state) => {
      delete state.sessions['acme-web']?.watch;
    });
    expect((await status()).out).toContain('no watch has run for this session');
  });

  test('a protected checkout off its branch', async () => {
    branch = 'fix/select-width';
    const { code, out } = await status();
    expect(out).toContain('the protected checkout "." is on "fix/select-width", not on "main"');
    expect(code).toBe(1);
  });

  test('a file changed since the owner approved it, and one never approved', async () => {
    // What the owner approved: one rules line and grok's model differ from the file on disk.
    const approvedText = example
      .replace('- Run the tests your change touches, not the whole suite.', '- Run the tests your change touches.')
      .replace('    model: Grok\n', '    model: Grok 5\n');
    const approvedFile = validateTeamFile(approvedText);
    if (!approvedFile.ok) throw new Error('the approved variant does not validate');
    standing = verifiedOf(approvedFile.team, approvedText, dir, NOW);
    const changed = await status();
    expect(changed.out).toContain('difference: the file differs from the approved one: `rules` changed\n  repair: the owner runs team approve');
    expect(changed.out).toContain('2 difference(s)');
    standing = { kind: 'none' };
    expect((await status()).out).toContain('difference: the file was never approved on this machine');
  });

  test('--session reads another session, with its own state', async () => {
    const { out } = await status('--session', 'team-test');
    expect(out).toContain('session "team-test"');
    expect(out).toContain('no watch has run for this session\n  repair: team watch --session team-test');
  });

  test('a broken file: status falls back to the last valid copy and says so first', async () => {
    await status();
    expect(readState(join(dir, '.agents')).last_valid?.file).toBe(example);
    writeFileSync(file, example.replace('format: 1', 'format: 9'));
    const { code, out } = await status();
    expect(out.split('\n')[0]).toBe('team.yaml is invalid (line 1: format must be 1: this version of team reads no other); using the copy of 2026-10-03T14:10:00.000Z');
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('a broken file with no valid copy: the problems, with their lines', async () => {
    writeFileSync(file, 'format: 9\n');
    const { code, err } = await status();
    expect(err).toContain('team.yaml line 1: format must be 1');
    expect(code).toBe(2);
  });

  test('a named account with no reading is unknown, and a stored reading is a row', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [status_line] }
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }
`,
    ));
    approveOnDisk();
    saveReadings(join(dir, '.agents'), [{
      account: 'openai',
      window: 'weekly',
      left: 39,
      used: 61,
      changedAt: NOW.getTime() - 2 * 60 * 1000,
      resetsAt: NOW.getTime() + 44 * 60 * 1000,
      seat: 'codex-acme',
      source: 'status_line',
      confirmed: true,
    }], NOW.getTime());
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('openai  weekly  left 39%  used 61%  resets in 44m  codex-acme  changed 2m ago  status line  fresh');
    expect(out).toContain('deepseek  unknown');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'deepseek', window: null, left: null, used: null, resetsIn: null, seat: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: null },
      { account: 'openai', window: 'weekly', left: 39, used: 61, resetsIn: '44m', seat: 'codex-acme', age: '2m', source: 'status_line', fallback: false, state: 'fresh', inside: false, reserve: 10 },
    ]);
  });

  test('a stored spend reading prints no figure: its row is unknown in the table and the JSON', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    deepseek: { kind: spend, floor: 5 USD, sources: [check], check: deepseek-balance }
`,
    ));
    approveOnDisk();
    saveSpendReadings(join(dir, '.agents'), [
      { account: 'deepseek', amount: 4.996, currency: 'USD', at: NOW.getTime() - 3 * 60 * 1000 },
    ]);
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('deepseek  unknown');
    expect(out).not.toContain('4.996');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'deepseek', window: null, left: null, used: null, resetsIn: null, seat: null, age: null, source: null, fallback: false, state: 'unknown', inside: false, reserve: null },
    ]);
  });

  test('a stored check reading is a row with its own source, and no seat', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check, status_line], check: openai-usage }
`,
    ));
    approveOnDisk();
    saveReadings(join(dir, '.agents'), [{
      account: 'openai',
      window: 'weekly',
      left: 5,
      used: 95,
      changedAt: NOW.getTime() - 2 * 60 * 1000,
      resetsAt: null,
      seat: null,
      source: 'check',
      confirmed: true,
    }], NOW.getTime());
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('openai  weekly  left 5%  used 95%  resets unknown  -  read 2m ago  check  fresh, inside reserve 10%');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'openai', window: 'weekly', left: 5, used: 95, resetsIn: null, seat: null, age: '2m', source: 'check', fallback: false, state: 'fresh', inside: true, reserve: 10 },
    ]);
  });

  test('a figure the account\'s first source did not give is marked a fallback', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check, status_line], check: openai-usage }
`,
    ));
    approveOnDisk();
    saveReadings(join(dir, '.agents'), [{
      account: 'openai',
      window: 'weekly',
      left: 39,
      used: 61,
      changedAt: NOW.getTime() - 2 * 60 * 1000,
      resetsAt: NOW.getTime() + 44 * 60 * 1000,
      seat: 'codex-acme',
      source: 'status_line',
      confirmed: true,
    }], NOW.getTime());
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toContain('openai  weekly  left 39%  used 61%  resets in 44m  codex-acme  changed 2m ago  status line (fallback)  fresh');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.budgets).toEqual([
      { account: 'openai', window: 'weekly', left: 39, used: 61, resetsIn: '44m', seat: 'codex-acme', age: '2m', source: 'status_line', fallback: true, state: 'fresh', inside: false, reserve: 10 },
    ]);
  });

  test('a point on a stored reading moves no row, no difference and no --json field', async () => {
    writeFileSync(file, example.replace(
      '  marks: [50, 75, 90]          # percent used, per account and window\n',
      `  marks: [50, 75, 90]
  accounts:
    openai: { kind: subscription, reserve: 10%, sources: [check, status_line], check: openai-usage }
`,
    ));
    approveOnDisk();
    const seeded: Seen[] = [
      {
        account: 'openai', window: 'session', left: 40, used: 60,
        changedAt: NOW.getTime() - 2 * 60 * 1000, resetsAt: NOW.getTime() + 44 * 60 * 1000,
        seat: null, source: 'check' as const, confirmed: true,
      },
      {
        account: 'openai', window: 'weekly', left: 39, used: 61,
        changedAt: NOW.getTime() - 2 * 60 * 1000, resetsAt: NOW.getTime() + 44 * 60 * 1000,
        seat: 'codex-acme', source: 'status_line' as const, confirmed: true,
      },
    ];
    // § 5: the point is a passenger on the stored reading. The same `team status`, the same rows
    // and differences, and the same `budgets` JSON, whether the state's readings carry points or
    // do not.
    const run = async (points: boolean) => {
      saveReadings(join(dir, '.agents'), points ? seeded.map(withWas) : seeded, NOW.getTime());
      const text = await status();
      const json = JSON.parse((await status('--json')).out) as { budgets: unknown[] };
      return { code: text.code, out: text.out, budgets: json.budgets };
    };
    const plain = await run(false);
    const pointed = await run(true);
    // Non-vacuity: the rows this pins are the stored readings' own, fallback mark and all.
    expect(plain.out).toContain('openai  session  left 40%  used 60%  resets in 44m  -  read 2m ago  check  fresh');
    expect(plain.out).toContain('openai  weekly  left 39%  used 61%  resets in 44m  codex-acme  changed 2m ago  status line (fallback)  fresh');
    expect(plain.budgets).toHaveLength(2);
    expect(pointed).toEqual(plain);
  });

  test('no budgets table when the file names no account and nothing is stored', async () => {
    const { out } = await status();
    const json = JSON.parse((await status('--json')).out);
    expect(out).not.toContain('budgets:');
    expect(json.budgets).toBeUndefined();
  });

  test('herdr that doesn\'t answer, and a bad option', async () => {
    live = null;
    expect(await status()).toMatchObject({ code: 2, err: expect.stringContaining('herdr doesn\'t answer') });
    expect(await status('--fix')).toMatchObject({ code: 2, err: expect.stringContaining('unknown option --fix') });
    expect((await status('--fix')).err).toContain('Usage: team status [--session <name>] [--file <path>] [--all] [--json]\n');
  });

  test('--json: pins the stable format 1 shape on a clean team', async () => {
    const { code, out, err } = await status('--json');
    expect(code).toBe(0);
    expect(err).toBe(WARNING);
    const doc = JSON.parse(out);
    expect(Object.keys(doc).sort()).toEqual(['differences', 'format', 'notes', 'notice', 'project', 'rows', 'session']);
    expect(doc.format).toBe(1);
    expect(doc.project).toBe('acme-web');
    expect(doc.session).toBe('acme-web');
    expect(doc.notice).toBeNull();
    expect(doc.differences).toEqual([]);
    expect(doc.notes).toEqual([
      'approval #1 (2026-10-03)',
      'codex-acme: version unread (its screen doesn\'t show the model)',
      'deepseek-acme: version unread (its screen doesn\'t show the model)',
      'deepseek-acme-2: version unread (its screen doesn\'t show the model)',
    ]);
    expect(doc.rows).toEqual([
      { name: 'claude-coordinator-acme', state: 'working', model: 'Claude Opus 5.5', pane: 'w1:p1' },
      { name: 'codex-acme', state: 'idle (screen not recognised), parked', model: 'GPT-6 Sol (unread)', pane: 'w2:p1' },
      { name: 'deepseek-acme', state: 'done (screen not recognised)', model: 'DeepSeek V4.1 Flash (unread)', pane: 'w3:p1' },
      { name: 'deepseek-acme-2', state: 'idle (screen not recognised)', model: 'DeepSeek V4.1 Flash (unread)', pane: 'w4:p1' },
      { name: 'grok-acme', state: 'stopped', model: 'Grok 4.7', pane: '-' },
    ]);
  });

  test("--json: a grok seat's model — the footer names it, a question widget falls back to the launch line's", async () => {
    const grokScreen = (name: string) => readFileSync(new URL(`./fixtures/grok/1.0.52/${name}.txt`, import.meta.url), 'utf8');
    live = {
      ...built(),
      agents: [...built().agents, agent('grok-acme', 'w10', 'idle', 'grok')],
      workspaces: [...built().workspaces, { id: 'w10', label: 'grok 4.7' }],
      screens: { ...built().screens, 'w10:p1': grokScreen('idle') },
    };
    const clean = JSON.parse((await status('--json')).out) as { rows: { name: string; model: string; pane: string }[]; notes: string[] };
    expect(clean.rows.find((row) => row.name === 'grok-acme')).toMatchObject({ model: 'Grok 4.7', pane: 'w10:p1' });
    expect(clean.notes).toEqual(clean.notes.filter((note) => !note.startsWith('grok-acme:')));

    live = { ...live, screens: { ...live.screens, 'w10:p1': grokScreen('question') } };
    const asked = JSON.parse((await status('--json')).out) as { rows: { name: string; model: string; pane: string }[]; notes: string[] };
    expect(asked.rows.find((row) => row.name === 'grok-acme')).toMatchObject({ model: 'Grok 4.7 (from launch)', pane: 'w10:p1' });
    expect(asked.notes).toContain("grok-acme: its screen shows no model; the launch line's Grok 4.7 stands");
  });

  test('--json: reports differences with exit 1 and the same structure', async () => {
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const { code, out } = await status('--json');
    expect(code).toBe(1);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.differences).toEqual([
      { what: 'deepseek-acme-2 is in the file and is not running', repair: 'team add deepseek-acme-2' },
    ]);
  });

  test('--json: includes notice when falling back to last valid copy', async () => {
    await status();
    writeFileSync(file, example.replace('format: 1', 'format: 9'));
    const { code, out } = await status('--json');
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.notice).toContain('team.yaml is invalid');
    expect(doc.differences).toEqual([]);
  });

  test('--json: notes when session is not running', async () => {
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const { code, out } = await status('--json');
    expect(code).toBe(1);
    const doc = JSON.parse(out);
    expect(doc.format).toBe(1);
    expect(doc.notes).toContain('the herdr session "acme-web" is not running');
    expect(doc.differences.length).toBe(4);
  });

  test('A: the approval repair comes first and marks the repairs that wait on it; a missing watch marks nothing', async () => {
    // 1. A missing watch and two seats not running: the watch moves nothing and marks nothing
    live = {
      ...built(),
      agents: built().agents.filter(
        (one) => one.name !== 'deepseek-acme' && one.name !== 'deepseek-acme-2',
      ),
    };
    updateState(join(dir, '.agents'), (state) => {
      delete state.sessions['acme-web']?.watch;
    });

    const missingWatch = await status();
    expect(missingWatch.code).toBe(1);
    const add1 = missingWatch.out.indexOf('difference: deepseek-acme is in the file and is not running\n  repair: team add deepseek-acme\n');
    const add2 = missingWatch.out.indexOf('difference: deepseek-acme-2 is in the file and is not running\n  repair: team add deepseek-acme-2\n');
    const watch = missingWatch.out.indexOf('difference: no watch has run for this session\n  repair: team watch --session acme-web\n');
    expect(add1).toBeGreaterThanOrEqual(0);
    expect(add2).toBeGreaterThanOrEqual(0);
    // The differences keep the order they were created in: the watch's, made after them, stays after them.
    expect(watch).toBeGreaterThan(add1);
    expect(watch).toBeGreaterThan(add2);
    expect(missingWatch.out).not.toContain('(after:');

    // 2. An unapproved file: the approval difference first, then the repairs that name a command
    //    that refuses on it. The watch is not blocked by the approval and is not marked either.
    standing = { kind: 'none' };
    const unapproved = await status();
    expect(unapproved.code).toBe(1);
    const approve = unapproved.out.indexOf('difference: the file was never approved on this machine\n  repair: the owner runs team approve');
    expect(approve).toBeGreaterThanOrEqual(0);
    expect(unapproved.out).toContain('repair: team add deepseek-acme (after: the owner runs team approve)');
    expect(unapproved.out).toContain('repair: team add deepseek-acme-2 (after: the owner runs team approve)');
    expect(unapproved.out.indexOf('difference: deepseek-acme is in the file and is not running')).toBeGreaterThan(approve);
    expect(unapproved.out).toContain('difference: no watch has run for this session\n  repair: team watch --session acme-web\n');
  });

  test('B: whose repair: each repair string that names an owner command asserted exactly', async () => {
    // 1. the owner runs team approve
    standing = { kind: 'none' };
    const approveRun = await status();
    expect(approveRun.out).toContain('repair: the owner runs team approve');

    // 2. the owner runs team up
    const validTeam = validateTeamFile(example);
    if (!validTeam.ok) throw new Error('invalid example');
    standing = verifiedOf(validTeam.team, example, dir, NOW);
    live = { running: false, agents: [], workspaces: [], screens: {} };
    const upRun = await status();
    expect(upRun.out).toContain('repair: the owner runs team up');

    // 3. the owner runs team up (it resumes the launch)
    live = built();
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'launched' };
    });
    const resumeRun = await status();
    expect(resumeRun.out).toContain('repair: the owner runs team up (it resumes the launch)');

    // 4. the owner switches it back: git -C <shown> switch <base>
    branch = 'fix/other';
    const switchRun = await status();
    expect(switchRun.out).toContain('repair: the owner switches it back: git -C . switch main');
    branch = 'main';

    // 5. the owner clears or sends it in the pane; team does not type into a box it can't verify
    const codexUnsent = codexScreen('unsent');
    live = {
      ...built(),
      screens: { ...built().screens, 'w2:p1': codexUnsent },
    };
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'ready' };
    });
    const unsentRun = await status();
    expect(unsentRun.out).toContain(
      "repair: the owner clears or sends it in the pane; team does not type into a box it can't verify",
    );

    // 6. the owner clears or sends it in the pane, then runs team up (it resumes the launch)
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'named' };
    });
    const mergedRun = await status();
    expect(mergedRun.out).toContain(
      'repair: the owner clears or sends it in the pane, then runs team up (it resumes the launch)',
    );
  });

  test('C: unsent text: table cell, difference, merged form for named seat, unchanged for unknown', async () => {
    const codexUnsent = codexScreen('unsent');

    // Seat reads unsent (stage: ready)
    live = {
      ...built(),
      screens: { ...built().screens, 'w2:p1': codexUnsent },
    };
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'ready' };
    });
    const unsentRes = await status();
    expect(unsentRes.out).toMatch(/codex-acme\s+idle \(unsent text\), parked/);
    expect(unsentRes.out).toContain('difference: codex-acme holds text in its input box that was never sent');
    expect(unsentRes.out).toContain("repair: the owner clears or sends it in the pane; team does not type into a box it can't verify");

    // merged form for a named seat
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'named' };
    });
    const namedRes = await status();
    expect(namedRes.out).toContain('difference: codex-acme: its launch stopped at "named", and it holds text in its input box that was never sent');
    expect(namedRes.out).toContain('repair: the owner clears or sends it in the pane, then runs team up (it resumes the launch)');
    expect(namedRes.out).not.toContain('difference: codex-acme holds text in its input box that was never sent');

    // seat that reads unknown: no unsent reading; the row says what herdr's word could not
    live = {
      ...built(),
      screens: { ...built().screens, 'w2:p1': 'Some unknown output without composer\n' },
    };
    const unknownRes = await status();
    expect(unknownRes.out).toMatch(/codex-acme\s+idle \(screen not recognised\), parked/);
    expect(unknownRes.out).toContain('difference: codex-acme: its launch stopped at "named"\n  repair: the owner runs team up (it resumes the launch)');
    expect(unknownRes.out).not.toContain('unsent text');
    expect(unknownRes.out).not.toContain('holds text in its input box that was never sent');
  });

  test('C2: done is as free as idle — unsent text is read for both; working and blocked are not', async () => {
    const codexUnsent = codexScreen('unsent');
    const base = built();
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme'] = { stage: 'ready' };
    });

    const withStatus = async (state: string) => {
      live = {
        ...base,
        agents: base.agents.map((one) => (one.name === 'codex-acme' ? { ...one, status: state } : one)),
        screens: { ...base.screens, 'w2:p1': codexUnsent },
      };
      return status();
    };

    // idle: as before
    const idle = await withStatus('idle');
    expect(idle.out).toMatch(/codex-acme\s+idle \(unsent text\), parked/);
    expect(idle.out).toContain('difference: codex-acme holds text in its input box that was never sent');

    // done: the same reading and the same difference — team types into a done box too
    const done = await withStatus('done');
    expect(done.out).toMatch(/codex-acme\s+done \(unsent text\), parked/);
    expect(done.out).toContain('difference: codex-acme holds text in its input box that was never sent');

    // working and blocked: the box is not team's to read as unsent text
    for (const state of ['working', 'blocked']) {
      const other = await withStatus(state);
      expect(other.out).toMatch(new RegExp(`codex-acme\\s+${state}, parked`));
      expect(other.out).not.toContain('unsent text');
      expect(other.out).not.toContain('holds text in its input box that was never sent');
    }
  });

  test('C3: a quiet temporary seat on a screen nothing reads: the row says so', async () => {
    const tmp = agent('codex-acme-tmp-1', 'w5', 'done', 'codex');
    live = { ...built(), agents: [...built().agents, tmp] };
    updateState(join(dir, '.agents'), (state) => {
      (state.sessions['acme-web'] ??= emptySession()).seats['codex-acme-tmp-1'] = {
        stage: 'ready', temporary: { like: 'codex-acme', until: 'result:out.md' },
      };
    });
    // Nothing is recorded for its pane, so no profile reads it: the temporary row must not show a
    // bare done either — the cli comes from the like-seat, and the reading is still no reading.
    const unread = await status();
    expect(unread.out).toMatch(/codex-acme-tmp-1\s+done \(screen not recognised\), temporary/);
    // A screen the like-seat's profile does read: the ordinary row, no suffix.
    live = { ...built(), agents: [...built().agents, tmp], screens: { ...built().screens, 'w5:p1': codexScreen('idle') } };
    const readable = await status();
    expect(readable.out).toMatch(/codex-acme-tmp-1\s+done, temporary/);
  });

  test('a seat waiting at a permission or trust prompt is a difference for the owner', async () => {
    const codexPane = built().agents.find((one) => one.name === 'codex-acme')?.pane ?? '';
    const permScreen = codexScreen('permission');
    live = {
      ...built(),
      screens: { ...built().screens, [codexPane]: permScreen },
    };
    const permRes = await status();
    expect(permRes.code).toBe(1);
    expect(permRes.out).toContain(
      "difference: codex-acme waits at a permission prompt: its owner's to answer\n" +
        '  repair: the owner answers it in the pane\n',
    );
    expect(permRes.out).toContain('1 difference(s), 1 for the owner\n');

    const trustScreen = codexScreen('trust-folder');
    live = {
      ...built(),
      screens: { ...built().screens, [codexPane]: trustScreen },
    };
    const trustRes = await status();
    expect(trustRes.code).toBe(1);
    expect(trustRes.out).toContain(
      "difference: codex-acme waits at a permission prompt: its owner's to answer\n" +
        '  repair: the owner answers it in the pane\n',
    );
  });

  test('D: summary line: with and without an owner repair', async () => {
    // 1. Without an owner repair: only a missing seat (repair: team add <seat>)
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const noOwner = await status();
    expect(noOwner.out).toContain('1 difference(s)\n');
    expect(noOwner.out).not.toContain('for the owner');

    // 2. With an owner repair: unapproved file (repair: the owner runs team approve)
    live = built();
    standing = { kind: 'none' };
    const withOwner = await status();
    expect(withOwner.out).toContain('1 difference(s), 1 for the owner\n');

    // 3. Mixed: 1 owner repair (approve) + 1 non-owner repair (add)
    live = { ...built(), agents: built().agents.filter((one) => one.name !== 'deepseek-acme-2') };
    const mixed = await status();
    expect(mixed.out).toContain('2 difference(s), 1 for the owner\n');
  });
});

// A pane is its seat only while the process team launched is still in it. Each case records a
// launch for codex-acme and hands the comparison one process-info reading for its pane.
describe('a pane that no longer holds the process team launched', () => {
  const GONE_REPAIR = '  repair: the owner runs team up\n';

  function recordCodex(patch: Record<string, unknown> = {}) {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['codex-acme'] = {
        stage: 'ready',
        pane: 'w2:p1',
        workspace: 'w2',
        launched: { shell: 400, cli: [401] },
        ...patch,
      };
    });
  }

  test('gone: the table cell, the difference, the repair and the JSON row', async () => {
    recordCodex();
    // The CLI ended, or the session was restored: the pane's own shell is what is left in front.
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [400] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+missing\s+GPT-6 Sol\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: its pane runs no CLI (the CLI ended or the session was restored)\n' + GONE_REPAIR,
    );
    expect(out).toContain('1 difference(s), 1 for the owner\n');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.rows.find((row: { name: string }) => row.name === 'codex-acme')).toEqual({
      name: 'codex-acme',
      state: 'missing',
      model: 'GPT-6 Sol',
      pane: 'w2:p1',
    });
  });

  test('replaced: the screen\'s model is a note, and an unreadable screen has none', async () => {
    recordCodex();
    live = {
      ...built(),
      processes: { 'w2:p1': { shell: 400, foreground: [500] } },
      screens: { ...built().screens, 'w2:p1': codexScreen('idle') },
    };
    const readable = await status();
    expect(readable.code).toBe(1);
    expect(readable.out).toMatch(/codex-acme\s+restored, not launched by team\s+-\s+w2:p1/);
    expect(readable.out).toContain(
      'difference: codex-acme runs GPT Terra 5.6; the file says GPT-6 Sol; the process in its pane is not the one team launched\n' +
        '  repair: team remove codex-acme --keep, then team add codex-acme\n',
    );
    expect(readable.out).not.toContain('note: codex-acme: its pane runs');
    expect(readable.out).not.toMatch(/codex-acme\s+restored, not launched by team\s+GPT/);
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [500] } } };
    const unread = await status();
    expect(unread.out).toMatch(/codex-acme\s+restored, not launched by team\s+-\s+w2:p1/);
    expect(unread.out).not.toContain('its pane runs');
    expect(unread.code).toBe(1);
  });

  test('replaced: never idle, never under the declared model', async () => {
    recordCodex();
    // Another CLI runs in the pane — the session was restored with a program team did not launch.
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [500] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+restored, not launched by team\s+-\s+w2:p1/);
    expect(out).not.toMatch(/codex-acme\s+idle/);
    expect(out).toContain(
      'difference: codex-acme: its pane holds a process this record cannot tie to the launch\n' +
        '  repair: look at the pane\n',
    );
    expect(out).not.toContain('difference: codex-acme: the process in its pane is not the one team launched');
    const doc = JSON.parse((await status('--json')).out);
    expect(doc.rows.find((row: { name: string }) => row.name === 'codex-acme')).toEqual({
      name: 'codex-acme',
      state: 'restored, not launched by team',
      model: '-',
      pane: 'w2:p1',
    });
  });

  test('a matching agent session is the seat, not a repair that names team up', async () => {
    recordCodex({ agent_session: 'kept' });
    const agents = built().agents.map((one) => one.name === 'codex-acme' ? { ...one, session: 'kept' } : one);
    live = { ...built(), agents, processes: { 'w2:p1': { shell: 500, foreground: [501] } } };
    const { out } = await status();
    expect(out).not.toMatch(/codex-acme\s+restored, not launched by team/);
    expect(out).not.toContain('codex-acme: its pane holds a process this record cannot tie to the launch');
    expect(out).not.toContain('difference: codex-acme');
    expect(out).toMatch(/codex-acme\s+idle/);
  });

  test('a restored launcher is named, and nothing starts the seat', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['deepseek-acme'] = {
        stage: 'ready',
        pane: 'w3:p1',
        workspace: 'w3',
        launched: { shell: 400, cli: [401] },
        agent_session: 'kept',
      };
    });
    const agents = built().agents.map((one) => one.name === 'deepseek-acme' ? { ...one, session: 'kept' } : one);
    live = { ...built(), agents, processes: { 'w3:p1': { shell: 500, foreground: [501] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).not.toMatch(/deepseek-acme\s+restored, not launched by team/);
    expect(out).toContain(
      'difference: deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched\n' +
        '  repair: team remove deepseek-acme --keep, then team add deepseek-acme\n',
    );
    expect(out).not.toContain('repair: the owner runs team up\n');
  });

  test('a launcher the record cannot tie names the model and the restart', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['deepseek-acme'] = {
        stage: 'ready',
        pane: 'w3:p1',
        workspace: 'w3',
        launched: { shell: 400, cli: [401] },
      };
    });
    live = {
      ...built(),
      processes: { 'w3:p1': { shell: 400, foreground: [500] } },
      screens: { ...built().screens, 'w3:p1': claudeScreen('Opus 5.5') },
    };
    const { out } = await status();
    expect(out).toMatch(/deepseek-acme\s+restored, not launched by team\s+-\s+w3:p1/);
    // Claude Code's status line cannot name this seat's model, so the screen is not a difference.
    // The launch line is: it starts a launcher, and this process is not the one team launched.
    expect(out).toContain(
      'difference: deepseek-acme: its launch line starts a launcher, and the process in its pane is not the one team launched\n' +
        '  repair: team remove deepseek-acme --keep, then team add deepseek-acme\n',
    );
    expect(out).not.toContain('deepseek-acme runs');
    expect(out).not.toContain('repair: look at the pane\n');
    expect(out).not.toContain('repair: the owner runs team up\n');
  });

  test('gone with no agent listed: its pane is read, not called a missing seat', async () => {
    recordCodex();
    // The name went from herdr's agent list with the CLI. Its recorded pane still stands, and the
    // shell in it is read: this is the launch that ended, not a seat a rename could put right.
    live = {
      ...built(),
      agents: built().agents.filter((one) => one.name !== 'codex-acme'),
      processes: { 'w2:p1': { shell: 400, foreground: [400] } },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+missing\s+GPT-6 Sol\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: its pane runs no CLI (the CLI ended or the session was restored)\n' + GONE_REPAIR,
    );
    expect(out).not.toContain('codex-acme is in the file and is not running');
  });

  test('replaced with no agent listed: the pane is not renamed into a seat', async () => {
    recordCodex();
    // A stranger runs in the recorded pane under no name of the file's: before, this pane was a
    // stray to rename into the seat. It is not the seat, and it is not ours to name.
    live = {
      ...built(),
      agents: [
        ...built().agents.filter((one) => one.name !== 'codex-acme'),
        agent('stranger', 'w2', 'idle', 'codex'),
      ],
      processes: { 'w2:p1': { shell: 400, foreground: [500] } },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+restored, not launched by team\s+-\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: its pane holds a process this record cannot tie to the launch\n' +
        '  repair: look at the pane\n',
    );
    expect(out).not.toContain('repair: the owner runs team up\n');
    expect(out).not.toContain('is named "stranger"');
    expect(out).not.toContain('agent rename');
  });

  test('a reading herdr cannot give keeps today: the seat reads as it did before', async () => {
    recordCodex();
    live = { ...built(), processes: { 'w2:p1': null } };
    const { code, out } = await status();
    expect(code).toBe(0);
    expect(out).toMatch(/codex-acme\s+idle \(screen not recognised\), parked/);
    expect(out).not.toContain('its pane runs no CLI');
  });

  test('a ready seat with no process identity whose pane is a shell names abandon, then up', async () => {
    // 0.2.1 wrote the seat ready and named its pane, and never the process. The multiplexer
    // restored that pane as a shell. `up` will not relaunch it, so the repair is not `team up`.
    recordCodex({ launched: undefined });
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [400] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toMatch(/codex-acme\s+missing\s+GPT-6 Sol\s+w2:p1/);
    expect(out).toContain(
      'difference: codex-acme: its pane runs no CLI and its process was never recorded\n' +
        '  repair: team remove codex-acme --abandon, then team up\n',
    );
    expect(out).not.toContain('the owner runs team up');
    expect(out).not.toMatch(/codex-acme\s+idle/);
  });

  test('a launch left on a shell with no process identity is not told that team up resumes it', async () => {
    recordCodex({ launched: undefined, stage: 'launched' });
    live = { ...built(), processes: { 'w2:p1': { shell: 400, foreground: [400] } } };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain('repair: team remove codex-acme --abandon, then team up');
    expect(out).not.toContain('it resumes the launch');
    expect(out).not.toContain('the owner runs team up');
  });

  test('a shell in the recorded pane, with no agent listed and no identity, is not a seat team up starts', async () => {
    recordCodex({ launched: undefined });
    live = {
      ...built(),
      agents: built().agents.filter((one) => one.name !== 'codex-acme'),
      processes: { 'w2:p1': { shell: 400, foreground: [400] } },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain(
      'difference: codex-acme: its pane runs no CLI and its process was never recorded\n' +
        '  repair: team remove codex-acme --abandon, then team up\n',
    );
    expect(out).not.toContain('codex-acme is in the file and is not running');
    expect(out).not.toContain('the owner runs team up');
  });

  test('a model mismatch on a seat with no process identity names abandon, not remove --keep', async () => {
    recordCodex({ launched: undefined });
    live = {
      ...built(),
      processes: { 'w2:p1': { shell: 400, foreground: [401] } },
      screens: { ...built().screens, 'w2:p1': codexScreen('idle') },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain('codex-acme runs GPT Terra 5.6; the file says GPT-6 Sol; its process was never recorded');
    expect(out).toContain('repair: team remove codex-acme --abandon, then team up');
    expect(out).not.toContain('team remove codex-acme --keep');
    expect(out).not.toContain('the owner runs team up');
  });

  test('a lead whose record has no process identity and whose screen is another model names down --abandon', async () => {
    updateState(join(dir, '.agents'), (state) => {
      const session = (state.sessions['acme-web'] ??= emptySession());
      session.seats['claude-coordinator-acme'] = { stage: 'ready', pane: 'w1:p1', workspace: 'w1' };
    });
    live = {
      ...built(),
      processes: { 'w1:p1': { shell: 10, foreground: [11] } },
      screens: { 'w1:p1': claudeScreen('Fable 5.1') },
    };
    const { code, out } = await status();
    expect(code).toBe(1);
    expect(out).toContain(
      'claude-coordinator-acme runs Claude Fable 5.1; the file says Claude Opus 5.5; its process was never recorded',
    );
    expect(out).toContain('repair: team down --abandon, then team up');
    expect(out).not.toContain('team remove claude-coordinator-acme');
    expect(out).not.toContain('the owner runs team up');
  });

  test('a model mismatch on the process team launched still names remove --keep', async () => {
    recordCodex();
    live = {
      ...built(),
      processes: { 'w2:p1': { shell: 400, foreground: [401] } },
      screens: { ...built().screens, 'w2:p1': codexScreen('idle') },
    };
    const { out } = await status();
    expect(out).toContain('codex-acme runs GPT Terra 5.6; the file says GPT-6 Sol');
    expect(out).toContain('team remove codex-acme --keep, then team add codex-acme');
    expect(out).not.toContain('--abandon');
  });
});

describe('the status line of Claude Code', () => {
  test('is read from a real screen', () => {
    const screen = `❯\n${'─'.repeat(40)}\n  main · …/floor/docs · Opus 5.5 · S: $5.8 ⣿⣄⣀⣀⣀ 24% · L: 20% (2h6m) · W: 12% (+13.3%) (125h26m)\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n`;
    expect(runningModel('claude-code', screen)).toEqual({ model: 'Claude Opus', version: '5.5' });
  });
  test('is unread when the screen doesn\'t show it, and for a CLI without a normalisation', () => {
    expect(runningModel('claude-code', 'Do you want to proceed?\n1. Yes\n')).toBeNull();
    expect(runningModel('codex', 'GPT-6-Sol high')).toBeNull();
    expect(runningModel('antigravity', 'Do you trust the contents of this project?\n> Yes, I trust this folder\n')).toBeNull();
  });
  test('is read from an Antigravity screen', () => {
    const screen = 'Antigravity CLI\n? for shortcuts               Gemini 3.8 Flash · high\n';
    expect(runningModel('antigravity', screen)).toEqual({ model: 'Gemini Flash', version: '3.8' });
  });
});

describe('the rules files of message seats', () => {
  // The check needs a home the store lives in; the shared sources above set none, which reads
  // as no store at all. These tests give it one under the temp root, as the shipped command
  // gives the owner's.
  let home: string;
  beforeEach(() => {
    home = join(dir, 'home');
    mkdirSync(home);
    // The store already lives in this home, so `team`'s per-user state root is there with it.
    mkdirSync(join(home, '.config', 'team'), { recursive: true, mode: 0o700 });
    sources.home = home;
  });
  afterEach(() => {
    delete sources.home;
  });

  const teamOf = (): TeamFile => {
    const parsed = validateTeamFile(example);
    if (!parsed.ok) throw new Error('the example fixture does not validate');
    return parsed.team;
  };
  const writeAll = (team: TeamFile, edit?: (seat: Seat, text: string) => string) => {
    for (const seat of team.seats) {
      if (seat.stopped) continue;
      const delivery = rulesOf(team, seat, dir);
      const text = edit ? edit(seat, delivery) : delivery;
      // Planted through the same resolution the check reads: the approval in force, not the
      // live file's project name.
      if (rulesFilePathOf(standing, seat.name, dir, home) === null) throw new Error('the fixture seat name must be typeable');
      const written = writeRulesFile(standing, seat.name, dir, home, text, rulesFileHash(text));
      if (!written.ok) throw new Error('the rules file did not write');
    }
  };

  test('a team whose files hold the approved rules reads clean', async () => {
    writeAll(teamOf());
    const { code, out } = await status();
    expect(out).toContain('0 difference(s)');
    expect(code).toBe(0);
  });

  test('a file that differs from the approved rules is a difference the owner repairs with up', async () => {
    writeAll(teamOf(), (seat) => (seat.cli === 'codex' ? 'other rules entirely' : rulesOf(teamOf(), seat, dir)));
    const { code, out } = await status();
    expect(out).toContain('codex-acme: its rules file differs from the approved rules');
    expect(out).toContain('repair: the owner runs team up');
    expect(code).toBe(1);
  });

  test('a missing file is a difference, and a mode wider than 0600 is one too', async () => {
    writeAll(teamOf());
    const seatPath = rulesFilePathOf(standing, 'codex-acme', dir, home);
    if (seatPath === null) throw new Error('the fixture seat name must be typeable');
    rmSync(seatPath, { force: true });
    const missing = await status();
    expect(missing.out).toContain('codex-acme: its rules file is missing');
    expect(missing.code).toBe(1);
    writeAll(teamOf());
    chmodSync(seatPath, 0o644);
    const wide = await status();
    expect(wide.out).toContain('codex-acme: its rules file has mode 0644, not 0600');
    expect(wide.code).toBe(1);
  });
});
