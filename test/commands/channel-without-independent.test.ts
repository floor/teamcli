// Independent scenes for the channel-default lane: `withoutChannel` is a launch-line edit on a
// security surface, so its contract is pinned here apart from the builder's fix. The interface
// contract: only the channel's own argv words leave the line — as source spans, never a
// whitespace split/rejoin — and every other byte of the command survives untouched. One
// restored-seat scene pins the no-registered-root fallback: the seat still relaunches in its own
// pane with one warning and one log line, the runtime command carries no channel flag, and the
// stored launch recipe keeps it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprove } from '../../src/approve/command.ts';
import { runUp, type Launch, type UpSources } from '../../src/commands/up.ts';
import type { DoctorSources } from '../../src/commands/doctor.ts';
import { setHerdrRun, type HerdrAgent, type HerdrWorkspace } from '../../src/herdr.ts';
import { readState } from '../../src/state.ts';
import { CHANNEL_FLAG, CHANNEL_SERVER, withoutChannel } from '../../src/mcp/channel.ts';
import type { Key } from '../../src/launch/terminal.ts';
import { testIo, CLAUDE_IDLE } from '../helpers.ts';

const FLAG = CHANNEL_FLAG;
const PAIR = `${FLAG} server:${CHANNEL_SERVER}`;
const OTHER = 'server:other';

describe('withoutChannel, quoted launch lines', () => {
  test('a command with no channel flag is returned byte for byte', () => {
    const quoted = `'rule one
rule\ttwo keeps  two  spaces, "double quotes", $HOME and a \\ backslash'`;
    const line = `claude --model claude-opus-5-5 --append-system-prompt ${quoted}`;
    expect(withoutChannel(line)).toBe(line);
  });

  // Whole-option removal keeps the separators that surrounded the span: only the span's own
  // bytes go. Ruled accepted-by-design in the source security review — the old whitespace
  // collapse was the bug — so these scenes pin the leftover separator exactly.
  test('removing the channel pair deletes only the pair span: the quoted body and the separator beside it survive', () => {
    const quoted = `'rule one
rule\ttwo keeps  two  spaces, "double quotes", $HOME and a \\ backslash'`;
    const line = `claude --model claude-opus-5-5 --append-system-prompt ${quoted}`;
    expect(withoutChannel(`${line} ${PAIR}`)).toBe(`${line} `);
  });

  test('channel flag text inside a quoted value is not an option and survives', () => {
    const quoted = `'never place ${PAIR} inside the rules body'`;
    const line = `claude --append-system-prompt ${quoted}`;
    expect(withoutChannel(`${line} ${PAIR}`)).toBe(`${line} `);
  });

  test('channel flag text after the positional delimiter is prompt text, not an option', () => {
    const after = `-- prompt words ${PAIR} and more`;
    const line = `claude --model claude-opus-5-5 ${PAIR} ${after}`;
    expect(withoutChannel(line)).toBe(`claude --model claude-opus-5-5  ${after}`);
  });

  test('split and equals forms of the pair are removed, alone or first in a mixed list', () => {
    expect(withoutChannel(`claude -x ${PAIR}`)).toBe('claude -x ');
    expect(withoutChannel(`claude -x ${FLAG}=server:${CHANNEL_SERVER}`)).toBe('claude -x ');
    expect(withoutChannel(`${PAIR} claude -x`)).toBe(' claude -x');
    expect(withoutChannel(`claude -x ${FLAG} server:${CHANNEL_SERVER},${OTHER}`)).toBe(`claude -x ${FLAG} ${OTHER}`);
    expect(withoutChannel(`claude -x ${FLAG}=server:${CHANNEL_SERVER},${OTHER}`)).toBe(`claude -x ${FLAG}=${OTHER}`);
  });

  test('a list that never named this server keeps the flag', () => {
    expect(withoutChannel(`claude -x ${FLAG} ${OTHER}`)).toBe(`claude -x ${FLAG} ${OTHER}`);
    expect(withoutChannel(`claude -x ${FLAG}=${OTHER}`)).toBe(`claude -x ${FLAG}=${OTHER}`);
  });

  // The value grammar is scheme-required: an entry without the `server:` scheme never names
  // this channel, in any form, so the line keeps it. Complements the reviewer's substring-name
  // probes (server:acme2 untouched) with the scheme-less spelling.
  test('entries without the server scheme never name this channel', () => {
    expect(withoutChannel(`claude -x ${FLAG} ${CHANNEL_SERVER}`)).toBe(`claude -x ${FLAG} ${CHANNEL_SERVER}`);
    expect(withoutChannel(`claude -x ${FLAG}=${CHANNEL_SERVER}`)).toBe(`claude -x ${FLAG}=${CHANNEL_SERVER}`);
    expect(withoutChannel(`claude -x ${FLAG} ${CHANNEL_SERVER},${OTHER}`)).toBe(`claude -x ${FLAG} ${CHANNEL_SERVER},${OTHER}`);
  });

  // The plain-line scope shapes as ruled (lead, 2026-11-10; the review's proposed program gate
  // was cancelled because it would break wrapper-named claude-glm channel seats): plain lines
  // are edited by caller scope — both real call sites are claude channel seats — while the
  // script arm alone proves the program it edits. Shape 1, a plain claude line, is pinned in
  // the forms test above.
  test('a plain wrapper line of a channel seat is edited like any plain line', () => {
    const line = `zsh /opt/channel-seats/wrapper.sh ${PAIR} claude --model m`;
    expect(withoutChannel(line)).toBe('zsh /opt/channel-seats/wrapper.sh  claude --model m');
  });

  // Decisive per the lead's sharpening: a channel seat whose launch program is a wrapper NAME,
  // not the claude binary. The flag and server words go; the wrapper and model words stay
  // byte-identical. A literal-claude program gate would keep the whole line, flag included —
  // exactly the wrapper-seat break its cancellation named — so every position is pinned here.
  test('a wrapper-named channel seat line loses only the pair: the wrapper and model words stay byte-identical', () => {
    expect(withoutChannel(`claude-x --model m ${PAIR}`)).toBe('claude-x --model m ');
    expect(withoutChannel(`${PAIR} claude-x --model m`)).toBe(' claude-x --model m');
    expect(withoutChannel(`claude-x --model m ${FLAG}=server:${CHANNEL_SERVER}`)).toBe('claude-x --model m ');
    expect(withoutChannel(`claude-glm --model glm-5.3 ${PAIR} --resume abc`)).toBe('claude-glm --model glm-5.3  --resume abc');
  });

  test('a script arm whose program is not claude is untouched, byte for byte', () => {
    const line = `zsh -c 'cursor-agent --model m ${PAIR} --prompt hi'`;
    expect(withoutChannel(line)).toBe(line);
  });

  // Recorded as ruled: a plain foreign line naming this team's server still loses the span —
  // plain-line scope is caller-scope dependent and no real caller reaches the helper with a
  // foreign program. Pinned so any future program gate must flip this scene on purpose.
  test('a plain foreign line naming the team server is edited: caller-scope dependent, unreachable from real callers', () => {
    expect(withoutChannel(`cursor-agent --model m ${PAIR} --prompt hi`)).toBe('cursor-agent --model m  --prompt hi');
    expect(withoutChannel(`gemini -x ${FLAG}=server:${CHANNEL_SERVER}`)).toBe('gemini -x ');
  });
});

// The restored-seat scene uses the same synthetic world shape as the live restore cases: a
// recorded seat whose pane came back with a stranger's CLI in front of its recorded shell. The
// channel default gives this ordinary Claude seat a channel scope; this world registers no team
// root, so the pair cannot be prepared. The contract under test: that refusal is a warning and a
// log line, never a left-out seat — the repair exits the CLI in place, relaunches the recorded
// line without the channel in the same pane, keeps the identity and no-close guards, and the
// stored recipe keeps the channel.

const EXAMPLE = readFileSync(join(import.meta.dir, '../fixtures/example.yaml'), 'utf8').replace('parked: true', 'stopped: true');
const FILE = ['--file', '.agents/team.yaml'];
const NOW = new Date('2026-11-04T09:15:00Z');
const IDLE = CLAUDE_IDLE;

let base: string;
let root: string;
let home: string;

function makeExample(basePath: string, rootPath: string, text: string = EXAMPLE): string {
  return text.replace(
    /trust:[\s\S]*?workspace:/,
    `trust:\n  - ~/.config/team/lobby\n  - ${rootPath}\n  - ${join(basePath, 'worktrees')}\n\nworkspace:`,
  );
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'team-channel-without-')));
  root = join(base, 'acme-web');
  home = join(base, 'home');
  mkdirSync(join(root, '.agents'), { recursive: true });
  mkdirSync(home);
});

afterEach(() => {
  setHerdrRun(null);
  rmSync(base, { recursive: true, force: true });
});

async function approve() {
  const io = testIo(root, { kind: 'owner' });
  const code = await runApprove(FILE, io, { ask: async () => '5', waiting: () => 'empty', now: () => NOW, home });
  expect(code).toBe(0);
}

function agent(name: string, pane: string, status = 'idle', kind = 'claude'): HerdrAgent {
  return { name, agent: kind, pane, workspace: pane.split(':')[0] ?? pane, status, cwd: null };
}

function doctor(): DoctorSources {
  return {
    version: () => '2.1.288',
    onPath: () => true,
    loggedIn: () => true,
    herdrVersion: () => '0.7.1',
    sessionRunning: () => false,
    now: () => NOW,
    home,
  };
}

type World = {
  launch: Launch;
  runs: { pane: string; command: string }[];
  closes: string[];
  session: 'absent' | 'running' | 'stopped';
  /** The workspaces this run created, as herdr's list would return them: id and label. */
  workspaceList(): HerdrWorkspace[];
  /** The injected owner's terminal: the pause's keys are queued here, never read from stdin. */
  terminal: { keys: Key[]; reads: number; drains: number; key(ms: number): Promise<Key>; drain(): void };
  seed(pane: string, text: string, agent: boolean): void;
  /** The name herdr would list on the pane: null until a rename was taken for it. */
  nameOn(pane: string): string | null;
};

function world(text: string = IDLE): World {
  const state: World = {
    launch: {} as Launch,
    runs: [],
    closes: [],
    workspaceList: () => [...spaces].map(([id, label]) => ({ id, label })),
    terminal: {
      keys: [],
      reads: 0,
      drains: 0,
      async key() {
        state.terminal.reads += 1;
        const next = state.terminal.keys.shift();
        // No test may reach the pause without queueing what its owner would type: a silent
        // fallback would hide an unexpected prompt.
        if (next === undefined) throw new Error('the pause read the terminal, and no key was queued');
        return next;
      },
      drain() {
        state.terminal.drains += 1;
      },
    },
    session: 'absent',
    nameOn(pane) {
      return panes.get(pane)?.name ?? null;
    },
    seed(pane, shown, agent) {
      panes.set(pane, { text: shown, agent, name: null });
    },
  };
  let clock = NOW.getTime();
  let n = 0;
  const panes = new Map<string, { text: string; agent: boolean; name: string | null }>();
  const spaces = new Map<string, string>();
  state.launch = {
    sessionState: () => state.session,
    startServer() {
      state.session = 'running';
      return true;
    },
    sessionUp: () => state.session === 'running',
    createWorkspace(_session, _cwd, label) {
      n++;
      const pane = `synthetic-ws-${n}:p1`;
      panes.set(pane, { text, agent: false, name: null });
      spaces.set(`synthetic-ws-${n}`, label);
      return { pane, workspace: `synthetic-ws-${n}` };
    },
    paneRun(_session, pane, command) {
      state.runs.push({ pane, command });
      const known = panes.get(pane);
      if (known) known.agent = true;
      return true;
    },
    renameAgent(_session, pane, name) {
      const known = panes.get(pane);
      if (known) known.name = name;
      return true;
    },
    closeWorkspace(_session, workspace) {
      state.closes.push(workspace);
      return true;
    },
    agentPanes() {
      return [...panes].filter(([, pane]) => pane.agent).map(([id]) => id);
    },
    agents: () => [...panes].flatMap(([id, pane]) => (pane.name === null ? [] : [{
      name: pane.name,
      agent: 'claude-code',
      pane: id,
      workspace: id.replace(/:p1$/, ''),
      status: 'idle',
      cwd: null,
    }])),
    workspacePanes(_session, workspace) {
      const found = [...panes.keys()].filter((p) => p.startsWith(`${workspace}:`));
      return found.length > 0 ? found : [`${workspace}:p1`];
    },
    paneText(_session, pane) {
      return panes.get(pane)?.text ?? '';
    },
    foreground: () => ['claude', 'codex', 'agy', 'cursor-agent'],
    focus: () => true,
    deleteSession() {
      state.session = 'absent';
      return true;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    processStartOf: () => null,
    now: () => new Date(clock),
  };
  return state;
}

/** The names this world's own renames put on panes, as herdr's list would give them now. */
function liveNames(made: World): HerdrAgent[] {
  return (made.launch.agentPanes('acme-web') ?? []).flatMap((pane) => {
    const name = made.nameOn(pane);
    return name === null ? [] : [{
      name,
      agent: 'claude',
      pane,
      workspace: pane.split(':')[0] ?? pane,
      status: 'idle',
      cwd: null,
    }];
  });
}

function sources(extra: Partial<UpSources>, made: World): UpSources {
  return {
    sessionRunning: () => made.session === 'running',
    agents: () => [],
    // The recorded seats live in workspaces an earlier run made, so this test passes its own list.
    workspaces: () => made.workspaceList(),
    home,
    now: made.launch.now,
    sleep: made.launch.sleep,
    launch: made.launch,
    terminal: () => made.terminal,
    ...extra,
  };
}

describe('team up, restored seat with no registered channel root', () => {
  test('the fallback warns and logs once, drops the channel from the runtime line only, and keeps the stored recipe', async () => {
    writeFileSync(join(root, '.agents/team.yaml'), makeExample(base, root, EXAMPLE.replace('stopped: true\n', 'parked: true\n')));
    await approve();
    // Every seat was ready before the power went. The coordinator's pane runs no CLI; codex-acme's
    // recorded process is still in its pane; deepseek-acme's runs a stranger's CLI; and
    // deepseek-acme-2's pane is gone from herdr altogether — the live restore mix.
    writeFileSync(
      join(root, '.agents/team.state.json'),
      JSON.stringify({
        format: 1,
        sessions: {
          'acme-web': {
            seats: {
              'claude-coordinator-acme': { stage: 'ready', pane: 'synthetic-ws-91:p1', workspace: 'synthetic-ws-91', launched: { shell: 420, cli: [421] } },
              'codex-acme': { stage: 'ready', pane: 'synthetic-ws-92:p1', workspace: 'synthetic-ws-92', launched: { shell: 410, cli: [411] } },
              'deepseek-acme': { stage: 'ready', pane: 'synthetic-ws-93:p1', workspace: 'synthetic-ws-93', launched: { shell: 430, cli: [431] } },
              'deepseek-acme-2': { stage: 'ready', pane: 'synthetic-ws-94:p1', workspace: 'synthetic-ws-94', launched: { shell: 440, cli: [441] } },
            },
            worktrees: {},
          },
        },
      }),
    );
    const made = world();
    made.session = 'running';
    made.seed('synthetic-ws-91:p1', IDLE, true);
    // The bare restored CLI exits before the recorded line runs in the same pane.
    let restoredPhase: 'running' | 'shell' | 'relaunched' = 'running';
    made.seed('synthetic-ws-93:p1', IDLE, true);
    made.launch.processInfo = (_session, pane) => {
      if (pane === 'synthetic-ws-91:p1') return { shell: 420, foreground: [420] };
      if (pane === 'synthetic-ws-92:p1') return { shell: 410, foreground: [410, 411] };
      if (pane === 'synthetic-ws-93:p1') return { shell: 430, foreground: restoredPhase === 'shell' ? [430] : [restoredPhase === 'relaunched' ? 501 : 500] };
      if (pane === 'synthetic-ws-94:p1') return null;
      return { shell: 700, foreground: [700, 701] };
    };
    const agents = [
      agent('claude-coordinator-acme', 'synthetic-ws-91:p1', 'idle'),
      agent('codex-acme', 'synthetic-ws-92:p1', 'idle', 'codex'),
      agent('deepseek-acme', 'synthetic-ws-93:p1', 'idle'),
    ];
    made.launch.agents = () => [...new Map([...agents, ...liveNames(made)].map((entry) => [entry.pane, entry])).values()];
    const keys: string[] = [];
    const run = made.launch.paneRun.bind(made.launch);
    made.launch.paneRun = (session, pane, command) => { if (pane === 'synthetic-ws-93:p1') restoredPhase = 'relaunched'; return run(session, pane, command); };
    made.launch.typeText = (_session, pane, text) => { keys.push(`type ${pane} ${text}`); return true; };
    made.launch.pressEnter = (_session, pane) => { keys.push(`enter ${pane}`); if (pane === 'synthetic-ws-93:p1') restoredPhase = 'shell'; return true; };

    const io = testIo(root, { kind: 'owner' });
    const code = await runUp(
      FILE,
      io,
      sources(
        {
          sessionState: () => 'running',
          workspaces: () => [
            { id: 'synthetic-ws-91', label: 'claude-coordinator-acme · project coordinator' },
            { id: 'synthetic-ws-92', label: 'codex-acme · implementer' },
            { id: 'synthetic-ws-93', label: 'deepseek-acme · implementer' },
          ],
          agents: () => [
            agent('claude-coordinator-acme', 'synthetic-ws-91:p1', 'idle'),
            agent('codex-acme', 'synthetic-ws-92:p1', 'idle', 'codex'),
            agent('deepseek-acme', 'synthetic-ws-93:p1', 'idle'),
          ],
          doctor: doctor(),
        },
        made,
      ),
    );

    // The refusal never drops the seat: the repair ran to ready, and the restore notice the live
    // file pins is still the one printed.
    expect(code, io.out + io.err).toBe(0);
    expect(io.out).toContain('deepseek-acme: ready\n');
    expect(io.err).toContain('its pane held the bare restored CLI, not its launch line; exited in place and launched again in the same pane');
    expect(`${io.out}${io.err}`).not.toContain('deepseek-acme: left out');
    // Identity and no-close guards: the stranger CLI is exited in the seat's own pane, the
    // recorded line re-runs there, and no workspace is closed.
    expect(made.closes).toEqual([]);
    expect(keys).toEqual(['type synthetic-ws-93:p1 /exit', 'enter synthetic-ws-93:p1']);
    const relaunched = made.runs.find(({ pane }) => pane === 'synthetic-ws-93:p1');
    expect(relaunched).toBeDefined();
    expect(relaunched?.command).toContain('team-deepseek');
    expect(relaunched?.command).toMatch(/--session-id [0-9a-f-]{36}/);
    // The runtime command the pane took carries no channel flag.
    expect(relaunched?.command).not.toContain(FLAG);
    // The record keeps the pane and the successor process, and the stored recipe keeps the channel.
    const seats = readState(join(root, '.agents')).sessions['acme-web']?.seats ?? {};
    expect(seats['deepseek-acme']).toMatchObject({ stage: 'ready', pane: 'synthetic-ws-93:p1', workspace: 'synthetic-ws-93', launched: { shell: 430, cli: [501] } });
    expect(seats['deepseek-acme']?.launch_line).toContain(PAIR);
    // One warning to the terminal for this seat, one line to the log: 'deepseek-acme-2' launches
    // fresh in this world and may take its own once-only fallback, so the filter is the seat's
    // own 'deepseek-acme:' prefix, which that name does not contain.
    const said = `${io.out}${io.err}`;
    expect(said.split('\n').filter((line) => line.includes('deepseek-acme:') && line.includes('its channel was not prepared')).length).toBe(1);
    const log = readFileSync(join(root, '.agents/team.log'), 'utf8');
    expect(log.split('\n').filter((line) => line.includes('deepseek-acme:') && line.includes('its channel was not prepared')).length).toBe(1);
  });
});
