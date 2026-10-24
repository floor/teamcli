// `team daemon`: the one machine-wide TeamCLI daemon. `run` is the foreground process the
// system service manager starts (it hosts the existing send and bus servers in this one process
// and serves the machine socket); `run --presence` additionally hosts the presence pipeline, and
// `run --watch` hosts one watch per checkout on the same heartbeat; without a flag the daemon
// hosts neither. `install` and `uninstall` write and register the user service unit through a
// neutral interface, with the platform's own file and command only inside the adapter. `status`
// is the one-line health reading every other command and person reads. `fault-watch` asks a
// running daemon to inject one diagnostic fault into exactly one hosted watch: one request,
// one route id, no process killed.
//
// The machine daemon holds no credential and reads no credential store. The broker feature is
// not hosted in this build, and the catalogue's `daemon.broker` policy is off by default, so a
// machine with no broker handler never falls back to the old per-clone broker.
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import {
  FAULT_POLL_MS,
  FAULT_WAIT_MS,
  FAULT_WHY,
  readFaultResult,
  writeFaultRequest,
} from '../daemon/fault.ts';
import { daemonHealth } from '../daemon/health.ts';
import { appendDaemonLog, startMachineDaemon, type MachineRootStatus, type StartMachineDaemonResult } from '../daemon/host.ts';
import { currentCodexEndpoint } from '../daemon/presence/endpoint-state.ts';
import { routeId, routeOf } from '../daemon/routes.ts';
import { systemServiceManager, type ServiceManager, type ServiceProgram } from '../daemon/service.ts';
import type { DaemonHost } from '../send/daemon.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { refuse, writeJson, writeJsonError } from '../output/index.ts';
import { version as installedVersion } from '../version.ts';

export const USAGE = `Usage: team daemon status [--json]
       team daemon run [--root <folder>] [--started-by <source>] [--presence] [--watch]
       team daemon install [--root <folder>] [--presence] [--watch] [--dry-run] [--json]
       team daemon uninstall [--json]
       team daemon fault-watch --root <folder> --route <routeId> [--dry-run] [--json]

One machine-wide daemon serves every team and clone on this machine. It answers its own
protocol on the one machine socket, and for now it also hosts each checkout's existing send
and bus endpoints in the same process, so no second or third daemon process runs. Repeat
\`--root\` to host more than one checkout.
\`run --presence\` additionally hosts each checkout's presence pipeline: the spool ingester, the
activity reconciler, the publisher and the per-seat health answer. Without the flag the daemon
does not read presence at all.
\`run --watch\` additionally hosts one watch per checkout on the daemon's existing heartbeat.
Without the flag no checkout's watch is hosted, and the daemon reads no pane for one.
\`install\` writes and registers a user service unit that starts the daemon at login and restarts
it after a failure; \`uninstall\` removes it. \`status\` prints one line: running, not running, or
unknown.
\`fault-watch\` asks the running daemon to inject one diagnostic fault into exactly one hosted
watch, named by the route id its record already carries. One request is written, the daemon
consumes it on its next heartbeat, and only that route's loop is ended and restarted; no
process is killed. A route that is not hosted, not required, standing down or stopped is
refused, and the result names why.

The daemon reads no credential store; the broker feature is not hosted in this build.

Exits 0 when the command did what it was asked, 1 when it refused or the service manager
refused, 2 when the invocation or a named root can't be read.
`;

// The option lists the command contract reads. `--root` is parsed by hand as well because it is
// repeatable, which `readArgs` does not model.

export type DaemonCommandSources = {
  /** Injected for tests: a synthetic user home. */
  home?: string;
  /** Injected for tests: the neutral service manager, never the live adapter. */
  service?: ServiceManager | null;
  /** Injected for tests: the daemon start. */
  start?: (input: Parameters<typeof startMachineDaemon>[0]) => Promise<StartMachineDaemonResult>;
  /** Injected for tests: the stop seam, as `broker` and `bus` take one. */
  stop?: (end: () => void) => () => void;
  /** Injected for tests: the program the service manager will run; `null` means it can't be found. */
  program?: { execPath: string; entry: string } | null;
  now?: () => Date;
  version?: string;
  heartbeatMs?: number;
  /** Injected for tests: never the real pane/herdr sources. */
  sendHost?: DaemonHost;
  /** Injected for tests: how long `fault-watch` waits for the daemon's result. */
  faultWaitMs?: number;
  /** Injected for tests: the interval between result reads. */
  faultPollMs?: number;
  /** Injected for tests: the wait between result reads, so a scene never sleeps for real. */
  sleep?: (ms: number) => Promise<void>;
};

export const daemon: Command = (argv, io) => runDaemon(argv, io);
export default daemon;

type Parsed = {
  verb: string | undefined;
  known: boolean;
  roots: string[];
  route: string | undefined;
  json: boolean;
  dryRun: boolean;
  presence: boolean;
  watch: boolean;
  startedBy: string | undefined;
  extra: string | undefined;
  error: string | null;
};

function parse(argv: string[]): Parsed {
  const args = readArgs(argv, ['root', 'started-by', 'route'], ['json', 'dry-run', 'presence', 'watch']);
  const verb = args.rest[0];
  // The command contract reads these comparisons as the subcommand list. The parse itself
  // uses `known`; the flags and values come from `readArgs`.
  const isStatus = verb === 'status';
  const isRun = verb === 'run';
  const isInstall = verb === 'install';
  const isUninstall = verb === 'uninstall';
  const isFaultWatch = verb === 'fault-watch';
  const known = isStatus || isRun || isInstall || isUninstall || isFaultWatch;
  // `--root` is repeatable; `readArgs` keeps one value per option, so a second pass collects
  // every occurrence for the daemon to host.
  const roots: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === '--root') {
      const value = argv[index + 1];
      if (value !== undefined && value !== '' && !value.startsWith('--')) {
        roots.push(value);
        index += 1;
      }
    } else if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length);
      if (value !== '') roots.push(value);
    }
  }
  return {
    verb,
    known,
    roots,
    route: args.values['route'],
    json: args.flags.has('json'),
    dryRun: args.flags.has('dry-run'),
    presence: args.flags.has('presence'),
    watch: args.flags.has('watch'),
    startedBy: args.values['started-by'],
    extra: args.rest[1],
    error: args.error ?? null,
  };
}

function verbProblem(parsed: Parsed): string | null {
  if (parsed.error !== null) return parsed.error;
  if (parsed.verb === undefined) return 'a subcommand is required (status, run, install, uninstall or fault-watch)';
  if (!parsed.known) return `unknown subcommand "${parsed.verb}"`;
  if (parsed.extra !== undefined) return `unexpected "${parsed.extra}"`;
  if (parsed.verb === 'run' && parsed.json) return '--json belongs to status, install, uninstall or fault-watch';
  if (parsed.verb === 'run' && parsed.dryRun) return '--dry-run belongs to install or fault-watch';
  if (parsed.verb === 'run' && parsed.route !== undefined) return '--route belongs to fault-watch';
  if (parsed.verb !== 'run' && parsed.verb !== 'install' && parsed.presence) return '--presence belongs to run or install';
  if (parsed.verb !== 'run' && parsed.verb !== 'install' && parsed.watch) return '--watch belongs to run or install';
  if (parsed.verb === 'fault-watch' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (parsed.verb === 'fault-watch') {
    if (parsed.roots.length === 0) return 'fault-watch needs --root <folder>';
    if (parsed.roots.length > 1) return 'fault-watch names exactly one checkout with --root';
    if (parsed.route === undefined || parsed.route === '') return 'fault-watch needs --route <routeId>';
  }
  if (parsed.verb !== 'fault-watch' && parsed.route !== undefined) return '--route belongs to fault-watch';
  if (parsed.verb === 'status' && parsed.dryRun) return '--dry-run belongs to install or fault-watch';
  if (parsed.verb === 'status' && parsed.roots.length > 0) return '--root belongs to run or install';
  if (parsed.verb === 'status' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (parsed.verb === 'install' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (parsed.verb === 'uninstall' && parsed.dryRun) return '--dry-run belongs to install or fault-watch';
  if (parsed.verb === 'uninstall' && parsed.roots.length > 0) return '--root belongs to run or install';
  if (parsed.verb === 'uninstall' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (
    parsed.verb === 'run' &&
    parsed.startedBy !== undefined &&
    parsed.startedBy !== 'service-manager' &&
    parsed.startedBy !== 'manual' &&
    parsed.startedBy !== 'team-up'
  ) {
    return '--started-by takes service-manager, manual or team-up';
  }
  return null;
}

function rootsOf(parsed: Parsed, io: Io, home: string): { roots: string[] } | { problem: string } {
  if (parsed.roots.length > 0) {
    const roots: string[] = [];
    for (const named of parsed.roots) {
      const root = resolve(io.cwd, named);
      const loaded = readTeamConfig(root, { home });
      if (!loaded.ok) {
        return { problem: `${root}: ${loaded.errors[0]?.message ?? 'the team file cannot be read'}` };
      }
      if (!roots.includes(loaded.root)) roots.push(loaded.root);
    }
    return { roots };
  }
  const loaded = readTeamConfig(io.cwd, { home });
  if (!loaded.ok) {
    return { problem: 'run team from a project, or name a checkout with --root' };
  }
  return { roots: [loaded.root] };
}

function localProgram(sources: DaemonCommandSources): { execPath: string; entry: string } | null {
  if (sources.program !== undefined) return sources.program;
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return null;
  try {
    return { execPath: process.execPath, entry: realpathSync(entry) };
  } catch {
    return { execPath: process.execPath, entry: resolve(entry) };
  }
}

function ownerAllows(io: Io, sources: DaemonCommandSources, json: boolean): boolean {
  const caller = callerOf(io);
  if (isOwner(caller)) return true;
  const message = `only the owner installs or removes the machine daemon; this call is ${describeCaller(caller)}`;
  const lift = devModeOwnerLiftAtCwd(io, {
    command: 'daemon',
    refusal: message,
    ...(sources.home !== undefined ? { home: sources.home } : {}),
    ...(sources.now !== undefined ? { now: sources.now() } : {}),
  });
  if (lift !== null && lift.lifted) {
    io.stderr(`${lift.warning}\n`);
    return true;
  }
  refuse(io, json, 'daemon', { id: 'daemon.not-owner', message, repair: null, rule: 'owner-only' });
  return false;
}

function runAllowed(io: Io, startedBy: string, json: boolean): boolean {
  const caller = callerOf(io);
  if (isOwner(caller)) return true;
  // The service unit starts the daemon with no terminal, as the owner's own user. That is the
  // one no-terminal start admitted; a seat or a pane never starts the machine daemon.
  if (caller.kind === 'owner-no-tty' && startedBy === 'service-manager') return true;
  const message = `only the owner or the system service manager runs the machine daemon; this call is ${describeCaller(caller)}`;
  refuse(io, json, 'daemon', { id: 'daemon.run-not-owner', message, repair: null, rule: 'owner-only' });
  return false;
}

function processStop(end: () => void): () => void {
  const onSignal = (): void => end();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
}

/** The hosted-endpoint summary the run line and status both print, so a daemon that is running
 *  while a checkout's endpoint did not start here never reads as full health. */
function rootsSummary(roots: MachineRootStatus[]): string[] {
  const sendServing = roots.filter((root) => root.send === 'serving').length;
  const busServing = roots.filter((root) => root.bus === 'serving').length;
  const notHosted = roots.reduce(
    (count, root) => count + (root.send === 'serving' ? 0 : 1) + (root.bus === 'serving' ? 0 : 1),
    0,
  );
  const parts = [`roots ${String(roots.length)} (send ${String(sendServing)}, bus ${String(busServing)})`];
  if (notHosted > 0) {
    parts.push(`${String(notHosted)} endpoint${notHosted === 1 ? '' : 's'} not hosted here`);
  }
  return parts;
}

/**
 * `fault-watch`: one owner-admitted request for one diagnostic fault on one hosted route.
 *
 * Admission is the install/uninstall gate — the owner, or the dev-mode orchestrator the same
 * proof admits — never the stricter foreground `run` gate, because the daemon already runs and
 * this command only asks it to end one loop it owns. Everything after admission is a proof
 * rather than a claim: the named checkout's own team file yields the route id, the running
 * daemon's record must carry that exact id with a required watch, and the request repeats the
 * resolved home plus the daemon run it was written for. The daemon refuses any request it
 * cannot match exactly; this side never writes to a process.
 */
async function faultWatch(
  parsed: Parsed,
  io: Io,
  sources: DaemonCommandSources,
  home: string,
): Promise<number> {
  const routeArg = parsed.route as string;
  if (!/^[0-9a-f]{32}$/.test(routeArg)) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.fault-usage',
      message: '--route takes the 32-character route id a hosted watch records',
      repair: null,
      usage: USAGE,
    });
    // exit: daemon.fault-usage
    return 2;
  }
  // Exactly one checkout is named (verbProblem), so this is the only read that can fail here.
  const root = resolve(io.cwd, parsed.roots[0] as string);
  const loaded = readTeamConfig(root, { home });
  if (!loaded.ok) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.fault-root',
      message: `${root}: ${loaded.errors[0]?.message ?? 'the team file cannot be read'}`,
      repair: null,
    });
    // exit: daemon.fault-root
    return 2;
  }
  const route = routeOf(loaded.root, loaded.team.project, loaded.team.session, loaded.team.seats.map((seat) => seat.name));
  const expected = routeId(route);
  if (routeArg !== expected) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.fault-route',
      message: `--route does not name this checkout's hosted route; it records ${expected}`,
      repair: null,
    });
    // exit: daemon.fault-route
    return 1;
  }

  const health = await daemonHealth(home, {
    ...(sources.now !== undefined ? { now: sources.now } : {}),
  });
  if (health.state !== 'running' || health.pid === null || health.since === null) {
    const message = health.state === 'running'
      ? 'the daemon record names no running process to ask'
      : 'the machine daemon is not running; a fault can only be asked of a running daemon';
    refuse(io, parsed.json, 'daemon', { id: 'daemon.fault-daemon', message, repair: null });
    // exit: daemon.fault-daemon
    return 1;
  }
  const served = health.roots.find((entry) => entry.watch?.routeId === expected);
  const watch = served?.watch;
  if (watch === undefined) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.fault-watch',
      message: 'this checkout has no hosted watch in the daemon record; start the daemon with watch hosting, or name the checkout it hosts',
      repair: null,
    });
    // exit: daemon.fault-watch
    return 1;
  }
  const unwatchable =
    !watch.required
      ? 'this route was not started with a hosted watch'
      : watch.phase === 'standby'
        ? 'this route stands down to a live pane watch; there is no hosted loop to fault'
        : watch.phase === 'stopped'
          ? "this route's hosted watch has stopped; nothing is running to fault"
          : null;
  if (unwatchable !== null) {
    refuse(io, parsed.json, 'daemon', { id: 'daemon.fault-watch-state', message: unwatchable, repair: null });
    // exit: daemon.fault-watch-state
    return 1;
  }

  if (parsed.dryRun) {
    if (parsed.json) {
      writeJson(io, 'team.daemon-fault', {
        format: 1,
        command: 'fault-watch',
        dry_run: true,
        root: loaded.root,
        route_id: expected,
        watch: {
          phase: watch.phase,
          failures: watch.failures,
          cycles: watch.cycles,
          required: watch.required,
        },
      });
    } else {
      io.stdout(
        `team daemon: would ask the running daemon to fault the hosted watch for ${loaded.root} (route ${expected}); nothing was written\n`,
      );
    }
    // exit: daemon.fault-dry-run
    return 0;
  }

  const now = sources.now?.() ?? new Date();
  const request = {
    format: 1 as const,
    home,
    routeId: expected,
    daemonPid: health.pid,
    daemonSince: health.since,
    why: FAULT_WHY,
    requestedAt: now.toISOString(),
    nonce: randomUUID(),
  };
  const written = writeFaultRequest(home, request);
  if (!written.ok) {
    refuse(io, parsed.json, 'daemon', { id: 'daemon.fault-pending', message: written.why, repair: null });
    // exit: daemon.fault-pending
    return 1;
  }
  const wait = sources.faultWaitMs ?? FAULT_WAIT_MS;
  const pollMs = sources.faultPollMs ?? FAULT_POLL_MS;
  const sleep = sources.sleep ?? ((ms: number) => new Promise<void>((settle) => setTimeout(settle, ms)));
  const deadline = Date.now() + wait;
  for (;;) {
    const result = readFaultResult(home);
    if (result !== null && result.nonce === request.nonce) {
      if (result.outcome === 'faulted') {
        if (parsed.json) {
          writeJson(io, 'team.daemon-fault', {
            format: 1,
            command: 'fault-watch',
            outcome: 'faulted',
            root: loaded.root,
            route_id: expected,
            why: result.why,
            requested_at: request.requestedAt,
            answered_at: result.at,
          });
        } else {
          io.stdout(
            `team daemon: faulted the hosted watch for ${loaded.root} (route ${expected}); the failure is counted and the loop restarts on the next heartbeat\n`,
          );
        }
        // exit: daemon.faulted
        return 0;
      }
      refuse(io, parsed.json, 'daemon', {
        id: result.outcome === 'refused' ? 'daemon.fault-refused' : 'daemon.fault-not-reached',
        message: `the daemon ${result.outcome === 'refused' ? 'refused the fault' : 'did not reach the fault'}: ${result.why}`,
        repair: null,
      });
      // exit: daemon.fault-refused
      return 1;
    }
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  // The request is left where it is: a later beat may still consume it, and the result file it
  // writes then names this nonce, but nothing was killed by this call.
  refuse(io, parsed.json, 'daemon', {
    id: 'daemon.fault-not-reached',
    message: `the daemon did not reach the fault within ${String(wait)} ms; nothing was killed`,
    repair: null,
  });
  // exit: daemon.fault-not-reached
  return 1;
}

function statusLine(health: Awaited<ReturnType<typeof daemonHealth>>): string {
  if (health.state === 'running') {
    const parts = [
      `running (pid ${String(health.pid)})`,
      `started ${health.startedBy ?? 'unknown'}`,
      `since ${health.since ?? 'unknown'}`,
      `heartbeat ${health.heartbeatAt ?? 'unknown'}`,
    ];
    // A daemon can be running while a checkout's send or bus endpoint did not start here; the
    // one line says so instead of reporting plain health, and the detail is in --json and log.
    parts.push(...rootsSummary(health.roots));
    if (health.probe.state === 'unanswered') {
      parts.push(`probe unanswered (${health.probe.reason})`);
    } else if (health.probe.state === 'refused') {
      parts.push(`probe refused (${health.probe.code})`);
    }
    if (health.stuck.length > 0) parts.push(`${String(health.stuck.length)} stuck request(s)`);
    return `team daemon: ${parts.join('; ')}; socket ${health.socket}`;
  }
  if (health.state === 'unknown') {
    return `team daemon: unknown (${health.why ?? 'the daemon cannot be read'}); socket ${health.socket}`;
  }
  return `team daemon: not running; socket ${health.socket}`;
}

export async function runDaemon(argv: string[], rawIo: Io, sources: DaemonCommandSources = {}): Promise<number> {
  const io = cleanedIo(rawIo);
  const home = sources.home ?? homedir();
  const parsed = parse(argv);
  const problem = verbProblem(parsed);
  if (problem !== null) {
    refuse(io, parsed.json, 'daemon', { id: 'daemon.usage', message: problem, repair: null, usage: USAGE });
    // exit: daemon.usage
    return 2;
  }

  if (parsed.verb === 'status') {
    const health = await daemonHealth(home, {
      ...(sources.now !== undefined ? { now: sources.now } : {}),
    });
    if (parsed.json) {
      writeJson(io, 'team.daemon-status', { format: 1, daemon: health });
    } else {
      io.stdout(`${statusLine(health)}\n`);
    }
    // exit: daemon.status
    return 0;
  }

  if (parsed.verb === 'run') {
    const startedBy = parsed.startedBy ?? 'manual';
    if (!runAllowed(io, startedBy, parsed.json)) {
      // exit: daemon.run-not-owner
      return 1;
    }
    const named = rootsOf(parsed, io, home);
    // A named root that cannot be read is refused rather than silently dropped: the service
    // unit's checkout list is validated when it is written, and a missing checkout must be
    // visible instead of starting a daemon that hosts nothing.
    if ('problem' in named && parsed.roots.length > 0) {
      refuse(io, parsed.json, 'daemon', { id: 'daemon.run-root', message: named.problem, repair: null });
      // exit: daemon.run-root
      return 2;
    }
    const roots = 'problem' in named ? [] : named.roots;
    const started = await (sources.start ?? startMachineDaemon)({
      home,
      roots,
      startedBy,
      version: sources.version ?? installedVersion(),
      ...(sources.now !== undefined ? { now: sources.now } : {}),
      ...(sources.heartbeatMs !== undefined ? { heartbeatMs: sources.heartbeatMs } : {}),
      ...(sources.sendHost !== undefined ? { sendHost: sources.sendHost } : {}),
      ...(parsed.presence ? {
        presenceHosting: true,
        // The seat's own state record is the only source of an explicit endpoint. The shared
        // reader accepts it only under the seat's current presence binding, so a missing,
        // malformed or earlier-incarnation record stays null and the seat is reported unproven;
        // no home folder is consulted and no shared endpoint is guessed in its place.
        presenceCodexEndpoint: (route, stateDir, seat) => currentCodexEndpoint(stateDir, route.session, seat),
      } : {}),
      // One hosted watch per route on the same heartbeat. Its outbound effects stay behind the
      // shared authority verifier and the direct sender, and no presence pipeline is implied: a
      // run may host either, both or neither.
      ...(parsed.watch ? { watchHosting: true } : {}),
    });
    if (started.kind === 'already-running') {
      io.stdout(`team daemon: already running${started.pid === null ? '' : ` (pid ${String(started.pid)})`}\n`);
      // exit: daemon.already-running
      return 0;
    }
    if (started.kind !== 'serving') {
      const why =
        started.kind === 'locked'
          ? `another start holds the machine lock${started.pid === null ? '' : ` (pid ${String(started.pid)})`}; nothing was started`
          : started.reason;
      io.stderr(`team daemon: ${why}\n`);
      // exit: daemon.run-failed
      return 1;
    }
    const machine = started.daemon;
    io.stdout(
      `team daemon: running (pid ${String(process.pid)}); socket ${machine.socketPath}; ${rootsSummary(machine.roots).join('; ')}; broker not hosted\n`,
    );
    let disarm = (): void => {};
    await new Promise<void>((settle) => {
      disarm = (sources.stop ?? processStop)(() => settle());
    });
    disarm();
    await machine.close();
    appendDaemonLog(home, 'daemon stopped', sources.now?.() ?? new Date());
    io.stdout('team daemon: stopped\n');
    // exit: daemon.stopped
    return 0;
  }

  if (!ownerAllows(io, sources, parsed.json)) {
    // exit: daemon.not-owner
    return 1;
  }

  if (parsed.verb === 'fault-watch') {
    return await faultWatch(parsed, io, sources, home);
  }

  const manager = sources.service !== undefined ? sources.service : systemServiceManager();
  if (manager === null) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.service-unavailable',
      message: 'no system service manager adapter is available on this platform yet',
      repair: null,
    });
    // exit: daemon.service-unavailable
    return 1;
  }

  if (parsed.verb === 'uninstall') {
    const removed = manager.uninstall(home);
    if (!removed.ok) {
      appendDaemonLog(home, `uninstall: ${removed.detail ?? removed.why}`, sources.now?.() ?? new Date());
      refuse(io, parsed.json, 'daemon', { id: 'daemon.uninstall-failed', message: removed.why, repair: null });
      // exit: daemon.uninstall-failed
      return 1;
    }
    if (parsed.json) {
      writeJson(io, 'team.daemon-install', {
        format: 1,
        command: 'uninstall',
        dry_run: false,
        installed: false,
        unit_path: removed.unitPath,
        removed: removed.removed,
      });
    } else if (removed.removed) {
      io.stdout('team daemon: uninstalled; the system service manager no longer starts it\n');
    } else {
      io.stdout('team daemon: not installed; nothing to remove\n');
    }
    // exit: daemon.uninstalled
    return 0;
  }

  // install
  const named = rootsOf(parsed, io, home);
  if ('problem' in named) {
    refuse(io, parsed.json, 'daemon', { id: 'daemon.no-root', message: named.problem, repair: null });
    // exit: daemon.no-root
    return 2;
  }
  const program = localProgram(sources);
  if (program === null) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.entry-missing',
      message: 'the CLI entry cannot be found, so the service unit cannot be written',
      repair: null,
    });
    // exit: daemon.entry-missing
    return 1;
  }
  const fullProgram: ServiceProgram = {
    ...program,
    roots: named.roots,
    // The installed unit is the service-managed run lifecycle; the flags an owner gives here are
    // written into its run command, so presence and watch hosting survive login restarts. A plain
    // install writes no flag and starts exactly the daemon it did before.
    ...(parsed.presence ? { presence: true } : {}),
    ...(parsed.watch ? { watch: true } : {}),
  };
  const plan = manager.plan(home, fullProgram);
  if (parsed.dryRun) {
    if (parsed.json) {
      writeJson(io, 'team.daemon-install', {
        format: 1,
        command: 'install',
        dry_run: true,
        installed: false,
        unit_path: plan.unitPath,
        program: plan.program,
        roots: named.roots,
      });
    } else {
      io.stdout(
        `team daemon: would install the machine daemon for ${String(named.roots.length)} checkout(s); the system service manager starts it at login and restarts it after a failure; nothing was written\n`,
      );
    }
    // exit: daemon.dry-run
    return 0;
  }
  const installed = manager.install(home, fullProgram);
  if (!installed.ok) {
    appendDaemonLog(home, `install: ${installed.detail ?? installed.why}`, sources.now?.() ?? new Date());
    refuse(io, parsed.json, 'daemon', { id: 'daemon.install-failed', message: installed.why, repair: null });
    // exit: daemon.install-failed
    return 1;
  }
  if (parsed.json) {
    writeJson(io, 'team.daemon-install', {
      format: 1,
      command: 'install',
      dry_run: false,
      installed: true,
      unit_path: installed.unitPath,
      program: plan.program,
      roots: named.roots,
    });
  } else {
    io.stdout(
      `team daemon: installed for ${String(named.roots.length)} checkout(s); the system service manager starts it at login and restarts it after a failure\n`,
    );
  }
  // exit: daemon.installed
  return 0;
}
