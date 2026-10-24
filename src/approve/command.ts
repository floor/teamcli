import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { approvedFingerprints, approvalOf, ceilingsOf } from './approval.ts';
import { checkDrift, resolveChecks } from '../budgets/checks.ts';
import { formatDiff } from './diff.ts';
import { compare, describe, fingerprints } from './fingerprint.ts';
import { approveFingerprint, ownerAuthorized } from './owner-token.ts';
import { readArgs } from '../args.ts';
import { callerOf, describeCaller, detachedRefusal, isOwner, walkCaller, type Caller } from '../caller.ts';
import { delegateGate, logDelegated, type DelegateSources } from '../delegate.ts';
import { TEAM_FILE, placedProblems } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { grantGate, logGranted } from '../grant.ts';
import type { Command, Io } from '../io.ts';
import { logLine } from '../log.ts';
import { OVERRIDE_CHANGED, overrideFile } from '../profiles/overrides.ts';
import { approvalStanding, LEGACY_LINE, readApproval, storePath, writeApproval, type Ceilings } from '../store/store.ts';
import { keyFingerprint, keyOf, keyRefusal, keyState, recordedGeneration } from '../store/keys.ts';

// What a read of the terminal found: a canonical-mode line is queued (`waiting`), nothing is
// (`empty`), or the terminal could not be read at all (`unreadable`). Only `empty` lets approve
// write; the other two refuse — a check that could not look must never approve blind.
export type Waiting = 'waiting' | 'empty' | 'unreadable';

// What `approve` reads from outside the file, so tests can stand in for it.
export type ApproveSources = {
  // The owner's answer to a question on the terminal, or null when there is none.
  ask(question: string): Promise<string | null>;
  // What is queued on the terminal the answer would have come from — the command's own
  // standard input. See probeWaiting for exactly what is read.
  waiting(): Waiting;
  now(): Date;
  home: string;
  // The gate a non-owner caller is judged by, as every delegated command asks it. Left out,
  // the real one; `delegate` carries a test's reads into it.
  gate?: typeof delegateGate;
  delegate?: DelegateSources;
  /** The grant read. Left out, the real one. */
  grantGate?: typeof grantGate;
};

const NONBLOCKING = constants.O_RDONLY | constants.O_NONBLOCK;

/** One open, non-blocking read side of `path`, or null when it cannot be opened or is not the
 *  device `fd` is attached to. The rdev check is what makes the answer about the caller's own
 *  terminal: an entry that opens but is another device is refused, not read. */
function openVerifiedDevice(path: string, fd: number): number | null {
  let opened: number | null = null;
  try {
    opened = openSync(path, NONBLOCKING);
    const device = fstatSync(opened);
    const stdin = fstatSync(fd);
    if (device.isCharacterDevice() && device.rdev === stdin.rdev) return opened;
  } catch {
    /* fall through to the close */
  }
  if (opened !== null) closeSync(opened);
  return null;
}

/** An open, non-blocking read side of the device this process's standard input is attached to,
 *  or null when no such device can be found and verified. */
function openStdinDevice(): number | null {
  // Linux names the device: /proc/self/fd/0 is a link to its node (`/dev/pts/3`).
  try {
    const link = readlinkSync('/proc/self/fd/0');
    if (link.startsWith('/')) {
      const found = openVerifiedDevice(link, 0);
      if (found !== null) return found;
    }
  } catch {
    /* no /proc: the scan below */
  }
  if (process.platform !== 'darwin') return null;
  // macOS has neither /proc nor a link that names the device (/dev/fd/0 and /dev/stdin answer
  // `fd/0`, not a path), so the device is found by its rdev — unique to one terminal — among
  // /dev's ttys entries.
  try {
    fstatSync(0);
  } catch {
    return null;
  }
  for (const name of readdirSync('/dev')) {
    if (!name.startsWith('ttys')) continue;
    const found = openVerifiedDevice(`/dev/${name}`, 0);
    if (found !== null) return found;
  }
  return null;
}

/**
 * What is queued on the terminal this command's own standard input is attached to.
 *
 * The device, never a second open of fd 0: opening /dev/fd/0 or /dev/stdin duplicates fd 0's
 * file description — the blocking flag included — so an O_NONBLOCK read of the duplicate still
 * blocks (macOS run: empty terminal, 2 s alarm, the read never returned). Linux answers from
 * /proc; macOS by the rdev scan above; the description this opens is fresh, so O_NONBLOCK
 * applies to this read alone, and its rdev is verified against fd 0's before anything is read.
 *
 * One readSync of up to 4096 bytes asks for a canonical-mode line. A queued line is returned
 * and consumed: no call in this runtime peeks without consuming, so a non-consuming check is
 * not possible, and reading is acceptable only because the run this feeds refuses and writes
 * nothing (runs: cooked, `9\n` queued → read returns `9\n`, a second read is EAGAIN — the line
 * is gone; cooked, `9` queued with no Enter → EAGAIN, because cooked mode holds no partial
 * line, so a half-typed line is invisible to this check and to any question alike; raw mode
 * (`stty raw`), where the terminal hands keystrokes over at once, makes the same `9` readable
 * → `waiting`). EAGAIN is `empty`. A 0-byte read — the terminal gone — and every other
 * failure, a device that cannot be found or verified included, are `unreadable`: the caller
 * refuses rather than approves without having looked. What this cannot see is input that
 * arrives after the read and before the write; the docs say so in one sentence. The walk above
 * has already refused every caller without a terminal.
 */
export function probeWaiting(): Waiting {
  const fd = openStdinDevice();
  if (fd === null) return 'unreadable';
  try {
    const line = Buffer.alloc(4096);
    try {
      return readSync(fd, line, 0, line.length, null) > 0 ? 'waiting' : 'unreadable';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'EAGAIN' || code === 'EWOULDBLOCK' ? 'empty' : 'unreadable';
    }
  } finally {
    closeSync(fd);
  }
}

export const realSources: ApproveSources = {
  async ask(question) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await terminal.question(question);
    } catch {
      return null;
    } finally {
      terminal.close();
    }
  },
  waiting: probeWaiting,
  now: () => new Date(),
  home: homedir(),
};

export const USAGE = 'Usage: team approve [--show] [--confirm] [--file <path>]\n';

export const approve: Command = (argv, io) => runApprove(argv, io, realSources);
export default approve;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

// The store must stay out of the project and of every folder a seat may work in.
function expandTrustEntry(pattern: string, root: string, home: string): string {
  const trimmed = pattern.replace(/\/?\*$/, '');
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return resolve(trimmed.replace(/^~(?=$|\/)/, home));
  return resolve(root, trimmed);
}

function storeProblem(store: string, root: string, team: TeamFile, home: string): string | null {
  const place = real(dirname(store));
  const folders = [root, ...team.trust.map((pattern) => expandTrustEntry(pattern, root, home))];
  const holder = folders.map(real).find((folder) => inside(place, folder) || inside(store, folder));
  return holder === undefined ? null : `the approval store ${store} is inside ${holder}, where seats work`;
}

function ceilingsLine(ceilings: Ceilings): string {
  const vendors = Object.entries(ceilings.vendors).map(([vendor, count]) => `${vendor} ${count}`);
  return [`${ceilings.seats} seats at most`, `${ceilings.temporary} temporary`, ...vendors].join(', ');
}

export async function runApprove(argv: string[], io: Io, sources: ApproveSources): Promise<number> {
  const args = readArgs(argv, ['file'], ['show', 'confirm']);
  if (args.error || args.rest.length) {
    io.stderr(`team approve: ${args.error ?? `unexpected "${args.rest[0]}"`}\n${USAGE}`);
    // exit: approve.invocation
    return 2;
  }

  // A non-owner's `--file` is not opened. `--show` is the exception: anyone may read the file
  // it names, and that path returns before the caller gate. The owner token is matched against
  // this folder's own file, so a foreign path is not what a token signs.
  const walked = walkCaller(io);
  const foreignFile =
    args.values.file !== undefined && resolve(io.cwd, args.values.file) !== resolve(io.cwd, TEAM_FILE);
  const loadFile = !foreignFile || args.flags.has('show') || isOwner(walked) ? args.values.file : undefined;
  const loaded = readTeamConfig(io.cwd, { ...(loadFile ? { file: loadFile } : {}), home: sources.home });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team approve: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: approve.not-a-repo
    // exit: approve.file
    // exit: approve.file-invalid
    return 2;
  }
  // Validate the text load just read, against the same home and root the load used. A second read
  // could store an edit under the first read's fingerprints.
  const checked = validateTeamFile(loaded.text, { home: sources.home, root: loaded.root });
  if (!checked.ok) {
    for (const problem of checked.errors) {
      io.stderr(`team approve: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    // exit: approve.revalidate
    return 2;
  }
  const placed = placedProblems(checked.team, loaded.root, sources.home);
  if (placed.length) {
    for (const problem of placed) io.stderr(`team approve: ${problem.message}\n`);
    // exit: approve.placed
    return 2;
  }
  const { team } = checked;
  const { root, path } = loaded;
  const text = loaded.text;
  for (const warning of checked.warnings) {
    if (
      warning.message.startsWith('`coordinator:` is now `leads: true`') ||
      warning.message.startsWith('watch.quota_marks is now budgets.marks') ||
      warning.message.startsWith('budgets.marks replaces watch.quota_marks')
    ) {
      continue;
    }
    io.stderr(`team approve: warning, line ${warning.line}: ${warning.message}\n`);
  }

  const store = storePath(team.project, root, sources.home);
  const live = overrideFile(team.project, root, sources.home);
  if (live.problems.length) {
    for (const problem of live.problems) io.stderr(`team approve: ${problem}\n`);
    // exit: approve.overrides
    return 2;
  }
  const problem = storeProblem(store, root, team, sources.home);
  if (problem) {
    io.stderr(`team approve: ${problem}\n`);
    // exit: approve.store
    return 1;
  }

  const resolved = resolveChecks(team, root, process.env.PATH ?? '');
  if (!resolved.ok) {
    io.stderr(`team approve: the check for ${resolved.account} cannot be resolved\n`);
    // exit: approve.check
    return 1;
  }
  let previous: ReturnType<typeof readApproval> = null;
  try {
    previous = readApproval(store);
  } catch {
    // A malformed record is named by the standing below; nothing is diffed against it.
  }
  const standing = approvalStanding(root, sources.home);
  const ceilings = ceilingsOf(team);
  const seats = team.seats.length;

  if (standing.kind === 'legacy' || standing.kind === 'refused') {
    io.stdout(`Note: ${standing.kind === 'legacy' ? LEGACY_LINE : standing.why}\n`);
  }
  if (previous === null) {
    io.stdout(`${path}: never approved on this machine. The whole file:\n\n`);
    io.stdout(
      `${text
        .replace(/\n$/, '')
        .split('\n')
        .map((line, index) => (line.length ? `  ${index + 1}: ${line}` : `  ${index + 1}:`))
        .join('\n')}\n\n`,
    );
  } else {
    const changes = [
      ...compare(approvedFingerprints(previous), fingerprints(team)).map(describe),
      ...checkDrift(previous.approval.checks, resolved.checks),
      // A record that does not verify is not an approval: this one is needed whatever the diff says.
      ...(standing.kind === 'legacy' ? ['the record predates signed records'] : []),
      ...(standing.kind === 'refused' ? ['the stored record does not verify'] : []),
    ];
    const lines = formatDiff(previous.file, text);
    if (lines.length === 0)
      io.stdout(`${path}: the same text as the copy approved on ${previous.approval.approvedAt}.\n\n`);
    else {
      io.stdout(`${path}: against the copy approved on ${previous.approval.approvedAt}:\n\n`);
      io.stdout(`${lines.map((line) => `  ${line}`).join('\n')}\n\n`);
    }
    const recorded = Object.hasOwn(previous.approval, 'overrides') ? previous.approval.overrides ?? null : null;
    if (recorded !== live.text) {
      changes.push(OVERRIDE_CHANGED);
      const overrideLines = formatDiff(recorded ?? '', live.text ?? '');
      if (overrideLines.length) {
        io.stdout(`overrides.yaml: against the copy approved on ${previous.approval.approvedAt}:\n\n`);
        io.stdout(`${overrideLines.map((line) => `  ${line}`).join('\n')}\n\n`);
      }
    }
    io.stdout(
      changes.length ? `Needs a new approval: ${changes.join('; ')}.\n` : 'Nothing in it needs a new approval.\n',
    );
    if (ceilingsLine(previous.approval.ceilings) !== ceilingsLine(ceilings)) {
      io.stdout(`Ceilings approved: ${ceilingsLine(previous.approval.ceilings)}.\n`);
    }
  }
  io.stdout(`Ceilings this approval fixes: ${ceilingsLine(ceilings)}.\n`);
  io.stdout(`Seats: ${seats} (${team.seats.map((seat) => seat.name).join(', ')}).\n`);
  // One line per delegates entry, in file order; nothing when the file has no section.
  for (const delegate of team.delegates ?? []) {
    io.stdout(`Delegate: pane ${delegate.pane} may run ${delegate.commands.join(', ')}.\n`);
  }
  // The generation this signing will carry, and when the last one was, with the
  // fingerprint of the key that will sign it. A process that reads or replaces
  // the key can re-sign at the same generation, so this is evidence of what
  // `team` wrote, never of every signing.
  const recorded = recordedGeneration(root, sources.home);
  const keyRead = keyState(sources.home);
  io.stdout(
    `approval #${(recorded?.generation ?? 0) + 1} for this project${recorded ? `; the last one was on ${recorded.at.slice(0, 10)}` : ''}${keyRead.kind === 'key' ? `; key ${keyFingerprint(keyRead.key)}` : ''}.\n`,
  );

  // The out-of-band owner-authorization fingerprint: the agent shows it with `--show`, the owner
  // reads it back ("yes <fingerprint>"), and the agent reruns with `TEAM_OWNER_APPROVAL=<it>`. It
  // is recomputed from the live file, so a post-yes edit prints — and demands — a different hex.
  const approveFp = approveFingerprint(team);
  io.stdout(`Owner-authorization fingerprint: ${approveFp}\n`);

  // exit: approve.show
  if (args.flags.has('show')) return 0;

  // The one write the approved callers perform: the signed record, the line that attributes
  // it — the owner's own, the delegate's audit line naming the pane, or the granted seat's
  // line naming the seat — and the sentence. `pane` is the approved delegate's when this is a
  // delegated approval. `grantSeat` is the granted orchestrator when this is that seat's
  // ordinary approval. Both are absent for the owner's.
  // Set once the caller is placed below: true when a non-owner was admitted by a matching
  // out-of-band owner token. The write and the signing are the owner's either way; this only
  // adds the provenance to the log line.
  let tokenAuthorized = false;
  const writeApproved = (caller: Caller, pane?: string, changed?: string, grantSeat?: string): number => {
    const now = sources.now();
    writeApproval(
      store,
      // `pane` is the approved delegate's on a delegated approval: the record names it as the
      // actor beside the owner's signature, and the signed payload covers it.
      { approval: { ...approvalOf(team, root, now, resolved.checks, pane), overrides: live.text }, file: text },
      team.seats,
      sources.home,
      now,
    );
    if (grantSeat !== undefined) {
      logGranted(dirname(path), grantSeat, 'approve', now, changed);
    } else if (pane === undefined) {
      logLine(
        dirname(path),
        'approve',
        describeCaller(caller),
        `approved ${seats} seats; ceilings: ${ceilingsLine(ceilings)}${tokenAuthorized ? '; owner-token-authorized' : ''}`,
        now,
      );
    } else {
      logDelegated(dirname(path), pane, 'approve', now, changed);
    }
    io.stdout(`Approved. The record is in ${store}; signed with key ${keyFingerprint(keyOf(sources.home))}; check the rest with \`team doctor\`.\n`);
    // exit: approve.approved
    return 0;
  };

  const caller = callerOf(io);
  const detached = detachedRefusal(caller);
  if (detached !== undefined) {
    io.stderr(`team approve: ${detached}\n`);
    // exit: approve.detached
    return 1;
  }
  // An out-of-band owner token admits a non-owner caller as the owner for this one change: the
  // fingerprint it carries must equal the one just recomputed from the live file. When it does,
  // the delegate gate is skipped and the run rejoins the owner's path — the same key, the same
  // write — with the provenance on the log line. A token for any other change never matches.
  // A foreign `--file` was not loaded, so the token is the default file's only. A token for
  // some other file does not sign this one, and does not open the path the seat named.
  tokenAuthorized = !isOwner(caller) && !foreignFile && ownerAuthorized(io.env, approveFp);
  // The approved delegate's pane, when this is a delegated approval: the gate passed it, and
  // the run goes on through the same key guards and the same write the owner's run uses.
  // Absent, this is the owner's run, or the granted seat's.
  let delegatedPane: string | undefined;
  let grantedSeat: string | undefined;
  if (!isOwner(caller) && !tokenAuthorized) {
    // The delegate branch, tried only when the file names a delegate at all. The gate verifies
    // the approval, the approved copy, the ordinary-change guard — a roster or `rules`
    // difference passes there; every other owner section is refused with "this change needs
    // the owner" — the placement, the entry, `approve` in its commands, and the flags:
    // `--file` is refused there (a delegate approves the default placed file only). A passed
    // run rejoins the owner's path below and skips only the question's guards.
    const verdict = team.delegates
      ? (sources.gate ?? delegateGate)({
          command: 'approve',
          team,
          root,
          dir: dirname(path),
          flags: [...args.flags, ...Object.keys(args.values)],
          io,
          home: sources.home,
          ...(sources.delegate ? { sources: sources.delegate } : {}),
        })
      : null;
    if (verdict?.kind === 'passed') {
      delegatedPane = verdict.pane;
    } else {
      // The grant is asked where a delegate did not take the run. A delegate refusal that
      // already named a listed pane keeps that sentence. `approve.delegate` is the caller who
      // is not a listed pane, and that caller may be the granted seat. A file that omits
      // `grant` does not ask, and today's not-owner sentence stands.
      const delegateMissed = verdict === null || (verdict.kind === 'refused' && verdict.id === 'approve.delegate');
      let grantRefusal: string | undefined;
      if (delegateMissed && team.grant) {
        const said = (sources.grantGate ?? grantGate)({ act: 'approve', io, home: sources.home });
        if (said.kind === 'passed') grantedSeat = said.grant.seat;
        else grantRefusal = said.text;
      }
      if (grantedSeat !== undefined && foreignFile) {
        io.stderr(`team approve: --file is the owner's; the granted seat cannot use it\n`);
        // exit: approve.grant-flag
        return 1;
      }
      if (grantRefusal !== undefined) {
        io.stderr(`team approve: ${grantRefusal}\n`);
        // exit: approve.grant-another-pane
        // exit: approve.grant-approval
        // exit: approve.grant-caller
        // exit: approve.grant-no-pane
        // exit: approve.grant-not-ordinary
        // exit: approve.grant-scope
        return 1;
      }
      if (verdict?.kind === 'refused') {
        io.stderr(`team approve: ${verdict.text}\n`);
        // exit: approve.delegate
        // exit: approve.delegate-approval
        // exit: approve.delegate-command
        // exit: approve.delegate-evidence
        // exit: approve.delegate-flag
        // exit: approve.delegate-placement
        // exit: approve.delegate-not-ordinary
        return 1;
      }
      if (grantedSeat === undefined) {
        io.stderr(
          `team approve: only the owner approves a team file, from a terminal outside herdr; this call is ${describeCaller(caller)}\n`,
        );
        // exit: approve.not-owner
        return 1;
      }
    }
  }

  // A key that already exists and cannot be read refuses here, before the terminal is read and
  // before the question: a run that can never sign must not consume a deliberate answer — or,
  // on a delegated run, write at all — and the repair, restoring the file from a copy, is the
  // same whether the key broke a minute or a month ago. This look is read-only; the key that
  // is missing is still made only once every refusal below has had its chance.
  const refusal = keyRefusal(sources.home);
  if (refusal !== null) {
    io.stderr(`team approve: ${refusal}\n`);
    // exit: approve.key
    return 1;
  }

  // The default path asks nothing: the summary above is the last thing printed, and the
  // record is written. Two things keep the question's protection: the owner check above
  // (the input is a terminal) and this guard — input already waiting on that terminal is a
  // pasted block's remainder, which must not be left to approve anything. The guard is
  // three-valued: only a check that found the terminal empty lets the write through. A line
  // found waiting refuses, and so does a terminal the check could not read at all — an
  // unreadable terminal must not become an approval either, and it is not the same fault as
  // a paste, so it carries its own id. A delegated run skips both guards: the question is the
  // owner's, its terminal is not where a delegated approval is answered, and the audit line —
  // not an answer — is its record.
  // A token-authorized run skips the question's guards like a delegated one: the question is the
  // owner's terminal act, and the owner already authorized this exact change out of band.
  if (delegatedPane === undefined && grantedSeat === undefined && !tokenAuthorized) {
    if (args.flags.has('confirm')) {
      const answer = await sources.ask(
        `\nType the number of seats (${seats}) to approve this file, and its commands and rules, to run: `,
      );
      if (answer === null || answer.trim() !== String(seats)) {
        io.stderr('team approve: not approved; nothing was written\n');
        // exit: approve.answer
        return 1;
      }
    } else {
      const waiting = sources.waiting();
      if (waiting === 'waiting') {
        io.stderr('team approve: input was waiting on the terminal: this command needs the terminal to itself\n');
        // exit: approve.input-waiting
        return 1;
      }
      if (waiting === 'unreadable') {
        io.stderr(
          'team approve: the terminal this call runs on could not be read to check for input waiting on it; nothing was written\n',
        );
        // exit: approve.input-unreadable
        return 1;
      }
    }
  }

  // The key is created only now, once every refusal above has had its chance: a not-owner, a
  // delegate the gate refused, a broken key, a waiting line, an unreadable terminal or a
  // rejected answer leaves no key folder behind, so on a first approval the refusals' "nothing
  // was written" is true. The look above found a key or none; a key that turns unreadable in
  // the window between that look and this write still fails closed here — a new key would
  // orphan every record already signed, so the owner restores it.
  try {
    keyOf(sources.home);
  } catch (error) {
    io.stderr(`team approve: ${(error as Error).message}\n`);
    // exit: approve.key-changed
    return 1;
  }

  // What a delegated approval seals, for its audit line: the ordinary differences the guard
  // admitted. The owner's line has never named the differences and does not start now.
  const changed =
    (delegatedPane === undefined && grantedSeat === undefined) || previous === null
      ? undefined
      : compare(approvedFingerprints(previous), fingerprints(team)).map(describe).join('; ');
  if (grantedSeat !== undefined) return writeApproved(caller, undefined, changed, grantedSeat);
  return delegatedPane === undefined ? writeApproved(caller) : writeApproved(caller, delegatedPane, changed);
}
