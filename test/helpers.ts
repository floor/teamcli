import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Seen, StoredReading } from '../src/budgets/readings.ts';
import type { Caller } from '../src/caller.ts';
import { PROFILES } from '../src/clis.ts';
import { DAEMON_LABEL } from '../src/daemon/paths.ts';
import type { ServiceJobRecord, ServiceUnitRecord } from '../src/daemon/service.ts';
import type { Io } from '../src/io.ts';
import { currentBriefClaim, deliverBriefForAttribution } from '../src/launch/general-brief.ts';
import { rulesText } from '../src/launch/rules.ts';
import { readMessage } from '../src/mcp/inbox.ts';
import { readAgents } from '../src/registry/agents.ts';
import type { HerdrAgent } from '../src/herdr.ts';
import { forgetTeam, getTeam, teamIdOf, upsertTeam } from '../src/registry/teams.ts';
import { signedRecordOf, type SignedRecord } from '../src/send/record.ts';
import { emptySession, readState, updateState } from '../src/state.ts';

/** The service manager's record of a job that is this test process: the pid and program the
 *  daemon's start admission compares against. A fake manager answers with this when a scene
 *  needs the record admission to pass; a scene about a refusal changes one field. */
export function thisProcessJobRecord(): ServiceJobRecord {
  return { pid: process.pid, program: process.execPath };
}

/** The unit record a scene's fake manager answers with for this process: the daemon's own label,
 *  the test user as owner, a private unit, and this process's own launch words. */
export function thisProcessUnitRecord(path: string): ServiceUnitRecord {
  return {
    path,
    label: DAEMON_LABEL,
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : 0,
    mode: 0o600,
    programArguments: [process.execPath, ...process.argv.slice(1)],
  };
}

/** The signed record at `path`, parsed: a test that asserts the message's body asserts the
 *  record's payload, never the envelope's bytes. Throws when the file is not a record. */
export function recordAt(path: string): SignedRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const record = signedRecordOf(parsed);
  if (record === null) throw new Error(`not a message record: ${path}`);
  return record;
}

/** The body the record at `path` carries. */
export function recordBody(path: string): string {
  return recordAt(path).payload.body;
}

/** Names in a drop folder, without the unread hint. The hint is written beside a record on
 *  purpose and is not a message. `.pending` and `.fallback.json` stay, so a listing can still
 *  see those markers. */
export function withoutUnreadHint(names: readonly string[]): string[] {
  return names.filter((name) => name !== '.unread.json');
}

/** `readdir` of a drop folder with the unread hint removed. */
export function dropNames(dir: string): string[] {
  return withoutUnreadHint(readdirSync(dir));
}

/**
 * The launch's own general-brief delivery, for a fixture whose state records launched seats: one
 * claim in the session, one signed record in each seat's drop folder and the state's `briefs`
 * entry, exactly as `team up` leaves them before it types. Each CLI seat then reads its brief the
 * way its first turn's reader does, leaving the receipt bound to the claim, so the fixture stands
 * where a settled team stands. Throws when a delivery did not land, so a fixture never stands on
 * a half-made world.
 */
export function deliverBriefs(input: {
  dir: string;
  root: string;
  session: string;
  seats: readonly string[];
  home: string;
  at?: string;
  /** `false` leaves the drops unread: a launch that never reached the seat's first turn. */
  read?: false;
}): void {
  const report = deliverBriefForAttribution({
    dir: input.dir,
    root: input.root,
    session: input.session,
    home: input.home,
    now: input.at === undefined ? new Date() : new Date(input.at),
    team: { seats: input.seats.map((name) => ({ name })) },
    state: readState(input.dir).sessions[input.session] ?? emptySession(),
    attributed: input.seats,
  });
  const failed = report.deliveries.filter((delivery) => !delivery.ok);
  if (failed.length > 0 || report.recording !== undefined) {
    throw new Error(`the fixture's briefs were not delivered: ${JSON.stringify(report)}`);
  }
  for (const delivery of report.deliveries) {
    if (!delivery.ok || input.read === false) continue;
    const target = {
      dropDir: join(input.root, '.agents', 'send-drops', input.session, delivery.seat),
      root: input.root,
      seat: delivery.seat,
      session: input.session,
    };
    const claimOf = () => currentBriefClaim(readState(input.dir).sessions[input.session]?.briefs?.[delivery.seat]);
    const read = readMessage(target, delivery.id, input.home, { claim: claimOf });
    if (!read.ok) throw new Error(`the fixture's brief was not read: ${read.reason}`);
  }
}

/** The seven-rule message the Codex 0.160.0 and Cursor 2026.10.01 captures were typed with,
 *  as today's `rulesText` composes it: 18 lines and 1303 characters — one line past the
 *  captures, the end-of-turn drops read every seat without the inbox tools now carries. Only
 *  the first own-rule line differs from what the captures hold — the lead's name,
 *  `orchestrator` now — while the file's own rules keep the spelling those fixtures keep
 *  (17 lines, 1193 characters in the two fixture READMEs). Its shape is what `team` composes
 *  for a seat; no real seat or person
 *  is in it. */
export const SAMPLE_RULES = rulesText(
  {
    orchestrator: 'coordinator',
    rules: [
      'Do not use tools or edit files.',
      'Do not change trust or configuration.',
      'Reply only RULES_RECEIVED, then wait.',
      'Keep every change on a branch; never commit to main.',
      'Open one pull request per change; the coordinator merges it.',
      'Never force-push a shared branch.',
      "Run the project's test command before you push.",
    ],
    signature: {
      commit: 'Agent: Sample Model · implementer',
      pullRequest: '**Agent:** Sample Model · implementer',
      commitPosition: 'trailer',
    },
    workspace: { mode: 'worktree', protected: ['.'], branch: '{kind}/{task}' },
  },
  'message',
);

export type TestIo = Io & { out: string; err: string };

/** The captured Claude Code 2.1.289 idle screen (`test/fixtures/claude-code/2.1.289/idle-suggestion-plain.txt`). */
export const CLAUDE_IDLE = readFileSync(
  new URL('./fixtures/claude-code/2.1.289/idle-suggestion-plain.txt', import.meta.url),
  'utf8',
);

const CLAUDE_COMPOSER_LINES = (() => {
  const lines = CLAUDE_IDLE.split('\n');
  const open = lines.findIndex((line) => line.startsWith('─'));
  if (open < 0) throw new Error('the claude-code idle capture has no opening rule');
  return [lines[open]!, lines[open + 1]!, lines[open + 2]!, ...lines.slice(open + 4)];
})();

/** A Claude Code pane with `text` in its composer: the composer slice of the captured 2.1.289
 *  idle screen, with `text` on its prompt row and continuation rows at the two-column indent the
 *  profile describes, for tests that type text and read the box back. */
export function claudeBox(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const lines = CLAUDE_COMPOSER_LINES.slice();
  lines[1] = [`❯\u00a0${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  return lines.join('\n');
}

/** A launch wrapper's pane: the welcome box's measured two lines (`test/fixtures/banner/`), its
 *  model line the provider's id, above a plain composer. A banner line anywhere else on the pane
 *  is not the surface the reader reads. */
export function wrapperPane(id: string): string {
  return `\n ▐▛███▛█   Claude Code v2.1.291\n▝▜██████▀  ${id} · API Usage Billing\n ▝▝   ▝▝   /w/acme\n`;
}

export type AgyRuleShape = 'close-short' | 'close-long' | 'open-short';

/** The captured Antigravity idle frame with one of its two rules redrawn at another width: the
 *  closing rule one column shorter (52) or longer (54) than the opening, or the opening shortened
 *  instead. The captures draw the box's two rules at one width — 53 columns in idle.txt, 54 in
 *  folded-rules.txt — so a window whose rules differ is not that frame, and the read must fail
 *  closed on it. `text`, when given, sits in the box as the captured continuation rows draw it
 *  (the first line after the prompt, later lines at the content column). */
export function agyMismatchedFrame(shape: AgyRuleShape, text?: string): string {
  const lines = readFileSync(new URL('./fixtures/antigravity/1.2.16/idle.txt', import.meta.url), 'utf8').split('\n');
  const prompt = lines.indexOf('>');
  if (prompt < 0) throw new Error('the idle capture has no bare prompt');
  lines[prompt - 1] = shape === 'open-short' ? '─'.repeat(52) : '─'.repeat(53);
  lines[prompt + 1] = shape === 'close-short' ? '─'.repeat(52) : shape === 'close-long' ? '─'.repeat(54) : '─'.repeat(53);
  if (text !== undefined) {
    const [first = '', ...rest] = text.split('\n');
    lines[prompt] = [`> ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  }
  return lines.join('\n');
}

/** The `herdr 0.7.1` `workspace list` entry, captured in a scratch session: every field the
 *  real envelope carries, with the ids per scene. The stripped-down stand-in carried two of
 *  these; a reader that leaned on a field the capture has and the stand-in did not would pass
 *  here and fail against a real herdr. */
export function capturedWorkspaceEntry(workspaceId: string, label: string) {
  return {
    active_tab_id: `${workspaceId}:t1`,
    agent_status: 'unknown',
    focused: true,
    label,
    number: 1,
    pane_count: 1,
    tab_count: 1,
    workspace_id: workspaceId,
  };
}

/** The runtime temp folder, the one these captured entries name: the capture's own temp folder is
 *  not part of any contract a scene reads, so the fixture takes this machine's. */
const TEMP = realpathSync(tmpdir());

/** The short base for a fixture that binds a unix socket: the POSIX temp folder `/tmp` when it
 *  exists (4 bytes on Linux, 12 on macOS as the real path), else the runtime temp folder. A unix
 *  socket path has a 100-byte limit, so a socket fixture must not sit under a deep temp folder;
 *  every other fixture keeps the runtime temp folder. */
export function shortSocketBase(): string {
  try {
    return realpathSync('/tmp');
  } catch {
    return realpathSync(tmpdir());
  }
}

/** The `herdr 0.7.1` `pane list` entry, as captured. */
export function capturedPaneEntry(paneId: string, workspaceId: string, terminalId = 'term_65dd8274742df1') {
  return {
    agent_status: 'unknown',
    cwd: TEMP,
    focused: true,
    foreground_cwd: TEMP,
    pane_id: paneId,
    revision: 0,
    tab_id: `${workspaceId}:t1`,
    terminal_id: terminalId,
    workspace_id: workspaceId,
  };
}

/** The `herdr 0.7.1` `pane process-info` result, as captured: the shell the pane runs, and the
 *  foreground process under it — which a scene sets apart from `shellPid` when it means to say
 *  the pane is running something. */
export function capturedProcessInfo(paneId: string, shellPid: number, foregroundPid = shellPid) {
  return {
    foreground_process_group_id: shellPid,
    foreground_processes: [
      { argv: ['-zsh'], argv0: 'zsh', cmdline: '-zsh', cwd: TEMP, name: 'zsh', pid: foregroundPid },
    ],
    pane_id: paneId,
    shell_pid: shellPid,
  };
}

/** Greedy word wrap at a content width: as many words as fit on one row, the rest on the next —
 *  how a pane breaks a line wider than its text column. The captured Cursor frame is this wrap of
 *  its sentence at the pane's content width. */
export function wordWrap(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let row = '';
    for (const word of line.split(' ')) {
      if (row === '') row = word;
      else if (row.length + 1 + word.length <= width) row += ` ${word}`;
      else { rows.push(row); row = word; }
    }
    rows.push(row);
  }
  return rows;
}

/** § 5's point on a reading in memory: the figure seven points higher, half an hour before the
 *  reading it belongs to moved — `93` where the figure is 100, so the point always stands
 *  distinct from the figure beside it. */
export function withWas(seen: Seen): Seen {
  const left = seen.left === 100 ? 93 : Math.min(100, seen.left + 7);
  return { ...seen, was: { left, at: seen.changedAt - 30 * 60_000 } };
}

/** The same point the way a state file holds it: the reading of § 5's shape, its `at` an ISO
 *  string, as `store` writes it. */
function storedWithWas(reading: StoredReading): StoredReading {
  const left = reading.left === 100 ? 93 : Math.min(100, reading.left + 7);
  return { ...reading, was: { left, at: new Date(Date.parse(reading.changedAt) - 30 * 60_000).toISOString() } };
}

/** § 5's state-file injector: every reading the state holds gains a valid point, through the
 *  state's own door. Returns how many records it touched, so a scenario whose output must not
 *  move can assert the injection actually happened rather than passing over an empty cache. */
export function injectWas(dir: string): number {
  let touched = 0;
  updateState(dir, (state) => {
    const budgets = state.budgets ?? {};
    for (const [key, reading] of Object.entries(budgets)) {
      budgets[key] = storedWithWas(reading);
      touched += 1;
    }
    state.budgets = budgets;
  });
  return touched;
}

export function testIo(cwd: string, caller?: Caller): TestIo {
  const io: TestIo = {
    out: '',
    err: '',
    stdout(text) { io.out += text; },
    stderr(text) { io.err += text; },
    cwd,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    ...(caller ? { caller } : {}),
  };
  return io;
}

/** The notes in a check's output other than the one a live seat with no socket anywhere draws:
 *  that seat is named once, by its delivery class, on every pass. A scene whose subject is a
 *  different note reads this list rather than the whole output. */
export function notesOtherThanSocket(out: string): string[] {
  return out
    .split('\n')
    .filter((line) => line.startsWith('note: ') && !line.includes('no cross-session socket is live'));
}

/** The live read a fake herdr host answers with: every running registry record placed in the
 *  session, its seat as herdr names it, its recorded pane, and the CLI herdr would report there —
 *  the profile's first process name (`claude` for `claude-code`), with a version prefix's `*`
 *  cut off. A scene about a seat herdr does not name, or names elsewhere, passes its own read. */
export function liveAgentsOf(home: string, session: string): { name: string; pane: string; cli: string }[] {
  return readAgents(home).flatMap((agent) => {
    const pane = agent.reach.pane;
    if (agent.lifecycle !== 'running' || agent.reach.session !== session || pane === null || pane === '') return [];
    const profile = PROFILES.find((one) => one.cli === agent.cli);
    const cli = profile?.processes[0] ?? agent.cli;
    return [{ name: agent.reach.seat, pane, cli: cli.replace(/\*$/, '') }];
  });
}

/** The environment for a git command run in a fixture repository: the identity a session
 *  exports is dropped, because git reads GIT_AUTHOR_* and GIT_COMMITTER_* before `-c user.*`
 *  and before the repository's own config — a session that exports them silently overrides
 *  every fixture's identity, and a commit the fixture meant to be signed or exempt is not. */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
    'EMAIL',
  ]) {
    delete env[name];
  }
  return env;
}

/**
 * A world's base folder, under a scratch root outside the OS temp directory and outside the
 * checkout. A client key refuses to sit under the temp folder, so a fixture whose synthetic HOME
 * holds one cannot live in temp — and a checkout may itself sit under temp, so neither can the
 * fixture be placed beside the checkout by assumption. The root is `TEAMCLI_TEST_SCRATCH` when it
 * names one, else `<home>/.cache/teamcli-tests`; a root the placement rule would refuse is an
 * error, never silently used. Callers create what they need under the returned folder and remove
 * it themselves.
 */
export function fixtureBase(prefix: string): string {
  const checkout = resolve(import.meta.dir, '..');
  const named = process.env.TEAMCLI_TEST_SCRATCH;
  const root = resolve(named !== undefined && named !== '' ? named : join(homedir(), '.cache', 'teamcli-tests'));
  mkdirSync(root, { recursive: true });
  const real = realpathSync(root);
  const temp = realpathSync(tmpdir());
  if (real === temp || real.startsWith(temp + sep)) {
    throw new Error(`the fixture scratch root "${real}" overlaps the OS temp directory; name a root outside it with TEAMCLI_TEST_SCRATCH`);
  }
  if (real === checkout || real.startsWith(checkout + sep)) {
    throw new Error(`the fixture scratch root "${real}" is inside the checkout; name a root outside it with TEAMCLI_TEST_SCRATCH`);
  }
  return realpathSync(mkdtempSync(join(real, prefix)));
}

/** Run `write` while the fixture's team is registered, so an address policy can name it.
 *  A record this call creates is removed again: a scene that proves an empty registry still
 *  sees one, and a record already there is left as it was. */
export function duringAddressWrite(
  home: string,
  root: string,
  project: string,
  entity: string | null,
  at: Date,
  write: () => void,
): void {
  const id = teamIdOf(root);
  const prior = getTeam(home, id);
  if (prior === null) {
    upsertTeam(home, id, { project, entity, session: project, root, roster: [], at: at.toISOString() });
  }
  try {
    write();
  } finally {
    if (prior === null) forgetTeam(home, id);
  }
}

type RenameHost = {
  renameAgent(session: string, pane: string, name: string): boolean;
  agents?(session: string): HerdrAgent[] | null;
  agentList?(session: string): HerdrAgent[] | null;
};

/** Makes a fake launch's agent list reflect the renames it accepts. The naming step reads the
 *  list back after `renameAgent`; a fake that records the call without listing the name leaves
 *  the seat at launched with "its name was not listed after the rename". A pane already listed
 *  takes the renamed name; a pane the list never held is added. The object is patched in place
 *  so a literal keeps the contextual type of its assignment. */
export function recordRenames<T extends RenameHost>(host: T): T {
  const renamed = new Map<string, string>();
  const original = host.renameAgent;
  host.renameAgent = function (session: string, pane: string, name: string): boolean {
    const accepted = original.call(host, session, pane, name);
    if (accepted) renamed.set(pane, name);
    return accepted;
  };
  const merged = (read: (session: string) => HerdrAgent[] | null) => (session: string): HerdrAgent[] | null => {
    const list = read(session);
    if (list === null) return null;
    const listed = new Set(list.map((agent) => agent.pane));
    const named = list.map((agent) => {
      const name = renamed.get(agent.pane);
      return name === undefined ? agent : { ...agent, name };
    });
    const added = [...renamed]
      .filter(([pane]) => !listed.has(pane))
      .map(([pane, name]) => ({
        name,
        agent: null,
        pane,
        workspace: pane.includes(':') ? pane.slice(0, pane.indexOf(':')) : pane,
        status: 'idle',
        cwd: null,
      }));
    return [...named, ...added];
  };
  if (host.agents !== undefined) host.agents = merged(host.agents);
  if (host.agentList !== undefined) host.agentList = merged(host.agentList);
  return host;
}
