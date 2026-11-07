// The watchdog's look at one root, off the daemon loop. The host is the chores child's
// own: a test passes a fake, and the live child passes the terminal-host readers. A restart
// is `team restart <seat> --json` in the root, as its own process. The lead hears the
// ordinary send. This step never asks for a checkpoint.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoresChildConfig, ChoresChildRoute } from '../daemon/chores/protocol.ts';
import {
  agentListAsync,
  foregroundArgv0,
  isHerdrAgentStatus,
  paneProcessInfoAsync,
  paneProcessesOf,
  paneReadAsync,
} from '../herdr.ts';
import { profileFor } from '../profiles/profile.ts';
import { withResume } from '../profiles/profile.ts';
import { recordedSeatSession } from '../registry/resume.ts';
import { readState } from '../state.ts';
import { reconcileStatusWithScreen } from '../watch/status-events.ts';
import { readScreen } from '../watch/screen.ts';
import { readPolicyChain } from '../policy/sources.ts';
import { resolvePolicy } from '../policy/resolve.ts';
import type { Policy } from '../policy/types.ts';
import type { PolicyChainSources } from '../policy/resolve.ts';
import { WATCHDOG_AFTER_MS, WATCHDOG_AUTO_RESTART } from './proof.ts';
import type { SeatHealthPorts } from '../daemon/chores/child.ts';
import type { WatchdogSeat } from './pass.ts';
import type { ProcessRow } from './proof.ts';
import { readRestartReady, type RestartReady } from './restart.ts';

const READ = { timeoutMs: 10_000 };

export type SeatHealthHost = {
  agents(session: string): Promise<readonly { name: string | null; pane: string; status: string }[] | null>;
  text(session: string, pane: string): Promise<string | null>;
  processes(session: string, pane: string): Promise<unknown | null>;
};

export type HealthSeat = {
  name: string;
  cli: string;
  launch: string;
  human?: true;
  stopped?: boolean;
};

export type HealthRoute = {
  home: string;
  root: string;
  session: string;
  stateDir?: string;
  seats: readonly HealthSeat[];
};

/** The process list the proof reads. Null when the host cannot name it. */
export function processRows(raw: unknown, cliNames: readonly string[]): ProcessRow[] | null {
  const info = paneProcessesOf(raw);
  const names = foregroundArgv0(raw);
  if (info === null || names === null || names.length !== info.foreground.length) return null;
  return info.foreground.map((pid, index) => {
    const argv0 = names[index] ?? '';
    const base = argv0.includes('/') ? argv0.slice(argv0.lastIndexOf('/') + 1) : argv0;
    const cli = cliNames.some((name) => name === argv0 || name === base);
    return { pid, argv0, shell: pid === info.shell, cli };
  });
}

export async function observeRoute(route: HealthRoute, host: SeatHealthHost): Promise<WatchdogSeat[]> {
  const agents = await host.agents(route.session);
  const seats: WatchdogSeat[] = [];
  for (const seat of route.seats) {
    if (seat.human === true || seat.stopped) continue;
    const agent = agents?.find((one) => one.name === seat.name) ?? null;
    const text = agent === null ? null : await host.text(route.session, agent.pane);
    const rawProcesses = agent === null ? null : await host.processes(route.session, agent.pane);
    const names = profileFor(seat.cli)?.processNames ?? [];
    const hostStatus = agent !== null && isHerdrAgentStatus(agent.status) ? agent.status : 'unknown';
    const reconciled = text === null
      ? hostStatus
      : reconcileStatusWithScreen(seat.cli, hostStatus, text);
    const screenKind = text === null ? null : readScreen(seat.cli, text).kind;
    const presenceAt = presenceOf(route, seat.name);
    const session = sessionOf(route, seat);
    const resume = session.kind === 'bound' ? withResume(seat.cli, seat.launch, session.id) : null;
    seats.push({
      seat: seat.name,
      cli: seat.cli,
      reconciled,
      hostStatus,
      plain: text,
      screenKind,
      presenceAt,
      processes: rawProcesses === null ? null : processRows(rawProcesses, names),
      session: session.kind === 'bound' ? { kind: 'bound' } : session,
      resume,
    });
  }
  return seats;
}

function presenceOf(route: HealthRoute, seat: string): string | null {
  try {
    const state = readState(route.stateDir ?? route.root);
    const at = state.sessions[route.session]?.seats[seat]?.last_active;
    return typeof at === 'string' ? at : null;
  } catch {
    return null;
  }
}

function sessionOf(route: HealthRoute, seat: HealthSeat): { kind: 'bound'; id: string } | { kind: 'none' | 'refused'; why: string } {
  try {
    const state = readState(route.stateDir ?? route.root);
    const row = state.sessions[route.session]?.seats[seat.name];
    const read = recordedSeatSession({
      home: route.home,
      root: route.root,
      herdrSession: route.session,
      seat: { name: seat.name, cli: seat.cli },
      state: row === undefined ? undefined : { id: row.id, agent_session: row.agent_session },
    });
    if (read.kind === 'bound') return { kind: 'bound', id: read.recorded.sessionId };
    return read;
  } catch {
    return { kind: 'none', why: 'the seat state could not be read' };
  }
}

function healthRoute(route: ChoresChildRoute, home: string): HealthRoute {
  return {
    home,
    root: route.root,
    session: route.session,
    ...(route.stateDir === undefined ? {} : { stateDir: route.stateDir }),
    seats: (route.teamFile?.seats ?? []).map((seat) => ({
      name: seat.name,
      cli: seat.cli,
      launch: seat.launch,
      ...(seat.human === true ? { human: true as const } : {}),
      stopped: seat.stopped,
    })),
  };
}

function chainDeclarations(sources: PolicyChainSources): Policy[] | null {
  const all: Policy[] = [];
  for (const source of Object.values(sources)) {
    if (source === undefined || !source.ok) return null;
    all.push(...source.policies);
  }
  return all;
}

function runTeam(cwd: string, args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('team', [...args], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.unref();
    const out: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => {
      out.push(chunk);
    });
    child.on('error', () => resolve({ code: null, stdout: '' }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8') }));
  });
}

/** The ports the chores child uses when the token asks for the watchdog. */
export function liveSeatHealth(config: ChoresChildConfig): SeatHealthPorts {
  const host: SeatHealthHost = {
    agents: async (session) => {
      const listed = await agentListAsync(session, READ);
      if (listed === null) return null;
      return listed.map((agent) => ({ name: agent.name, pane: agent.pane, status: agent.status }));
    },
    text: (session, pane) => paneReadAsync(pane, 40, session, READ),
    processes: (session, pane) => paneProcessInfoAsync(pane, session, READ),
  };
  return {
    seats: (route) => observeRoute(healthRoute(route, config.home), host),
    limits(route) {
      try {
        const chain = readPolicyChain({ home: config.home, teamRoot: route.root, team: route.teamFile });
        const declarations = chainDeclarations(chain);
        if (declarations === null) return { afterMs: WATCHDOG_AFTER_MS, autoRestart: WATCHDOG_AUTO_RESTART };
        const after = resolvePolicy('seat-health.watchdog.after', declarations);
        const auto = resolvePolicy('seat-health.watchdog.auto-restart', declarations);
        if (!after.ok || !auto.ok || typeof after.effective.value !== 'number' || typeof auto.effective.value !== 'number') {
          return { afterMs: WATCHDOG_AFTER_MS, autoRestart: WATCHDOG_AUTO_RESTART };
        }
        return { afterMs: after.effective.value * 1000, autoRestart: auto.effective.value };
      } catch {
        return { afterMs: WATCHDOG_AFTER_MS, autoRestart: WATCHDOG_AUTO_RESTART };
      }
    },
    async restart(route, _seat, args) {
      const run = await runTeam(route.root, args);
      const ready = readRestartReady(run.stdout);
      if (run.code === 0 && ready !== null) return ready;
      return { kind: 'failed' };
    },
    lead(route, text) {
      const lead = route.teamFile?.orchestrator;
      if (lead === undefined) return;
      const dir = mkdtempSync(join(tmpdir(), 'seat-health-'));
      const path = join(dir, 'lead.txt');
      writeFileSync(path, text, { mode: 0o600 });
      void runTeam(route.root, ['send', lead, '--file', path]);
    },
  };
}

export type { RestartReady };
