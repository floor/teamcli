// The automatic order pass after `team add` and `team restart`: a re-added or restarted
// seat lands at the sidebar's end, so once the command answers, the sidebar is put back in
// roster order on its own when nobody in the way is mid-turn. This module owns the whole
// decision — what the out-of-order tail is (the one computation `team order` itself uses),
// whether it is idle, and starting the pass — so add and restart each carry a single call
// at their ready exits.
//
// The pass is a real `team order` in its own detached process, never awaited: it re-reads
// the sidebar, re-checks who may order, refuses a seat that turned busy in the meantime,
// and logs its own outcome. When the tail cannot be shown idle, the caller prints one
// hint line naming the command instead. Under the sidebar policy's manage word off, this
// returns before the pane host is read at all: no pass, no hint.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentList, workspaceList, type HerdrAgent } from '../herdr.ts';
import { readState } from '../state.ts';

/**
 * Set in the spawned pass's environment. `team order` delegates its restarts in-process,
 * so a restarted seat's ready exit would queue a fresh pass per seat; the marker makes
 * the hook silent for the whole pass instead.
 */
export const AUTO_ORDER_MARKER = 'TEAM_AUTO_ORDER';

const HINT = 'the sidebar is out of roster order; run team order once its tail is idle';

/** The roster words the tail is computed from: the team file's own seats. */
export type SidebarTeam = {
  orchestrator?: string;
  seats: readonly { name: string; human?: boolean }[];
};

/** One session's recorded placements, as the state record holds them. */
export type SidebarRecorded = {
  seats: Record<string, { pane?: string; workspace?: string } | undefined>;
};

/** The sidebar as it stands, the roster it is aimed at, and the tail that would move. */
export type SidebarTail = {
  /** The full roster order: the orchestrator first, then the file's order. */
  roster: string[];
  inSidebar: string[];
  aimed: string[];
  /** The seats from the first divergence on, in roster order; empty when ordered. */
  tail: string[];
};

/**
 * The one tail computation, shared by `team order` and this hook: the roster is the
 * orchestrator's seat first, then the remaining declared seats in the file's order.
 * A human seat's pane is the owner's and never relaunched over; a seat with no recorded
 * workspace is not in the sidebar. A seat's workspace is its state's own record, or —
 * for a state that predates that field — the workspace of the agent on its recorded
 * pane. Never a guess.
 */
export function sidebarTail(
  team: SidebarTeam,
  recorded: SidebarRecorded | undefined,
  workspaces: readonly { id: string }[],
  agents: readonly HerdrAgent[],
): SidebarTail {
  const orchestrator = team.orchestrator;
  const orderable = team.seats.filter((seat) => seat.name !== orchestrator && seat.human !== true).map((seat) => seat.name);
  const roster = [orchestrator, ...orderable].filter((name): name is string => name !== undefined && name !== '');
  const workspaceOf = (name: string): string | undefined => {
    const held = recorded?.seats[name]?.workspace;
    if (held !== undefined) return held;
    const pane = recorded?.seats[name]?.pane;
    const agent = pane === undefined ? undefined : agents.find((one) => one.pane === pane);
    return agent?.workspace;
  };
  const seatOfWorkspace = new Map<string, string>();
  for (const name of roster) {
    const workspace = workspaceOf(name);
    if (workspace !== undefined) seatOfWorkspace.set(workspace, name);
  }
  const inSidebar = workspaces.flatMap((workspace) => {
    const name = seatOfWorkspace.get(workspace.id);
    return name === undefined ? [] : [name];
  });
  const aimed = roster.filter((name) => workspaceOf(name) !== undefined);
  const diverge = inSidebar.findIndex((name, index) => name !== aimed[index]);
  return { roster, inSidebar, aimed, tail: diverge === -1 ? [] : aimed.slice(diverge) };
}

/** What the hook needs from the command that just placed a seat. */
export type AutoOrderInput = {
  /** The team's root: the spawned pass's working directory. */
  root: string;
  /** The folder the state record is read from. */
  dir: string;
  team: SidebarTeam;
  session: string;
  /** The `--file` the placing command was given, forwarded so the pass reads the same file. */
  file?: string;
  /** The sidebar policy's manage word, resolved. Off: no pass, no hint, no host read. */
  manage: boolean;
};

/** What the hook reads and starts, so a test can stand in for the pane host and the spawn. */
export type AutoOrderSources = {
  workspaces(session: string): { id: string }[] | null;
  agents(session: string): HerdrAgent[] | null;
  state(dir: string): { sessions: Record<string, SidebarRecorded | undefined> };
  /** Starts the detached pass. Throws when the process could not be started. */
  spawnOrder(argv: string[], root: string): void;
  env(name: string): string | undefined;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realAutoOrderSources: AutoOrderSources = {
  workspaces(session) {
    const listed = workspaceList(aim(session));
    return listed === null ? null : listed.map((workspace) => ({ id: workspace.id }));
  },
  agents: (session) => agentList(aim(session)),
  state: (dir) => readState(dir) as { sessions: Record<string, SidebarRecorded | undefined> },
  spawnOrder(argv, root) {
    const here = fileURLToPath(import.meta.url);
    const entry = join(dirname(here), '..', here.endsWith('.ts') ? 'cli.ts' : 'cli.js');
    const child = spawn(process.execPath, [entry, ...argv], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [AUTO_ORDER_MARKER]: '1' },
    });
    child.unref();
  },
  env: (name) => process.env[name],
};

/**
 * Runs the pass when the tail is idle and returns the hint line to print when it is
 * not (or cannot be shown idle); returns null when there is nothing to say — the
 * sidebar already reads in order, managing is off, or this run is itself inside an
 * order pass. Never throws: the placing command's answer is already earned.
 */
export function maybeAutoOrder(input: AutoOrderInput, sources: AutoOrderSources = realAutoOrderSources): string | null {
  if (!input.manage) return null;
  if (sources.env(AUTO_ORDER_MARKER) !== undefined) return null;
  let recorded: SidebarRecorded | undefined;
  try {
    recorded = sources.state(input.dir).sessions[input.session];
  } catch {
    return HINT;
  }
  const workspaces = sources.workspaces(input.session);
  const agents = sources.agents(input.session);
  if (workspaces === null || agents === null) return HINT;
  const { tail } = sidebarTail(input.team, recorded, workspaces, agents);
  if (tail.length === 0) return null;
  // Idle is `team order`'s own pre-flight word: no seat of the tail working or blocked
  // at a prompt. What the host cannot say, the spawned pass refuses for itself.
  const busy = tail.some((name) => {
    const pane = recorded?.seats[name]?.pane;
    const agent = pane === undefined ? undefined : agents.find((one) => one.pane === pane);
    return agent?.status === 'working' || agent?.status === 'blocked';
  });
  if (busy) return HINT;
  try {
    sources.spawnOrder(
      ['order', '--session', input.session, ...(input.file !== undefined ? ['--file', input.file] : [])],
      input.root,
    );
  } catch {
    return HINT;
  }
  return null;
}
