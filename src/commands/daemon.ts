// `team daemon`: the one machine-wide TeamCLI daemon. `run` is the foreground process the
// system's service manager starts (it hosts the existing send and bus servers in this one process
// and serves the machine socket); `run --presence` additionally hosts the presence pipeline, and
// `run --watch` hosts one watch per checkout on the same heartbeat; without a flag the daemon
// hosts neither. `install` and `uninstall` write and register the user service unit through a
// neutral interface, with the platform's own file and command only inside the adapter; `restart`
// stops the daemon that installed unit runs and starts that same unit again, writing nothing.
// `status` is the one-line health reading every other command and person reads. `fault-watch`
// asks a running daemon to inject one diagnostic fault into exactly one hosted watch: one
// request, one route id, no process killed.
//
// The daemon's own start is admitted by the service manager's record of the job it started and
// the unit file that job was started from — never by a process walk, which cannot tell a
// service-managed child from an orphan reparented to the top. An install or restart reports
// success only after that daemon answers the machine socket; an install takes the unit back out
// when it does not, and a restart offers the installed unit again.
//
// The machine daemon holds no credential and reads no credential store. The broker feature is
// not hosted in this build, and the catalogue's `daemon.broker` policy is off by default, so a
// machine with no broker handler never falls back to the old per-clone broker.
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, isOwner } from '../caller.ts';
import { admitGeneral } from '../client/general-grant.ts';
import { devModeOwnerLiftAtCwd } from '../dev_mode.ts';
import {
  FAULT_POLL_MS,
  FAULT_WAIT_MS,
  FAULT_WHY,
  readFaultResult,
  writeFaultRequest,
} from '../daemon/fault.ts';
import { daemonHealth } from '../daemon/health.ts';
import { failureAge } from '../daemon/health_display.ts';
import { appendDaemonLog, startMachineDaemon, type MachineRootStatus, type StartMachineDaemonResult } from '../daemon/host.ts';
import { DAEMON_LABEL } from '../daemon/paths.ts';
import { currentCodexEndpoint } from '../daemon/presence/endpoint-state.ts';
import { routeId, routeOf } from '../daemon/routes.ts';
import {
  systemServiceManager,
  type ServiceInstallFailure,
  type ServiceManager,
  type ServicePlan,
  type ServiceProgram,
  type ServiceRuntime,
} from '../daemon/service.ts';
import type { DaemonHost } from '../send/daemon.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { refuse, writeJson, writeJsonError } from '../output/index.ts';
import { shellQuote } from '../profiles/profile.ts';
import { version as installedVersion, gitHead as installedGitHead } from '../version.ts';

export const USAGE = `Usage: team daemon status [--json]
       team daemon run [--root <folder>] [--started-by <source>] [--presence] [--watch]
       team daemon install [--root <folder>] [--presence] [--watch] [--dry-run] [--json]
       team daemon restart [--dry-run] [--json]
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
it after a failure; \`restart\` stops the daemon that unit runs and starts that same unit again,
writing nothing; \`uninstall\` removes it. \`status\` prints one line: running, not running, or
unknown. A restart reports success only after the daemon answers.
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
  /** Injected for tests: the health reading that confirms the daemon an install started, or a
   *  rollback restored, answers, so a scene never opens the machine socket. */
  health?: typeof daemonHealth;
  /** Injected for tests: the program the service manager will run; `null` means it can't be found. */
  program?: { execPath: string; entry: string } | null;
  now?: () => Date;
  version?: string;
  /** Injected for tests: the packaged commit; null in a source checkout. */
  gitHead?: string | null;
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
  const isRestart = verb === 'restart';
  const isUninstall = verb === 'uninstall';
  const isFaultWatch = verb === 'fault-watch';
  const known = isStatus || isRun || isInstall || isRestart || isUninstall || isFaultWatch;
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
  if (parsed.verb === undefined) return 'a subcommand is required (status, run, install, restart, uninstall or fault-watch)';
  if (!parsed.known) return `unknown subcommand "${parsed.verb}"`;
  if (parsed.extra !== undefined) return `unexpected "${parsed.extra}"`;
  if (parsed.verb === 'run' && parsed.json) return '--json belongs to status, install, restart, uninstall or fault-watch';
  if (parsed.verb === 'run' && parsed.dryRun) return '--dry-run belongs to install, restart or fault-watch';
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
  if (parsed.verb === 'status' && parsed.dryRun) return '--dry-run belongs to install, restart or fault-watch';
  if (parsed.verb === 'status' && parsed.roots.length > 0) return '--root belongs to run or install';
  if (parsed.verb === 'status' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (parsed.verb === 'install' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (parsed.verb === 'restart' && parsed.roots.length > 0) return '--root belongs to run or install';
  if (parsed.verb === 'restart' && parsed.startedBy !== undefined) return '--started-by belongs to run';
  if (parsed.verb === 'uninstall' && parsed.dryRun) return '--dry-run belongs to install, restart or fault-watch';
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

/**
 * The files that make up the running CLI, as the service adapter must copy them. A build is a
 * module tree under the package's `dist`, beside the relay package it imports and the manifest
 * it reads its version from; a source run keeps the same shape one folder over. The nearest
 * folder above the entry that carries a manifest is the package root, and the entry's own folder
 * under it, the relay package beside it and that manifest are the whole program. Undefined when
 * no manifest is found: the adapter then keeps the entry's own folder, exactly as a synthetic
 * single-file scene needs.
 */
function programRuntime(entry: string): ServiceRuntime | undefined {
  let folder = dirname(entry);
  for (let up = 0; up < 8; up += 1) {
    if (existsSync(join(folder, 'package.json'))) {
      const include = [relative(folder, dirname(entry)) === '' ? '.' : relative(folder, dirname(entry))];
      if (existsSync(join(folder, 'packages', 'relay'))) include.push('packages/relay');
      include.push('package.json');
      return { root: folder, include };
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  return undefined;
}

function localProgram(sources: DaemonCommandSources): { execPath: string; entry: string; runtime?: ServiceRuntime } | null {
  if (sources.program !== undefined) return sources.program;
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return null;
  let resolved = resolve(entry);
  try {
    resolved = realpathSync(entry);
  } catch {
    // An entry this process was started from but cannot resolve is still the path it runs.
  }
  const runtime = programRuntime(resolved);
  return { execPath: process.execPath, entry: resolved, ...(runtime === undefined ? {} : { runtime }) };
}

/**
 * The owner's gate of the daemon's owner-gated verbs — install, restart, uninstall and
 * fault-watch. Two admissions widen it:
 *
 * - a verified general grant recorded on this run (`io.general`), for install and restart: the
 *   dispatcher's door verified the grant's chain, its key and the `daemon` op once, and this
 *   command verifies them again here, so a grant whose chain, key or ops no longer admit
 *   `daemon` cannot act. A grant holder needs no terminal and no owner seat;
 * - the owner's widening (OD-20261019-49), which admits a placed team orchestrator through the
 *   same central admission every owner-only command shares; the admission is the file's lead on
 *   the pane its team's state records, never a bare name or a role claim.
 *
 * `run` is not this gate: a no-terminal start by the service manager is `runAllowed`'s separate
 * answer, and no dev-mode setting admits a seat or a pane to it.
 */
function ownerAllows(io: Io, sources: DaemonCommandSources, json: boolean, verb: string | undefined): boolean {
  const caller = callerOf(io);
  if (isOwner(caller)) return true;
  if ((verb === 'install' || verb === 'restart') && io.general !== undefined) {
    const verified = admitGeneral(
      sources.home ?? homedir(),
      io.general.grant,
      io.general.key,
      'daemon',
      null,
      sources.now?.() ?? new Date(),
    );
    if (verified.ok) return true;
    // The grant the run was admitted with no longer stands: say which check failed, in the
    // grant's own words, instead of describing the caller the door already answered.
    refuse(io, json, 'daemon', { id: 'daemon.grant-refused', message: verified.why, repair: null, rule: 'general-grant' });
    return false;
  }
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

/** Whether two executable paths name the same file. A path that cannot be resolved is a
 *  mismatch: the record is the identity, so an unreadable one is never a wildcard. */
function sameExecutable(recorded: string | null | undefined, running: string): boolean {
  if (recorded === null || recorded === undefined || recorded === '') return false;
  try {
    return realpathSync(recorded) === realpathSync(running);
  } catch {
    return false;
  }
}

/** Whether the unit's remaining launch words are this process's own, in order and in full. */
function sameWords(unit: readonly string[], own: readonly string[]): boolean {
  return unit.length === own.length && unit.every((word, at) => word === own[at]);
}

/**
 * Admits a start by the system's service manager from the manager's own record of the job it
 * started, never from the process walk: a daemon the service manager starts has no ancestor it
 * can read, and neither has an orphan reparented to the top, so the walk cannot tell them apart.
 * The unit file is checked first (it is the file the daemon was started from, not a label from
 * its surroundings), then the job's pid, then the record's program and the unit's own words.
 * Each failure refuses with its own contract id; there is no fallback.
 *
 * The ceiling this proves is "the service manager started this process from a unit the user
 * owns": any process of that same user can register a job under a label that is not loaded, so
 * this is an identity check against mistakes, not a boundary against that user's attempt. The
 * retained program the unit runs carries the same limit: its copy is verified before the unit is
 * written, but a process of that user can replace it, or a folder in it, between that check and
 * the manager's exec, exactly as it can rewrite the unit file.
 */
function serviceManaged(io: Io, home: string, sources: DaemonCommandSources, json: boolean): boolean {
  const manager = sources.service !== undefined ? sources.service : systemServiceManager();
  const refusal = (id: string, checked: string): false => {
    const message = `only the owner or the system's service manager starts the machine daemon: ${checked}`;
    refuse(io, json, 'daemon', { id, message, repair: null });
    return false;
  };
  if (manager === null) {
    return refusal('daemon.service-managed.unit', 'no unit file of this daemon\'s own can be read on this platform');
  }
  const unit = manager.unit(home);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    unit === null
    || unit.label !== DAEMON_LABEL
    || uid === null
    || unit.ownerUid !== uid
    || unit.mode === null
    || (unit.mode & 0o022) !== 0
  ) {
    return refusal('daemon.service-managed.unit', 'the unit file is not this daemon\'s own');
  }
  const job = manager.job(home);
  if (job === null || job.pid !== process.pid) {
    return refusal('daemon.service-managed.pid', 'the record of the job does not name this process');
  }
  if (
    !sameExecutable(job.program, process.execPath)
    || unit.programArguments === null
    || !sameExecutable(unit.programArguments[0], process.execPath)
    || !sameWords(unit.programArguments.slice(1), process.argv.slice(1))
  ) {
    return refusal('daemon.service-managed.program', 'the record and the unit do not run this executable with these words');
  }
  return true;
}

function runAllowed(io: Io, home: string, startedBy: string, json: boolean, sources: DaemonCommandSources): boolean {
  const caller = callerOf(io);
  if (isOwner(caller)) return true;
  // The service-managed start is admitted only by the service manager's own record of the job.
  // The flag alone admits nothing: a seat that types it must still be the process the record
  // names, running the unit's own words.
  if (startedBy === 'service-manager') return serviceManaged(io, home, sources, json);
  const message = `only the owner or the system's service manager runs the machine daemon; this call is ${describeCaller(caller)}`;
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
 *  while a checkout's endpoint did not start here never reads as full health. A failed endpoint
 *  carries its reason and, when the record kept it, its age; a root still starting says so. */
function rootsSummary(roots: MachineRootStatus[], now: Date = new Date()): string[] {
  const at = now.toISOString();
  const sendServing = roots.filter((root) => root.send === 'serving').length;
  const busServing = roots.filter((root) => root.bus === 'serving').length;
  const notHosted = roots.reduce(
    (count, root) => count + (root.send === 'serving' ? 0 : 1) + (root.bus === 'serving' ? 0 : 1),
    0,
  );
  const starting = roots.reduce(
    (count, root) => count + (root.send === 'starting' ? 1 : 0) + (root.bus === 'starting' ? 1 : 0),
    0,
  );
  const parts = [`roots ${String(roots.length)} (send ${String(sendServing)}, bus ${String(busServing)})`];
  if (starting > 0) parts.push(`${String(starting)} endpoint${starting === 1 ? '' : 's'} starting`);
  const failed = roots.flatMap((root) => {
    const entries: string[] = [];
    // Every failed endpoint is named, with its reason. A record written before this build kept
    // the failure instant has no age to show; losing the failure with the stamp would hide a
    // real one, so only the age is optional.
    if (root.send === 'failed') {
      entries.push(`send for ${root.root}: ${root.why ?? 'no reason recorded'}${failureAge(root.sendFailedAt, at)}`);
    }
    if (root.bus === 'failed') {
      entries.push(`bus for ${root.root}: ${root.why ?? 'no reason recorded'}${failureAge(root.busFailedAt, at)}`);
    }
    return entries;
  });
  if (failed.length > 0) {
    parts.push(`${String(failed.length)} endpoint${failed.length === 1 ? '' : 's'} failed (${failed.join(', ')})`);
    return parts;
  }
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
    parts.push(...rootsSummary(health.roots, new Date(health.probe.at)));
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

/**
 * The install's steps, in the neutral words the dry run prints before anything runs: a refresh
 * stops the daemon the service manager holds, the new one is started with a bounded, growing
 * retry, and a start that still fails puts the previous unit back and starts it again. The live
 * adapter follows this contract; the names of the platform's own facility stay in it.
 */
const INSTALL_STEPS: readonly string[] = [
  'the previous daemon, if the service manager holds one, is stopped before the new one is offered',
  'the new daemon is started, offered again with a bounded, growing wait while the system\'s service manager refuses',
  'if it still cannot start, the previous unit is put back and its daemon started again',
];

/**
 * The command that starts a daemon again after an install that left none running: this install
 * with the roots it recorded and the opt-ins it was given, each root quoted so it reaches the
 * rerun whole. Rerunning install is the whole recovery — the definition a failed refresh kept is
 * already where the service manager reads it — and nothing here names a platform's own command.
 */
function installAgain(roots: readonly string[], parsed: Parsed): string {
  const parts = ['team', 'daemon', 'install'];
  for (const root of roots) parts.push('--root', shellQuote(root));
  if (parsed.presence) parts.push('--presence');
  if (parsed.watch) parts.push('--watch');
  return parts.join(' ');
}

/** How long the command waits for a daemon to answer: the first probe at once, then the same
 *  bounded, growing waits the adapter gives a load. */
const ANSWERS_WAIT_MS: readonly number[] = [100, 200, 400, 800, 1_000, 1_000, 1_000];
const ANSWERS_PROBES = ANSWERS_WAIT_MS.length + 1;

/**
 * Confirms a daemon answers, through the same health reading `team status` uses. A load the
 * service manager accepted is registration, not proof that a program runs: the unit an install
 * just wrote, or the earlier one a rollback restored, may name bytes that cannot start, and the
 * manager would still say the load was taken. Bounded — eight probes over about 4.5 seconds — so
 * a daemon that never answers is reported as none rather than waited on. An install reports
 * success only after this answers; a rollback is called one only after the restored daemon
 * answers.
 */
async function daemonAnswers(home: string, sources: DaemonCommandSources): Promise<boolean> {
  const health = sources.health ?? daemonHealth;
  const sleep = sources.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let probe = 0; probe < ANSWERS_PROBES; probe += 1) {
    if (probe > 0) {
      const wait = ANSWERS_WAIT_MS[probe - 1];
      if (wait !== undefined) await sleep(wait);
    }
    const reading = await health(home, { timeoutMs: 500 });
    if (reading.state === 'running' && reading.probe.state === 'answered') return true;
  }
  return false;
}

/**
 * The one exit an install that leaves no new daemon reports through. The pre-flight plan that
 * cannot read the program whole and a failure the adapter reports both end here, so the exit
 * contract keeps one marker for the id.
 */
function installFailed(io: Io, parsed: Parsed, spec: Parameters<typeof refuse>[3]): number {
  refuse(io, parsed.json, 'daemon', spec);
  // exit: daemon.install-failed
  return 1;
}

/**
 * Reports an install that left no new daemon: a load the manager refused, or a unit whose daemon
 * did not answer and was taken back out. A rollback is reported as one only after the daemon it
 * started answers the same health probe; a rollback that started nothing answering takes the
 * answer a lost rollback gives — no daemon, with the rerun command. Either way the line names
 * what happened and exits 1, so an install never ends with no daemon and no message.
 */
async function reportInstallFailure(
  failure: ServiceInstallFailure,
  io: Io,
  parsed: Parsed,
  roots: readonly string[],
  unitPath: string,
  home: string,
  sources: DaemonCommandSources,
): Promise<number> {
  appendDaemonLog(home, `install: ${failure.detail ?? failure.why}`, sources.now?.() ?? new Date());
  let outcome = failure.outcome;
  let why = failure.why;
  if (outcome === 'restored' && !(await daemonAnswers(home, sources))) {
    appendDaemonLog(home, 'install: the restored daemon did not answer the health probe', sources.now?.() ?? new Date());
    outcome = 'lost';
    why = `${failure.why}, but the restored daemon did not answer; no daemon is running`;
  }
  if (outcome === 'restored') {
    refuse(io, parsed.json, 'daemon', { id: 'daemon.install-rolled-back', message: why, repair: null });
    // exit: daemon.install-rolled-back
    return 1;
  }
  // No daemon is running: the line names the command that starts one again, and where a kept
  // earlier unit is, so the failure is actionable without reading the log afterwards.
  const again = installAgain(roots, parsed);
  const repair = `the owner runs \`${again}\``;
  const keptAt = failure.kept ? `; the previous unit is kept at ${unitPath}` : '';
  if (outcome === 'lost') {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.install-rollback-failed',
      message: why,
      repair,
      plain: `${why}; ${repair} to start a daemon again${keptAt}`,
    });
    // exit: daemon.install-rollback-failed
    return 1;
  }
  return installFailed(io, parsed, {
    id: 'daemon.install-failed',
    message: why,
    repair,
    plain: `${why}; ${repair} to try again${keptAt}`,
  });
}

/**
 * The restart's steps, in the neutral words the dry run prints before anything runs: the daemon
 * the manager holds under the installed unit is stopped, that same unit is loaded again with the
 * same bounded, growing retry an install gives a load, and nothing on disk changes.
 */
const RESTART_STEPS: readonly string[] = [
  'the daemon the system\'s service manager holds under the installed unit is stopped',
  'that same unit is loaded again, offered again with a bounded, growing wait while the manager refuses',
  'nothing is written: the definition, its checkouts and its opt-ins stay the last install\'s',
];

/** The command that writes and starts a unit when a restart leaves no daemon: an install is the
 *  whole recovery, and naming each checkout keeps the rerun's hosted set the owner's choice. */
const RESTART_REPAIR = 'run `team daemon install --root <folder>` with each checkout to host';

/**
 * `team daemon restart`: stops the daemon the service manager holds under the installed unit and
 * loads that same unit again, writing nothing. Success is reported only after the restarted
 * daemon answers the machine socket; one that does not is undone — stopped, and the installed
 * unit offered again — and the restart is reported as undone only after the daemon it started
 * answers. Exits 1 with the repair whenever it leaves no daemon running.
 */
async function restartInstalled(
  manager: ServiceManager,
  io: Io,
  parsed: Parsed,
  home: string,
  sources: DaemonCommandSources,
): Promise<number> {
  if (parsed.dryRun) {
    if (parsed.json) {
      writeJson(io, 'team.daemon-restart', {
        format: 1,
        command: 'restart',
        dry_run: true,
        restarted: false,
        unit_path: manager.unitPath(home),
        steps: [...RESTART_STEPS],
      });
    } else {
      io.stdout(
        `team daemon: would restart the installed machine daemon; nothing is written\n${RESTART_STEPS.map((step) => `  - ${step}\n`).join('')}`,
      );
    }
    // exit: daemon.restart-dry-run
    return 0;
  }
  const restarted = manager.restart(home);
  if (!restarted.ok) {
    appendDaemonLog(home, `restart: ${restarted.detail ?? restarted.why}`, sources.now?.() ?? new Date());
    if (restarted.reason === 'not-installed') {
      refuse(io, parsed.json, 'daemon', {
        id: 'daemon.not-installed',
        message: restarted.why,
        repair: RESTART_REPAIR,
      });
      // exit: daemon.not-installed
      return 1;
    }
    const why = `${restarted.why}; no daemon is running`;
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.restart-failed',
      message: why,
      repair: RESTART_REPAIR,
      plain: `${why}; ${RESTART_REPAIR} to start a daemon again`,
    });
    // exit: daemon.restart-failed
    return 1;
  }
  // A load the manager accepted is registration, not proof that a program runs: the restarted
  // daemon must answer before this restart is called one.
  if (await daemonAnswers(home, sources)) {
    if (parsed.json) {
      writeJson(io, 'team.daemon-restart', {
        format: 1,
        command: 'restart',
        dry_run: false,
        restarted: true,
        unit_path: restarted.unitPath,
      });
    } else {
      io.stdout('team daemon: restarted; the system\'s service manager runs the installed unit again\n');
    }
    // exit: daemon.restarted
    return 0;
  }
  appendDaemonLog(home, 'restart: the restarted daemon did not answer the health probe', sources.now?.() ?? new Date());
  const undone = restarted.undo();
  if (undone.ok && (await daemonAnswers(home, sources))) {
    refuse(io, parsed.json, 'daemon', {
      id: 'daemon.restart-rolled-back',
      message: 'the restarted daemon did not answer the health probe; the installed unit was started again and its daemon answers',
      repair: null,
    });
    // exit: daemon.restart-rolled-back
    return 1;
  }
  const message = undone.ok
    ? 'the restarted daemon did not answer the health probe, and the daemon started again did not answer either; no daemon is running'
    : `the restarted daemon did not answer the health probe, and the installed daemon could not be started again: ${undone.why}; no daemon is running`;
  refuse(io, parsed.json, 'daemon', {
    id: 'daemon.restart-rollback-failed',
    message,
    repair: RESTART_REPAIR,
    plain: `${message}; ${RESTART_REPAIR} to start a daemon again`,
  });
  // exit: daemon.restart-rollback-failed
  return 1;
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
    if (!runAllowed(io, home, startedBy, parsed.json, sources)) {
      // exit: daemon.run-not-owner
      // exit: daemon.service-managed.pid
      // exit: daemon.service-managed.program
      // exit: daemon.service-managed.unit
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
    // A hosted endpoint that cannot be kept alive stops the daemon: this callback ends the
    // foreground run, and the non-zero exit below hands the restart to the service manager.
    let fatalWhy: string | null = null;
    let endRun: (() => void) | null = null;
    const started = await (sources.start ?? startMachineDaemon)({
      home,
      roots,
      startedBy,
      version: sources.version ?? installedVersion(),
      gitHead: sources.gitHead === undefined ? installedGitHead() : sources.gitHead,
      onFatal: (why: string) => {
        fatalWhy = why;
        endRun?.();
      },
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
    if (fatalWhy === null) {
      await new Promise<void>((settle) => {
        endRun = () => settle();
        disarm = (sources.stop ?? processStop)(() => settle());
      });
    } else {
      io.stderr(`team daemon: ${fatalWhy}\n`);
    }
    disarm();
    await machine.close();
    appendDaemonLog(home, 'daemon stopped', sources.now?.() ?? new Date());
    if (fatalWhy !== null) {
      // The run ended because a hosted endpoint could not be kept alive. The service manager
      // restarts a program that exits non-zero; a zero here would read as a deliberate stop.
      // exit: daemon.fatal
      return 1;
    }
    io.stdout('team daemon: stopped\n');
    // exit: daemon.stopped
    return 0;
  }

  // The four verbs left here are owner-gated: install, restart, uninstall and fault-watch. Two
  // admissions widen the gate through `ownerAllows`: the owner's dev-mode lift admits a placed
  // orchestrator (OD-20261019-49), and install and restart also admit a verified general grant
  // whose ops name `daemon`. status returned above, and run has its own gate.
  if (!ownerAllows(io, sources, parsed.json, parsed.verb)) {
    // exit: daemon.not-owner
    // exit: daemon.grant-refused
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

  if (parsed.verb === 'restart') {
    return await restartInstalled(manager, io, parsed, home, sources);
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
      io.stdout('team daemon: uninstalled; the system\'s service manager no longer starts it\n');
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
    // The general grant and client key that admitted this install (io.general) are the door's
    // for this run and are never written into the unit: the service-started run is admitted by
    // its own `--started-by service-manager`, and a definition that named a key or a grant would
    // keep a credential on disk. An earlier unit that named them is rewritten; see below.
    // The installing shell's PATH, so the service finds herdr where the owner's shell does.
    ...(io.env.PATH !== undefined && io.env.PATH !== '' ? { path: io.env.PATH } : {}),
  };
  let plan: ServicePlan;
  try {
    plan = manager.plan(home, fullProgram);
  } catch (error) {
    // The plan names the retained copy the unit would run, and a program that cannot be read
    // whole is refused before anything is written — by a dry run too, which must not promise a
    // unit the install would then refuse. It leaves through the one install-failure site.
    return installFailed(io, parsed, {
      id: 'daemon.install-failed',
      message: `the program this unit would run could not be read whole, so nothing was written: ${error instanceof Error ? error.message : String(error)}`,
      repair: null,
    });
  }
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
        steps: [...INSTALL_STEPS],
      });
    } else {
      io.stdout(
        `team daemon: would install the machine daemon for ${String(named.roots.length)} checkout(s); the system's service manager starts it at login and restarts it after a failure; nothing was written\n${INSTALL_STEPS.map((step) => `  - ${step}\n`).join('')}`,
      );
    }
    // exit: daemon.dry-run
    return 0;
  }
  const installed = manager.install(home, fullProgram);
  if (!installed.ok) {
    return await reportInstallFailure(installed, io, parsed, named.roots, plan.unitPath, home, sources);
  }
  // A load the manager accepted is registration, not proof that a program runs. The install is
  // reported only after the daemon it started answers the machine socket; a daemon that never
  // answers is taken back out — or the earlier unit is put back — through the adapter's own
  // undo, so a success line never stands for an empty machine.
  if (!(await daemonAnswers(home, sources))) {
    const failure: ServiceInstallFailure = installed.undo === undefined
      ? {
        ok: false,
        why: 'the daemon the new unit started did not answer the health probe, and this manager kept no earlier definition to put back',
        detail: 'the daemon did not answer the health probe within the probe window',
        outcome: 'refused',
        kept: false,
      }
      : installed.undo();
    return await reportInstallFailure(failure, io, parsed, named.roots, plan.unitPath, home, sources);
  }
  if (parsed.json) {
    writeJson(io, 'team.daemon-install', {
      format: 1,
      command: 'install',
      dry_run: false,
      installed: true,
      unit_path: installed.unitPath,
      // The words the unit was actually written with, retained entry included; a manager that
      // reports none wrote the words the plan named.
      program: installed.program ?? plan.program,
      roots: named.roots,
      // The removal is never silent: a structured run says it in a field, a plain run below in
      // a sentence.
      ...(installed.droppedAuthorization === true ? { dropped_authorization: true } : {}),
    });
  } else {
    io.stdout(
      `team daemon: installed for ${String(named.roots.length)} checkout(s); the system's service manager starts it at login and restarts it after a failure\n`,
    );
    if (installed.droppedAuthorization === true) {
      io.stdout('team daemon: the earlier unit named a client key or a general grant; this unit was rewritten without either\n');
    }
  }
  // exit: daemon.installed
  return 0;
}
