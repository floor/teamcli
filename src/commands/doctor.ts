import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { budgetsInForceOf, watchInForceOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import { callerOf, isOwner, type Caller } from '../caller.ts';
import { checkCommands, type ApprovedCheck } from '../budgets/checks.ts';
import { parseOutput, runCommand, type CheckReading } from '../budgets/run.ts';
import { shownTeamFile } from '../check/team.ts';
import { canonicalLanding as showLanding } from '../file/landing.ts';
import { isParseError } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { migrationText } from '../file/migrate.ts';
import { canonicalLanding, insideTrust, isLegacyTrust } from '../file/paths.ts';
import { isLeadSeat, relaunchRepair } from '../file/sections/lead.ts';
import { declaredModel } from '../file/model.ts';
import type { BudgetAccount, Deprecation, Seat, TeamFile } from '../file/types.ts';
import { HERDR_TESTED, herdrVersion, paneRead, sessionRunning, agentList, workspaceList, workspacePanes, type HerdrAgent } from '../herdr.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { verifyLobby } from '../lobby/gate.ts';
import { lobbyOf } from '../lobby/recorded.ts';
import { launchBinary, launchLineFindings } from '../launch/line.ts';
import { plainLine, plainText } from '../launch/plain.ts';
import { lobbyFileOwners, profileFor, shippedLobbyFiles, shippedStartupReads } from '../profiles/index.ts';
import { checkRulesFile, rulesFilePath } from '../launch/rules-file.ts';
import { rulesOf, rulesOriginOf, type RulesOrigin } from '../launch/rules.ts';
import { overridesInForceOf, quotaWith } from '../profiles/overrides.ts';
import { versionVerdict, type Profile } from '../profiles/profile.ts';
import { extractFolder, isEligible, versionMatches } from '../profiles/trust-answer.ts';
import { holdText, liveHold, readState, type SeatState } from '../state.ts';
import { canShowModel, modelDiffers, seatModel } from '../status/statusline.ts';
import { approvalStanding, LEGACY_LINE, otherMatchingStores, otherStoreNote, type Standing } from '../store/store.ts';
import { readScreen } from '../watch/screen.ts';
import { readMachine, swapTotalProblem, type Machine } from '../watch/machine.ts';
import { lobbyPath as derivedLobby } from '../worktree/place.ts';

// What `doctor` reads from the machine, so tests can stand in for it.
export type DoctorSources = {
  // What `<binary> --version` prints, or null when the binary can't be run.
  version(binary: string): string | null;
  // Whether a command is an executable on the PATH. A seat's launcher is never run to find out.
  onPath(binary: string): boolean;
  // Whether the owner is logged in to a CLI; null when this version can't tell.
  loggedIn(profile: Profile): boolean | null;
  herdrVersion(): string | null;
  sessionRunning(session: string): boolean | null;
  agentList?(session?: string): HerdrAgent[] | null;
  now(): Date;
  home: string;
  getuid?(): number;
  // One approved check's raw stdout, or null when it failed or timed out. Absent: the real
  // runner, the same one the watch uses. The raw bytes are parsed and dropped, never returned.
  runCheck?(path: string): string | null;
  // The approval store's one read, overridable so a test can count it or swap the record
  // after the gate. Absent: the real read.
  standing?(root: string): Standing;
  /** A pane's visible text. Absent in a test that does not read panes; the real command reads them. */
  paneText?(session: string, pane: string): string | undefined;
  /** This machine's own figures, read for the one check no machine can ever meet. Absent in a test
   *  that does not read them; absent is not "fine", it is nothing said. */
  machine?(root: string): Machine;
  /** Whether the watch's pid is alive. Absent: a fresh heartbeat is read as running, as before. */
  watchAlive?(pid: number): boolean;
  /** The process's own name, never its arguments. Null when it cannot be read. */
  processComm?(pid: number): string | null;
  /** Whether the session still has this pane. Null when herdr can't say, which says nothing. */
  watchPane?(session: string, pane: string, workspace?: string): boolean | null;
  /** One command's raw answer, both streams — the reads that are not a seat's launcher (a `git`
   *  remote, the Jules CLI). Absent in a test: "could not be run", never consent to touch the
   *  machine. */
  command?(binary: string, args: string[]): CommandRead | null;
};

export type CommandRunner = (binary: string, args: string[]) => { status: number | null; stdout: string } | null;

/** A command's status and both streams, as the two `--jules` reads see them: a CLI names the
 *  missing step on standard error as often as on standard output, and the first line it printed
 *  is what the report repeats. */
export type CommandRead = { status: number | null; stdout: string; stderr: string };

export function run(binary: string, args: string[]): { status: number | null; stdout: string } | null {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
  return result.error ? null : { status: result.status, stdout: result.stdout };
}

/** `run` with standard error kept: the same spawn, both streams, for `--jules`'s two reads. */
export function readCommand(binary: string, args: string[]): CommandRead | null {
  const result = spawnSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
  return result.error ? null : { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const realCommandRunner = run;

/** The process's own name: `ps` `comm`, the file name only, never an argument. A name that is
 *  not a single token is unreadable — a path's directory and a command line are not the name. */
export function processComm(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2_000,
  });
  if (result.error || result.status !== 0) return null;
  const base = result.stdout.trim().split('/').pop() ?? '';
  return /^[A-Za-z0-9._+-]+$/.test(base) ? base : null;
}

export function checkLogin(profile: Profile, runner: CommandRunner = run): boolean | null {
  if (!profile.loginCheck) return null;
  // Only the exit code is read: the output names the account.
  const result = runner(profile.binary, [...profile.loginCheck]);
  return result ? result.status === 0 : null;
}

export const realSources: DoctorSources = {
  version(binary) {
    const result = run(binary, ['--version']);
    return result && result.status === 0 ? result.stdout.trim() : null;
  },
  onPath(binary) {
    const folders = isAbsolute(binary) ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    return folders.some((folder) => {
      try {
        accessSync(folder ? join(folder, binary) : binary, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  },
  loggedIn(profile) {
    return checkLogin(profile, run);
  },
  herdrVersion,
  sessionRunning,
  agentList,
  now: () => new Date(),
  home: homedir(),
  getuid: () => process.getuid?.() ?? 0,
  runCheck: (path) => runCommand(path),
  command: readCommand,
  paneText: (session, pane) => paneRead(pane, 40, session) ?? undefined,
  machine: readMachine,
  watchAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  processComm,
  watchPane(session, pane, workspace) {
    const aim = session === 'default' ? undefined : session;
    const id = workspace || pane.split(':')[0];
    if (!id) return null;
    const listed = workspaceList(aim);
    if (listed === null) return null;
    if (!listed.some((item) => item.id === id)) return false;
    const panes = workspacePanes(id, aim);
    if (panes === null) return null;
    return panes.includes(pane);
  },
};

export const USAGE =
  "Usage: team doctor [--session <name>] [--file <path>] [--login] [--jules] [--json]\nExits 0 when nothing is missing, 1 when something is missing, 2 when the invocation or team file can't be read.\n";

export type Level = 'ok' | 'warn' | 'miss' | 'note';
export type Finding = { level: Level; text: string };

// A missing or stale watch is not a reason for `up` to refuse: `up` starts the watch itself.
export function blocksLaunch(finding: Finding): boolean {
  if (finding.level !== 'miss') return false;
  // A watch with no pane is `up`'s to repair: refusing the launch would make the repair impossible.
  return !finding.text.startsWith('no watch has run')
    && !finding.text.startsWith("the watch's heartbeat")
    && !finding.text.startsWith("the watch's pane is gone")
    && !finding.text.startsWith('the watch ended with its pane');
}

export const doctor: Command = (argv, io) => runDoctor(argv, io, realSources);
export default doctor;

function range(tested: { from: string; to: string }): string {
  return tested.from === tested.to ? tested.from : `${tested.from} to ${tested.to}`;
}

function versionFinding(name: string, printed: string, tested: { from: string; to: string }, cli: boolean): Finding {
  const shown = plainLine(printed);
  const verdict = versionVerdict(shown, tested);
  if (verdict === 'tested') return { level: 'ok', text: plainLine(`${name} ${shown}`) };
  if (verdict === 'unread') return { level: 'warn', text: plainLine(`${name}: its version can't be read from "${shown}"`) };
  // Only a CLI has screens to misread; herdr's version line says just where it sits.
  const tail = cli ? ": its screens are untested with this version; a seat that isn't read at launch is left out, never typed into" : '';
  return { level: 'warn', text: plainLine(`${name} ${shown} is ${verdict} than the tested ${range(tested)}${tail}`) };
}

// The approved bytes rule, as the watch applies it (budgets/checks.ts): a check whose file no
// longer hashes to the approval is not the approved check, and is not run.
function changedSinceApproval(check: ApprovedCheck): boolean {
  try {
    if (!statSync(check.path).isFile()) return true;
    return createHash('sha256').update(readFileSync(check.path)).digest('hex') !== check.hash;
  } catch {
    return true;
  }
}

function checkFindings(standing: Standing, team: TeamFile): Finding[] {
  if (standing.kind !== 'verified') return [];
  const approved = standing.record.approval.checks;
  return checkCommands(budgetsInForceOf(standing, team)).flatMap(({ account }) => {
    const known = approved?.[account];
    if (!known) {
      return [{ level: 'warn' as const, text: `the check for ${account} is unapproved; that account reads unknown` }];
    }
    if (changedSinceApproval(known)) {
      return [{ level: 'warn' as const, text: `the check for ${account} changed after approval and was not run; that account reads unknown` }];
    }
    return [];
  });
}

// The CLIs of the seats that spend an account: its own `account:` when the file names one, its
// vendor otherwise — the gate's resolution.
function clisOf(team: TeamFile, account: string): string[] {
  return team.seats.filter((seat) => (seat.account ?? seat.vendor) === account).map((seat) => seat.cli);
}

function figureOf(reading: CheckReading): string {
  if (reading.kind === 'spend') return `${reading.amount.toFixed(2)} ${reading.currency}`;
  return reading.windows.map((one) => `${one.window} ${one.used}% used`).join(', ');
}

/**
 * The budget checks, one line per account, plus the accounts nothing can read. The checks run
 * the way the watch runs them (RFC 0003 § 5): the approved command's file, hashed again before
 * it runs, in a clean environment with the watch's timeout. The raw output is parsed and
 * dropped — never printed, never logged, never written anywhere. Only the owner's `doctor` runs
 * a check, for the same reason the watch is the owner's: a check reads a vendor home. Any other
 * caller gets the same report without the readings, and the one line that says so.
 */
export function budgetCheckFindings(team: TeamFile, standing: Standing, root: string, sources: DoctorSources, caller: Caller): Finding[] {
  const budgets = budgetsInForceOf(standing, team);
  const findings: Finding[] = [];
  // An account nothing can read: its sources name the status line but no seat of its CLIs
  // ships a quota pattern for it, or they name a check with no command. A file that names a
  // `check` source without a command is refused on read; the guard is for the type, not the file.
  const patterns = overridesInForceOf(standing, team.project, root, sources.home).profiles;
  for (const [name, account] of Object.entries(budgets.accounts)) {
    const noPattern = account.sources.includes('status_line') && !clisOf(team, name).some((cli) => quotaWith(cli, patterns).some((one) => one.account === name));
    const noCommand = account.sources.includes('check') && account.check === null;
    if (noPattern || noCommand) findings.push({ level: 'warn', text: plainLine(`${name}: no pattern can read this account`) });
  }
  const commands = checkCommands(budgets);
  if (!isOwner(caller)) {
    if (commands.length) findings.push({ level: 'note', text: 'the budget checks were not run: only the owner runs them' });
    return findings;
  }
  // A check command is the owner's own privilege: it runs only from a record
  // this machine's key signed, never from bytes the verification refused.
  if (standing.kind !== 'verified') return findings;
  const run = sources.runCheck ?? runCommand;
  const now = sources.now().getTime();
  for (const { account } of commands) {
    const known = standing.record.approval.checks?.[account];
    const entry: BudgetAccount | undefined = budgets.accounts[account];
    // Unapproved and changed checks are said above, and never run.
    if (!known || !entry || changedSinceApproval(known)) continue;
    const text = run(known.path);
    if (text === null) {
      findings.push({ level: 'warn', text: plainLine(`the check for ${account} failed or timed out; that account reads unknown`) });
      continue;
    }
    const reading = parseOutput(entry, text, now);
    findings.push(
      reading
        ? { level: 'ok', text: plainLine(`the check for ${account} reads ${figureOf(reading)}`) }
        : { level: 'warn', text: plainLine(`the check for ${account} broke its output contract; that account reads unknown`) },
    );
  }
  return findings;
}

function overrideFindings(standing: Standing, team: TeamFile, root: string, home: string): Finding[] {
  const report = overridesInForceOf(standing, team.project, root, home);
  // A stored copy is not a gate. A difference against it is not a miss, and doctor does not
  // name the deleted command. A file that cannot be parsed still is.
  return report.problems.map((line): Finding => ({ level: 'miss', text: line }));
}

function approvalFindings(standing: Standing): Finding[] {
  // The live file is the record. "Never approved" and "the file differs" are not misses.
  // A legacy or refused record still names its own case.
  if (standing.kind === 'legacy') return [{ level: 'miss', text: LEGACY_LINE }];
  if (standing.kind === 'refused') return [{ level: 'miss', text: standing.why }];
  return [];
}

function cliFindings(cli: string, seats: Seat[], sources: DoctorSources): Finding[] {
  const names = seats.map((seat) => seat.name).join(', ');
  const profile = profileFor(cli);
  if (!profile) {
    return [{ level: 'warn', text: `${cli}: no launch profile in this version; \`up\` leaves out ${names}` }];
  }
  const printed = sources.version(profile.binary);
  if (printed === null) {
    return [{ level: 'miss', text: `install \`${profile.binary}\`: it is not on the PATH (${cli}: ${names})` }];
  }
  const findings = [versionFinding(profile.binary, printed, profile.tested, true)];
  const loggedIn = sources.loggedIn(profile);
  if (loggedIn === false) findings.push({ level: 'miss', text: `log in to ${cli}: \`${profile.loginHint}\`` });
  else if (loggedIn === null)
    findings.push({ level: 'note', text: `${cli}: the login is not checked in this version` });
  else findings.push({ level: 'ok', text: `${cli}: logged in` });

  for (const seat of seats) {
    const named = profile.modelOf(seat.launch);
    if (named === null) {
      const finding = modelFlagFinding(seat, profile);
      if (finding) findings.push(finding);
    } else if (modelDiffers(named, { model: seat.model, version: seat.version })) {
      // The same comparison `team check` and `status` use: a name in another word order, or a
      // version spelled inside the launch's model name, is the model the file declares.
      findings.push({
        level: 'warn',
        text: `${seat.name}: the launch starts ${named.model} ${named.version}, the file says ${declaredModel(seat)}`,
      });
    }
  }
  return findings;
}

// What `doctor` says of a seat whose launch names no model the profile knows. Silence only when
// the running seat will really be checked: the launch runs the CLI's own binary, bare — no path,
// no wrapper in front of it — and the profile's screen can name the model the file declares, so
// `status` and the watch would flag a seat that runs something else. Every other shape names
// what the owner can do: declare `model_from` for a launcher that chooses the model, add a model
// flag, or know that nothing checks the model. The last-used case keeps its warning, whose text
// another change rewords.
export function modelFlagFinding(
  seat: Pick<Seat, 'name' | 'cli' | 'launch' | 'display' | 'model' | 'version' | 'modelFrom'>,
  profile: Pick<Profile, 'binary' | 'lastUsedModel'>,
): Finding | null {
  const declared = declaredModel(seat);
  // The first word that is not a variable assignment: the program the launch runs. Bare — equal
  // to the binary's own name — is the one shape whose model flag is certainly the CLI's own.
  const first = launchBinary(seat.launch) ?? seat.launch.trim().split(/\s+/)[0] ?? '';
  const bare = first === profile.binary;
  const shows = canShowModel(seat);
  if (seat.modelFrom === 'launcher') {
    // The owner wrote the key and approved it: that is what makes a note enough, and the note
    // says the truth for the seat — checked on the running seat, or nothing checks it.
    return shows
      ? { level: 'note', text: plainLine(`${seat.name}: the model is chosen by its launcher; checked on the running seat`) }
      : {
          level: 'note',
          text: plainLine(`${seat.name}: the model is chosen by its launcher (declared in the file); this version can't read ${declared} on this CLI's screen, so nothing checks it`),
        };
  }
  if (bare && profile.lastUsedModel) {
    return { level: 'warn', text: plainLine(`${seat.name}: the launch names no model this version knows; the file says ${declared}`) };
  }
  if (bare) {
    return shows ? null : { level: 'warn', text: plainLine(`${seat.name}: no model flag, and this version can't read ${declared} on this CLI's screen: nothing checks that it runs it`) };
  }
  return {
    level: 'warn',
    text: plainLine(`${seat.name}: the launch runs ${first}, not ${profile.binary}, and names no model: if the launcher chooses the model, say so with model_from: launcher`),
  };
}

// The machine's own figures against the check in force, in the one case this reading cannot
// meet: the check asks for more free swap than the machine has in total. `up` refuses on that
// same comparison (`swapTotalProblem`), so the line tells the reading's own fact, in the reading's
// own words — on macOS the total moves with pressure, and a later run reads one of its own. A
// check that merely fails right now is `up`'s refusal beside it and the watch's finding; this
// report does not repeat that, and neither reading changes an exit.
export function machineFindings(team: TeamFile, root: string, sources: DoctorSources): Finding[] {
  const machine = sources.machine?.(root);
  if (!machine) return [];
  const problem = swapTotalProblem(machine, team.machine);
  return problem === null ? [] : [{ level: 'warn', text: plainLine(problem) }];
}

// The team's hold, when one stands (`team hold`). A `--` line like the readings around it: a
// hold is intended state, so it counts in nothing and blocks nothing, and a record past its
// `until` reads as no hold at all. The line names the way out, because doctor is where a
// reader goes to ask what is going on.
export function holdFindings(dir: string, sources: DoctorSources): Finding[] {
  const hold = liveHold(readState(dir), sources.now());
  return hold === null ? [] : [{ level: 'note', text: `${holdText(hold)} (\`team hold --release\` clears it)` }];
}

// `watch` is the watch values in force — the live file's under a verified standing — so a standing
// move the verdict either way.
function watchFindings(
  watch: TeamFile['watch'],
  dir: string,
  session: string,
  running: boolean | null,
  now: Date,
  sources: DoctorSources,
): Finding[] {
  const recorded = readState(dir).sessions[session]?.watch;
  if (!running) return [];
  if (!recorded) return [{ level: 'miss', text: `no watch has run for session ${session}: start \`team watch\`` }];
  const age = (now.getTime() - Date.parse(recorded.heartbeat)) / 1000;
  if (!(age <= 2 * watch.interval)) {
    return [
      {
        level: 'miss',
        text: `the watch's heartbeat is ${Math.round(age / 60)} min old (two intervals are ${(2 * watch.interval) / 60} min): start \`team watch\``,
      },
    ];
  }
  // The pane is the one the watch recorded. Herdr not answering is not a missing pane.
  if (recorded.pane && sources.watchPane && sources.watchAlive) {
    const there = sources.watchPane(session, recorded.pane, recorded.workspace);
    if (there === false) {
      if (recorded.pid !== undefined && sources.watchAlive(recorded.pid)) {
        const name = sources.processComm?.(recorded.pid) ?? 'process';
        return [{
          level: 'miss',
          text: `the watch's pane is gone and ${name} (pid ${recorded.pid}) is still running: stop it, then run \`team up\``,
        }];
      }
      return [{ level: 'miss', text: 'the watch ended with its pane: run `team up`' }];
    }
  }
  return [{ level: 'ok', text: 'the watch is running' }];
}

// The session already carries the project, so a seat whose name or label repeats either is a
// warning, never a refusal. One line per seat, naming the field.
export function seatNameFindings(team: TeamFile, session: string): Finding[] {
  const needles = [...new Set([team.project, session].filter((value) => value !== ''))];
  const findings: Finding[] = [];
  for (const seat of team.seats) {
    const hits = (['name', 'label'] as const).map((field) => ({
      field,
      found: needles.filter((needle) => seat[field].toLowerCase().includes(needle.toLowerCase())),
    })).filter((hit) => hit.found.length > 0);
    if (hits.length === 0) continue;
    const same = hits.length === 2 && hits[0]?.found.join('\0') === hits[1]?.found.join('\0');
    const which = same
      ? `its name and its label repeat ${quoted(hits[0]?.found ?? [])}`
      : hits.map((hit) => `its ${hit.field} repeats ${quoted(hit.found)}`).join(' and ');
    findings.push({ level: 'warn', text: plainLine(`${seat.name}: ${which}; the session already carries it`) });
  }
  return findings;
}

function quoted(values: string[]): string {
  return values.map((value) => `"${value}"`).join(' and ');
}

/** A waiting trust dialog, and a trust key already sent. A warn blocks `answer`, not the owner's `up`. */
function trustFindings(team: TeamFile, root: string, dir: string, session: string, sources: DoctorSources): Finding[] {
  if (!sources.paneText) return [];
  const seats = readState(dir).sessions[session]?.seats ?? {};
  const findings: Finding[] = [];
  for (const [name, recorded] of Object.entries(seats)) {
    const waiting = recorded.waiting;
    if (!waiting) continue;
    if (waiting.state === 'trust-sent-recovery') {
      findings.push({ level: 'warn', text: `${name}: trust sent; recovery required; a lead runs team up` });
      continue;
    }
    if (waiting.state !== 'waiting-owner' || waiting.classification !== 'trust') continue;
    const pane = recorded.pane;
    if (!pane) {
      findings.push({ level: 'warn', text: `${name}: waiting at trust; its pane can't be read` });
      continue;
    }
    const screen = sources.paneText(session, pane);
    if (screen === undefined) {
      findings.push({ level: 'warn', text: `${name}: waiting at trust; its pane can't be read` });
      continue;
    }
    const cli = cliOf(team, name, recorded);
    const profile = cli ? profileFor(cli) : null;
    const kind = profile ? readScreen(profile.cli, screen).kind : 'unknown';
    if (kind !== 'trust') {
      findings.push({ level: 'warn', text: `${name}: waiting at trust; the pane is not the trust dialog` });
      continue;
    }
    findings.push({ level: 'note', text: `${name}: waiting for owner at trust` });
    const printed = profile ? sources.version(profile.binary) : null;
    const inRange = printed && profile
      ? profile.answers.find((item) => versionMatches(item, printed))
      : undefined;
    const eligible = inRange && profile ? isEligible(profile.cli, inRange) : false;
    if (!eligible) findings.push({ level: 'warn', text: `${name}: waiting at trust; this version has no trust answer` });
    if (inRange) {
      const shown = extractFolder(inRange.extract, screen);
      const landed = shown ? showLanding(shown) : null;
      const lobby = showLanding(lobbyOf(sources.home, root, { ...team, session }));
      const project = showLanding(root);
      // A lead may be showing the lobby or the project: both are folders `up` leaves a running
      // lead in. The shown spelling must be that folder itself, not something that only
      // canonicalises to it: `answer` refuses a trailing slash, another case, `//` or `/./`.
      const atLobby = Boolean(landed && lobby && landed === lobby && shown === lobby);
      const atProject = isLeadSeat(team, name) && Boolean(landed && project && landed === project && shown === project);
      if (!atLobby && !atProject) {
        findings.push({ level: 'warn', text: `${name}: waiting at trust; the folder is not the lobby` });
      }
    }
  }
  return findings;
}

// The repair that relaunches one seat `up` leaves as it is: `up` never restarts a ready seat,
// so a line that names `up` alone names a command that skips the seat. For an orchestrator or
// an operator, `team remove <seat> --keep` is a swap: it never marks the lead stopped
// in the file, and it is the owner's or an authorised swapper's; the line still offers the
// whole-team sequence, which every caller of these lines may follow. For every other seat — stop it, keep it in the
// file, add it again: the add launches it fresh, which is what records the process, writes the
// rules file and starts the seat in the team's lobby — or the whole team at once.
export const relaunch = (team: Pick<TeamFile, 'orchestrator' | 'operator'>, name: string): string =>
  relaunchRepair(team, name, 'markdown');

// A seat the state records from a launch that predates the process identity: neither the watch
// nor `status` can tell whether its pane still holds what team launched, and nothing would
// notice a restore. One note per such seat, naming `team register <seat>`: it completes the
// record where the seat stands — the id and the process identity a launch would have written,
// without relaunching anything. A record whose launch wrote the process but not the id draws the
// sibling note: `team seats` shows `-` in its id column, and the same registration writes it. A
// lead's own seat draws neither note: it is the seat reading this line, and the register repair
// is never shown to it. A seat the state doesn't record was not left running by this session,
// and a stopped seat is never started by `up`: neither is told.
function identityFindings(team: TeamFile, dir: string, session: string): Finding[] {
  const recorded = readState(dir).sessions[session]?.seats ?? {};
  const findings: Finding[] = [];
  for (const seat of team.seats) {
    const held = recorded[seat.name];
    if (seat.stopped || !held) continue;
    // An orchestrator or an operator is the seat this line is read from: telling it to register
    // its own pane is a whole-team act dressed as a repair, and is never shown.
    if (isLeadSeat(team, seat.name)) continue;
    if (!held.launched) {
      findings.push({
        level: 'note',
        text: `${seat.name}: launched before team recorded its process; run \`team register ${seat.name}\` to record its process`,
      });
      continue;
    }
    // The launch recorded the process and not the seat's id, so the registry row shows `-` where
    // the id goes. `team register` writes the id from the same reads, with nothing relaunched.
    if (held.id === undefined) {
      findings.push({
        level: 'note',
        text: `${seat.name}: launched before team recorded its id; run \`team register ${seat.name}\` to record it`,
      });
    }
  }
  return findings;
}

// A lead `team remove <lead> --keep` stopped for a swap and nothing started again: the file still
// names it the lead, the state no longer records it running. Said as the swap it is, with the one
// command that ends it, so the gap never reads as a lost orchestrator. A record whose seat runs
// again (an `up` relaunched it) is stale and says nothing.
export function swapFindings(team: TeamFile, dir: string, session: string): Finding[] {
  const current = readState(dir).sessions[session];
  const findings: Finding[] = [];
  for (const [name, swap] of Object.entries(current?.swapping ?? {})) {
    if (current?.seats[name] || !team.seats.some((seat) => seat.name === name)) continue;
    findings.push({ level: 'warn', text: `${name}: stopped for a swap by ${swap.by} at ${swap.at}; run \`team add ${name}\` to start its new agent` });
  }
  return findings;
}

// A seat whose file still carries the "0" init writes before the owner fills the release
// number. The launch no longer stops on it (the model family is still checked), so this is
// information: what the running seat really runs, and the one edit that pins it. Said only
// when the seat is live in a pane whose screen names a model of the declared family. When
// the screen shows another family than the file declares, warn with the mismatch the launch
// check will print, naming the edit to both model and version so the first upgrade edit covers it.
function placeholderVersionFindings(team: TeamFile, dir: string, session: string, sources: DoctorSources): Finding[] {
  if (!sources.paneText) return [];
  const recorded = readState(dir).sessions[session]?.seats ?? {};
  const findings: Finding[] = [];
  for (const seat of team.seats) {
    if (seat.stopped || seat.version !== '0') continue;
    const held = recorded[seat.name];
    if (!held?.pane) continue;
    const screen = sources.paneText(session, held.pane);
    if (screen === undefined) continue;
    const running = seatModel(seat, screen);
    if (!running) continue;
    if (running.model === seat.model) {
      findings.push({
        level: 'note',
        text:
          `${seat.name}: runs ${running.model} ${running.version}; the file's version "0" is the placeholder init writes — ` +
          `write "${running.version}" into the file`,
      });
    } else {
      findings.push({
        level: 'warn',
        text:
          `${seat.name}: runs ${running.model} ${running.version}; the file says ${seat.model} 0 — ` +
          `write model: "${running.model}" and version: "${running.version}" into the file`,
      });
    }
  }
  return findings;
}

function cliOf(team: TeamFile, name: string, recorded: SeatState): string | null {
  return team.seats.find((seat) => seat.name === name)?.cli
    ?? team.seats.find((seat) => seat.name === recorded.temporary?.like)?.cli
    ?? null;
}

/** The file's deprecated keys as doctor's `the file, line N:` warnings: the message and the
 *  repair `team check` prints. 0.3.5's approve line sent users to `team doctor` for the rest,
 *  so a key that still loads but grants nothing is reported here too. */
function deprecatedFileWarnings(
  deprecations: readonly Deprecation[],
  file: string,
): { line: number; message: string }[] {
  return deprecations.map((deprecation) => ({
    line: deprecation.line,
    message: `${deprecation.message}; repair: ${deprecation.repair.replace('{file}', file)}`,
  }));
}

export function doctorFindings(
  team: TeamFile,
  root: string,
  dir: string,
  session: string,
  sources: DoctorSources,
  warnings: { line: number; message: string }[],
  /** The one read of the approval store, done by the caller — `runDoctor`, `up` or `add`. */
  standing: Standing,
  /** The file whose seats are judged — the live file, or for `add` the team about to run, whose
   *  `stopped` mark is already cleared. */
  approved: TeamFile = team,
  /** The budget-check lines, which only the report runs: `up` and `add` scan, they never run a check. */
  budgetChecks: Finding[] = [],
  /** The per-seat launch-line findings. `up` and `add` hand them in so a seat's own line can leave
   *  that seat out before its workspace is made; the report prints them as they come. */
  launchLines: Finding[] = [],
  /** Registry wording when the team was read from the registry; file wording for a real team.yaml. */
  rulesOrigin: RulesOrigin = 'file',
): Finding[] {
  const findings: Finding[] = warnings.map((warning) => ({
    level: 'warn',
    text: `the file, line ${warning.line}: ${warning.message}`,
  }));
  findings.push(...seatNameFindings(team, session));

  findings.push(
    ...approvalFindings(standing),
    ...otherMatchingStores(root, sources.home).map((name): Finding => ({ level: 'note', text: otherStoreNote(name) })),
    ...overrideFindings(standing, team, root, sources.home),
    ...checkFindings(standing, team),
    ...budgetChecks,
  );
  // The rules file each message seat runs by, checked against the live file's text. A file
  // that differs is warned about, never rewritten here. A stopped seat is not checked: its
  // file is written at the launch that starts it again. The file is written at a delivery,
  // and a delivery happens only at a launch — which `up` skips for a ready seat, so the line
  // names `team reload`, which closes a ready seat and launches the file's line. The check
  // runs only once a record exists, so a folder no launch has delivered to grows no warning.
  if (standing.kind === 'verified') {
    for (const seat of approved.seats) {
      if (seat.stopped || (profileFor(seat.cli)?.rulesMode ?? 'message') !== 'message') continue;
      const path = rulesFilePath(approved.project, root, sources.home, seat.name);
      if (path === null) continue;
      const check = checkRulesFile(path, rulesOf(approved, seat, root, undefined, rulesOrigin), rulesOrigin);
      if (!check.ok) findings.push({ level: 'warn', text: `${seat.name}: ${check.what}; run team reload ${seat.name}` });
    }
  }

  const herdr = sources.herdrVersion();
  const running = herdr === null ? null : sources.sessionRunning(session);
  if (herdr === null) findings.push({ level: 'miss', text: 'install herdr: it is not on the PATH' });
  else {
    findings.push(versionFinding('herdr', herdr, HERDR_TESTED, false));
    if (running === null) findings.push({ level: 'miss', text: "herdr doesn't answer" });
    else findings.push({ level: 'note', text: `session ${session} is ${running ? 'running' : 'not running'}` });
  }

  const launched = team.seats.filter((seat) => !seat.stopped);
  for (const cli of new Set(launched.map((seat) => seat.cli))) {
    findings.push(
      ...cliFindings(
        cli,
        launched.filter((seat) => seat.cli === cli),
        sources,
      ),
    );
  }

  findings.push(...launchLines);

  findings.push(...identityFindings(team, dir, session));
  findings.push(...swapFindings(team, dir, session));
  findings.push(...placeholderVersionFindings(team, dir, session, sources));

  findings.push(...watchFindings(watchInForceOf(standing, team), dir, session, running, sources.now(), sources));
  findings.push(...trustFindings(team, root, dir, session, sources));

  const lobby = lobbyOf(sources.home, root, { ...team, session });
  // The same walk `up` and `add` use before a launch into the lobby: a path a shipped CLI
  // reads at start is a miss. A file a CLI only writes is named afterwards, so an owner
  // still sees whose lock is sitting in the folder.
  const gate = verifyLobby(sources.home, { create: false, getuid: sources.getuid, reads: shippedStartupReads(), lobby });
  if (!gate.ok) {
    findings.push({ level: 'miss', text: gate.text });
  } else if ('missing' in gate) {
    findings.push({ level: 'ok', text: `the lobby ${lobby}: will be created at the first launch` });
  } else {
    findings.push({ level: 'ok', text: `the lobby ${lobby}: verified` });
    const owners = lobbyFileOwners();
    for (const rel of shippedLobbyFiles()) {
      const full = join(lobby, rel);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      const whose = owners.get(rel);
      if (whose !== undefined) findings.push({ level: 'ok', text: `the lobby ${lobby}: ${rel} is ${whose.join("'s and ")}'s` });
    }
  }

  const oldLobby = derivedLobby(team);
  if (oldLobby) {
    const oldLogical = resolve(root, oldLobby);
    let oldStat: { isSymbolicLink(): boolean; isDirectory(): boolean } | null = null;
    let oldReadError: string | null = null;
    try {
      oldStat = lstatSync(oldLogical);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') oldReadError = String(code ?? (err as { message?: string }).message ?? 'unknown');
    }
    if (oldReadError) {
      findings.push({ level: 'warn', text: `the old lobby ${oldLobby}: cannot read ${oldLogical}: ${oldReadError}` });
    } else if (oldStat?.isSymbolicLink()) {
      findings.push({ level: 'warn', text: `the old lobby ${oldLobby}: is a symbolic link; can't tell if it may be removed` });
    } else if (oldStat?.isDirectory()) {
      const landed = canonicalLanding(oldLogical);
      if (landed.error) {
        findings.push({ level: 'warn', text: `the old lobby ${oldLobby}: cannot read ${landed.error.path}: ${landed.error.code}` });
      } else {
        const oldLanding = landed.landing;
        const recordedSeats = Object.entries(readState(dir).sessions[session]?.seats ?? {});
        const getAgents = sources.agentList ?? agentList;
        const liveList = running ? getAgents(session) : null;
        if (!running || liveList === null) {
          findings.push({ level: 'warn', text: `the old lobby ${oldLobby}: can't tell if live seats are using it: ${!running ? 'no session running' : "herdr doesn't answer"}` });
        } else {
          const livePanes = new Set(liveList.map((a) => a.pane));
          const activeSeats = recordedSeats.filter(([, s]) => {
            const isRecovery = s.waiting !== undefined;
            const isLive = Boolean(s.pane && livePanes.has(s.pane));
            return isLive || isRecovery;
          });
          // Where a seat really started. A recorded start_cwd says it. A seat with none is read
          // from the file the way the release before the lobby started it: a worktree-mode seat
          // in cwd "." waited in this old lobby, and every other seat — shared, or with a cwd of
          // its own — started elsewhere, so it never sat in the folder and is not named. A seat
          // the file no longer names is unknown: the line keeps its hold on the folder rather
          // than clear it wrongly.
          const inOld: string[] = [];
          const unknown: string[] = [];
          for (const [name, s] of activeSeats) {
            if (s.start_cwd) {
              // The team's lobby and the project root are not this old folder. A lead recorded
              // in either is not told to move.
              if (s.start_cwd === oldLanding) inOld.push(name);
              continue;
            }
            const declared = team.seats.find((seat) => seat.name === name);
            if (!declared) unknown.push(name);
            else if (declared.mode !== 'shared' && declared.cwd === '.') inOld.push(name);
          }
          if (inOld.length > 0) {
            const who = inOld.length === 1 ? `seat ${inOld[0]} started in it` : `seats ${inOld.join(', ')} started in it`;
            const move = inOld.length === 1
              ? `run ${relaunch(team, inOld[0]!)} to move it into the lobby`
              : inOld.some((name) => isLeadSeat(team, name))
                ? 'run `team down` then `team up` to move them into the lobby (to restart the whole team)'
                : 'run `team remove <seat> --keep` then `team add <seat>` for each to move it into the lobby (or `team down` then `team up` for the whole team)';
            findings.push({ level: 'warn', text: `the old lobby ${oldLobby}: ${who}; ${move}, then remove the folder` });
          } else if (unknown.length > 0) {
            findings.push({
              level: 'warn',
              text: `the old lobby ${oldLobby}: where seat ${unknown.join(', ')} started is not recorded and the file no longer names it; stop it before removing the folder`,
            });
          } else {
            findings.push({ level: 'ok', text: `the old lobby ${oldLobby}: may be removed` });
          }
        }
      }
    }
  }

  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index]!;
    findings[index] = { level: finding.level, text: plainLine(finding.text) };
  }

  // The legacy note is told only while the file really is legacy: once the owner has written the
  // absolute trust entries, a note that still says "migrate" would name a step already taken.
  if (!team.trust || team.trust.length === 0 || isLegacyTrust(team.trust)) {
    const fromText = oldLobby ? `from ${plainLine(oldLobby)} to ${plainLine(lobby)}` : `to ${plainLine(lobby)}`;
    findings.push({
      level: 'note',
      text: plainText(`the file is legacy: migrate ${fromText} by writing:\n${migrationText({ ...team, session }, root, sources.home)}`),
    });
  }
  return findings;
}

/** The project's `owner/repo` from a github `origin` remote URL, or null — `git@github.com:o/r.git`
 *  and `https://github.com/o/r` (a trailing slash, a `.git` suffix) are the same repository, and any
 *  other host is not one this check can speak about. */
export function githubOrigin(text: string): string | null {
  const value = text.trim().replace(/\/+$/, '');
  const found = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!found) return null;
  const repo = (found[2] as string).replace(/\.git$/, '');
  return repo === '' ? null : `${found[1]}/${repo}`;
}

/** The first line a failed CLI printed, cleaned for the report: the missing step the CLI itself
 *  names, kept short. Null when it printed nothing this can repeat. */
function saidLine(read: CommandRead): string | null {
  for (const stream of [read.stderr, read.stdout]) {
    const line = stream.split('\n').map((text) => text.trim()).find((text) => text !== '');
    if (line !== undefined) return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  }
  return null;
}

/**
 * `team doctor --jules`: whether the Jules CLI, the owner's Google login, the GitHub link and this
 * project's repository are all in place, and which step is missing when they are not. Two reads —
 * `jules remote list --repo` (the login and the GitHub link answer in its status, the connected
 * repositories in its lines) and `git remote get-url origin` (which repository this project means)
 * — and nothing else: no login, no session, no API key, no write.
 */
export function doctorJulesFindings(root: string, sources: DoctorSources): Finding[] {
  const findings: Finding[] = [];
  if (!sources.onPath('jules')) {
    findings.push({ level: 'miss', text: plainLine("install the Jules CLI: `npm install -g @google/jules` — the owner's step") });
    return findings;
  }
  const answer = sources.command?.('jules', ['remote', 'list', '--repo']) ?? null;
  if (answer === null || answer.status !== 0) {
    // One line names both: the refusal is repeated, never parsed, so which half is missing is the
    // CLI's own line to say. The repair is the same either way.
    findings.push({ level: 'miss', text: plainLine("log in to Jules and link it to GitHub: `jules login` — the owner's step") });
    const said = answer === null ? null : saidLine(answer);
    if (said !== null) findings.push({ level: 'note', text: plainLine(`jules said: ${said}`) });
    return findings;
  }
  findings.push({ level: 'ok', text: plainLine('jules: logged in, with GitHub linked') });
  const origin = sources.command?.('git', ['-C', root, 'remote', 'get-url', 'origin']) ?? null;
  const repo = origin !== null && origin.status === 0 ? githubOrigin(origin.stdout) : null;
  if (repo === null) {
    findings.push({ level: 'note', text: plainLine("the project's github repository was not read from the origin remote") });
    return findings;
  }
  const connected = answer.stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (connected.includes(repo)) findings.push({ level: 'ok', text: plainLine(`jules: ${repo} is connected`) });
  else findings.push({ level: 'miss', text: plainLine(`connect ${repo} to Jules: https://jules.google.com — the owner's step`) });
  return findings;
}

export function doctorLoginFindings(team: TeamFile, sources: DoctorSources): Finding[] {
  const clis: string[] = [];
  for (const seat of team.seats) {
    if (!clis.includes(seat.cli)) clis.push(seat.cli);
  }
  const findings: Finding[] = [];
  for (const cli of clis) {
    const profile = profileFor(cli);
    if (!profile) {
      findings.push({ level: 'note', text: plainLine(`${cli}: no launch profile in this version`) });
      continue;
    }
    const loggedIn = sources.loggedIn(profile);
    if (loggedIn === false) {
      findings.push({ level: 'miss', text: plainLine(`log in to ${cli}: \`${profile.loginHint}\``) });
    } else if (loggedIn === null) {
      findings.push({ level: 'note', text: plainLine(`${cli}: the login is not checked in this version`) });
    } else {
      findings.push({ level: 'ok', text: plainLine(`${cli}: logged in`) });
    }
  }
  return findings;
}

import { contextLine, hasJsonFlag, pluralCount, renderFinding, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';
import { NOT_PRETENDED, NOT_PRETENDED_ENTRIES } from '../permissions/must-not-pretend.ts';

export async function runDoctor(argv: string[], io: Io, sources: DoctorSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['session', 'file'], ['login', 'jules', 'json']);
  const json = hasJsonFlag(argv);
  if (args.error || args.rest.length) {
    const why = plainText(args.error ?? `unexpected "${args.rest[0]}"`);
    if (json) {
      writeJsonError(io, 'doctor.invocation', why, null);
    } else {
      out.stderr(`team doctor: ${why}\n${USAGE}`);
    }
    // exit: doctor.invocation
    return 2;
  }
  if (args.flags.has('login') && args.flags.has('jules')) {
    // The two focused modes answer different questions and have no meaningful order: asking both
    // is an invocation error, refused before the file or any source is read.
    out.stderr(`team doctor: --login and --jules answer different questions; ask one at a time\n${USAGE}`);
    // exit: doctor.both-modes
    return 2;
  }
  let home: string | undefined;
  try {
    home = sources?.home;
  } catch {
    // Tests may supply a proxy that throws on any read to prove no source was touched before validation.
  }
  const loaded = readTeamConfig(io.cwd, {
    ...(args.values.file ? { file: args.values.file } : {}),
    ...(home ? { home } : {}),
    // The session this run addresses: the placement check reads that session's recorded lobby.
    ...(args.values.session !== undefined ? { session: args.values.session } : {}),
  });
  if (!loaded.ok) {
    if (json) {
      const id = loaded.errors[0]?.message.includes('not inside a git repository')
        ? 'doctor.not-a-repo'
        : loaded.errors.some(isParseError)
          ? 'doctor.file-invalid'
          : 'doctor.file';
      const msg = loaded.errors.map((p) => `${p.line ? `line ${p.line}: ` : ''}${plainText(p.message)}`).join('; ');
      writeJsonError(io, id, msg, null);
    } else {
      for (const problem of loaded.errors) {
        out.stderr(`team doctor: ${problem.line ? `line ${problem.line}: ` : ''}${plainText(problem.message)}\n`);
      }
    }
    // exit: doctor.not-a-repo
    // exit: doctor.file
    // exit: doctor.file-invalid
    return 2;
  }
  const { team, root } = loaded;
  const session = args.values.session ?? team.session;
  // The one read of the approval store: every finding below derives from it.
  const standing = sources.standing?.(root) ?? approvalStanding(root, sources.home);
  const loginOnly = args.flags.has('login');
  const julesOnly = !loginOnly && args.flags.has('jules');
  // A focused report (`--login`, `--jules`) carries only its own findings.
  const focused = loginOnly || julesOnly;
  const findings = loginOnly
    ? doctorLoginFindings(team, sources)
    : args.flags.has('jules')
    ? doctorJulesFindings(root, sources)
    : [
        ...doctorFindings(
          team,
          root,
          dirname(loaded.path),
          session,
          sources,
          [
            ...loaded.warnings,
            ...deprecatedFileWarnings(loaded.deprecations ?? [], shownTeamFile(loaded.path, root)),
          ],
          standing,
          undefined,
          budgetCheckFindings(team, standing, root, sources, callerOf(io)),
          launchLineFindings(team, root, { onPath: (binary) => sources.onPath(binary), home: sources.home }),
          rulesOriginOf(loaded.source),
        ),
        // The machine's own reading, last: the one check no machine can ever meet here.
        ...machineFindings(team, root, sources),
        // The team's hold, when one stands: the last line before the summary.
        ...holdFindings(dirname(loaded.path), sources),
      ];

  const missing = findings.filter((finding) => finding.level === 'miss').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  // The same rule `up` and `add` refuse on. A missing watch is `miss` but blocks nothing, so the
  // refusal line is printed only when at least one finding blocks, and counts those. `--jules`
  // findings never reach a launch: `up` and `add` run the full report, which does not read Jules.
  const blockers = julesOnly ? 0 : findings.filter(blocksLaunch).length;

  if (json) {
    writeJson(io, 'team.doctor', {
      format: 1,
      project: plainLine(team.project),
      session: plainLine(session),
      login_only: loginOnly,
      jules_only: julesOnly,
      findings: findings.map((finding) => ({
        level: finding.level,
        text: finding.text,
        blocks_launch: !julesOnly && blocksLaunch(finding),
      })),
      summary: {
        missing,
        warnings,
        blockers,
      },
      ...(focused
        ? {}
        : {
            must_not_pretend: NOT_PRETENDED_ENTRIES.map((entry) => ({
              text: entry.text,
              ref: entry.ref,
            })),
          }),
    });
  } else {
    const style = ttyStyle(io);
    const warnText = pluralCount(warnings, 'warning');
    let summary = `team doctor: ${missing} missing, ${warnText}`;
    if (!missing) summary = `team doctor: nothing missing, ${warnText}`;
    else if (blockers) summary += `: ${blockers} of them block \`up\` and \`add\``;

    const lines: string[] = [];
    if (!focused) lines.push(contextLine(team.project, session));
    for (const finding of findings) lines.push(renderFinding(finding, style, sources.home));
    lines.push(summary);
    if (!focused) lines.push(...NOT_PRETENDED);

    const rendered = `${lines.join('\n')}\n`;
    if (style.enabled) {
      io.stdout(rendered);
    } else {
      out.stdout(rendered);
    }
  }
  // exit: doctor.clear
  // exit: doctor.missing
  return missing ? 1 : 0;
}
