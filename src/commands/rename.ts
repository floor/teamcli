import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { recordSeatRenameOf } from '../approve/approval.ts';
import { readArgs } from '../args.ts';
import {
  anotherPaneRefusal,
  callerLabel,
  describeCaller,
  detachedRefusal,
  fileOwnerRefusal,
  isOwner,
  judgeCallerIn,
  judgeCallerOf,
  noPaneRefusal,
  sessionOwnerRefusal,
  standingOf,
  walkCaller,
  type Caller,
  type SeatStanding,
} from '../caller.ts';
import { delegateGate, logDelegated } from '../delegate.ts';
import { devModeCallerGate, devModeExpiryNote, logDevMode, logDevModeState, resolveDevMode } from '../dev_mode.ts';
import { launchedTeamFile } from '../file/launched-file.ts';
import { renameSeat } from '../file/lines.ts';
import { findRoot } from '../file/load.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { nicknameProblem } from '../file/sections/seats.ts';
import type { TeamFile } from '../file/types.ts';
import { validateTeamFile } from '../file/validate.ts';
import { writeTeamFile } from '../file/write.ts';
import { entityGrantAdmits, readEntityCreateGrants } from '../grant.ts';
import { agentRename } from '../herdr.ts';
import type { Command, Io } from '../io.ts';
import { deliverBriefForAttribution, walkBriefDeliveries } from '../launch/general-brief.ts';
import { plainText } from '../launch/plain.ts';
import { logLine } from '../log.ts';
import { gateVerdict } from '../permissions/who.ts';
import { reachProjectionNote, writeReachProjection } from '../reach/projection.ts';
import { registerRename, type RegistryTeam } from '../registry/sync.ts';
import { formatSeatNumber, seatNumberOf } from '../seat-names.ts';
import { renameSeatHistory } from '../send/history.ts';
import { seatNumberingInForce } from '../settings/seat-numbering.ts';
import { emptySession, readState, updateState, withLock, writeAtomic } from '../state.ts';
import {
  MESSAGE_DOMAIN,
  messageKeyState,
  RECEIPT_DOMAIN,
  signDomain,
  verifyDomain,
  type Json,
} from '../store/keys.ts';
import { approvalStanding, storePath, type Standing } from '../store/store.ts';
import { renameSeatLeases } from '../tasks/lease.ts';

export const USAGE = `Usage: team rename <seat> <new-seat> [--session <name>] [--file <path>] [--json]
       team rename --renumber [--dry-run] [--session <name>] [--file <path>] [--json]

Renames a seat in .agents/team.yaml and carries over its registry record,
grants, task leases, pending send-drops, mailbox messages, rules file, queue
and notes files, state records, and message history.

With --renumber, renumbers numbered seats (e.g. builder-1 -> builder-01) to
match the seat_numbering in force while leaving single (unnumbered) seats plain.
`;

const SEAT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type RenameSources = {
  home?: string;
  now(): Date;
  standing?(root: string): Standing;
  renameAgent?(session: string, pane: string, name: string): boolean;
  delegateGate?: typeof delegateGate;
};

function aim(session: string): string | undefined {
  return session === 'default' ? undefined : session;
}

export const realSources: RenameSources = {
  now: () => new Date(),
  renameAgent: (session, pane, name) => agentRename(pane, name, aim(session)),
};

export type SeatRenameResult = {
  from: string;
  to: string;
  agent: string | null;
  moved: string[];
};

/** Moves files inside `fromDir` into `toDir` (or renames `fromDir` to `toDir` when `toDir` does not exist). */
function moveFolder(fromDir: string, toDir: string): boolean {
  try {
    if (!lstatSync(fromDir).isDirectory()) return false;
  } catch {
    return false;
  }
  mkdirSync(dirname(toDir), { recursive: true });
  if (!existsSync(toDir)) {
    renameSync(fromDir, toDir);
    return true;
  }
  let movedAny = false;
  for (const entry of readdirSync(fromDir).sort()) {
    const src = join(fromDir, entry);
    const dst = join(toDir, entry);
    if (existsSync(dst)) continue;
    renameSync(src, dst);
    movedAny = true;
  }
  try {
    if (readdirSync(fromDir).length === 0) rmdirSync(fromDir);
  } catch {}
  return movedAny;
}

/** Moves `.agents/send-drops/<bucket>/<from>` to `.agents/send-drops/<bucket>/<to>`. */
function moveSendDrops(root: string, fromSeat: string, toSeat: string): string[] {
  const moved: string[] = [];
  const dropsRoot = join(root, '.agents', 'send-drops');
  let entries: string[];
  try {
    entries = readdirSync(dropsRoot).sort();
  } catch {
    return moved;
  }
  for (const entry of entries) {
    const entryPath = join(dropsRoot, entry);
    let isDir = false;
    try {
      isDir = lstatSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (entry === fromSeat) {
      const dst = join(dropsRoot, toSeat);
      if (moveFolder(entryPath, dst)) {
        moved.push(relative(root, dst));
      }
      continue;
    }
    const nestedFrom = join(entryPath, fromSeat);
    const nestedTo = join(entryPath, toSeat);
    if (moveFolder(nestedFrom, nestedTo)) {
      moved.push(relative(root, nestedTo));
    }
  }
  return moved;
}

/** Moves `.agents/messages/<from>` to `.agents/messages/<to>` and re-keys `payload.to` on signed records. */
function moveMailboxMessages(root: string, home: string, fromSeat: string, toSeat: string): string | null {
  const fromDir = join(root, '.agents', 'messages', fromSeat);
  const toDir = join(root, '.agents', 'messages', toSeat);
  if (!moveFolder(fromDir, toDir)) return null;
  const keyState = messageKeyState(home);
  let names: string[] = [];
  try {
    names = readdirSync(toDir).sort();
  } catch {
    return relative(root, toDir);
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const filePath = join(toDir, name);
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        payload?: Record<string, unknown>;
        signature?: unknown;
      };
      if (!raw || typeof raw !== 'object' || !raw.payload || typeof raw.payload !== 'object') continue;
      if (raw.payload.to !== fromSeat) continue;
      const isReceipt = name.endsWith('.read.json') && raw.payload.kind === 'receipt';
      const domain = isReceipt ? RECEIPT_DOMAIN : MESSAGE_DOMAIN;
      const nextPayload = { ...raw.payload, to: toSeat };
      if (
        keyState.kind === 'key' &&
        typeof raw.signature === 'string' &&
        verifyDomain(domain, raw.payload as Json, raw.signature, keyState.key)
      ) {
        const nextSig = signDomain(domain, nextPayload as Json, keyState.key);
        writeAtomic(filePath, `${JSON.stringify({ payload: nextPayload, signature: nextSig }, null, 2)}\n`);
      } else {
        writeAtomic(filePath, `${JSON.stringify({ ...raw, payload: nextPayload }, null, 2)}\n`);
      }
    } catch {}
  }
  return relative(root, toDir);
}

/** Moves per-seat rules, queue, notes, and brief files in the project state folder and checkout. */
function moveSeatFiles(
  project: string,
  root: string,
  home: string,
  fromSeat: string,
  toSeat: string,
): string[] {
  const moved: string[] = [];
  const storeDir = storePath(project, root, home);

  // Per-seat rules file and queue/notes in the project state folder
  for (const sub of ['rules', 'queue', 'queues', 'notes']) {
    const dir = join(storeDir, sub);
    const src = join(dir, `${fromSeat}.md`);
    const dst = join(dir, `${toSeat}.md`);
    try {
      if (lstatSync(src).isFile() && !existsSync(dst)) {
        renameSync(src, dst);
        moved.push(`${sub}/${toSeat}.md`);
      }
    } catch {}
  }

  // Per-seat queue/notes files inside `.agents/` or the checkout root
  for (const base of [join(root, '.agents'), root]) {
    for (const sub of ['queue', 'queues', 'notes']) {
      const dir = join(base, sub);
      let entries: string[];
      try {
        entries = readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry === fromSeat || entry.startsWith(`${fromSeat}.`)) {
          const suffix = entry.slice(fromSeat.length);
          const src = join(dir, entry);
          const dst = join(dir, `${toSeat}${suffix}`);
          try {
            if (!existsSync(dst)) {
              renameSync(src, dst);
              moved.push(relative(root, dst));
            }
          } catch {}
        }
      }
    }
  }

  // Brief files `briefs/<from>-to-<other>.md` or `briefs/<other>-to-<from>.md`
  const briefsDir = join(root, 'briefs');
  try {
    for (const name of readdirSync(briefsDir).sort()) {
      const match = /^([A-Za-z0-9._-]+)-to-([A-Za-z0-9._-]+)\.md$/.exec(name);
      if (!match) continue;
      const lhs = match[1] === fromSeat ? toSeat : match[1]!;
      const rhs = match[2] === fromSeat ? toSeat : match[2]!;
      if (lhs === match[1] && rhs === match[2]) continue;
      const src = join(briefsDir, name);
      const dst = join(briefsDir, `${lhs}-to-${rhs}.md`);
      if (!existsSync(dst)) {
        renameSync(src, dst);
        moved.push(relative(root, dst));
      }
    }
  } catch {}

  return moved;
}

/** Updates `.agents/team.state.json` references to `fromSeat` across all sessions and budget readings. */
function renameSeatInState(dir: string, renames: ReadonlyArray<{ from: string; to: string }>): boolean {
  let stateChanged = false;
  updateState(dir, (current) => {
    const nextSessions = { ...current.sessions };
    for (const [sessionName, sess] of Object.entries(nextSessions)) {
      let s = sess ?? emptySession();
      let sessionTouched = false;
      const nextSeats = { ...s.seats };
      const nextRetained = s.retained_seats ? { ...s.retained_seats } : undefined;
      const nextSwapping = s.swapping ? { ...s.swapping } : undefined;
      const nextWorktrees = { ...s.worktrees };
      const nextProcs = s.procs ? { ...s.procs } : undefined;

      for (const { from, to } of renames) {
        if (Object.hasOwn(nextSeats, from)) {
          nextSeats[to] = nextSeats[from]!;
          delete nextSeats[from];
          sessionTouched = true;
        }
        for (const [seatKey, seatVal] of Object.entries(nextSeats)) {
          if (seatVal.temporary?.like === from) {
            nextSeats[seatKey] = {
              ...seatVal,
              temporary: { ...seatVal.temporary, like: to },
            };
            sessionTouched = true;
          }
        }
        if (nextRetained && Object.hasOwn(nextRetained, from)) {
          nextRetained[to] = nextRetained[from]!;
          delete nextRetained[from];
          sessionTouched = true;
        }
        if (nextSwapping) {
          if (Object.hasOwn(nextSwapping, from)) {
            nextSwapping[to] = nextSwapping[from]!;
            delete nextSwapping[from];
            sessionTouched = true;
          }
          for (const [swapKey, swapVal] of Object.entries(nextSwapping)) {
            if (swapVal.by === from) {
              nextSwapping[swapKey] = { ...swapVal, by: to };
              sessionTouched = true;
            }
          }
        }
        for (const [wtKey, wtVal] of Object.entries(nextWorktrees)) {
          if (wtVal.seat === from) {
            nextWorktrees[wtKey] = { ...wtVal, seat: to };
            sessionTouched = true;
          }
        }
        if (nextProcs) {
          for (const [procKey, procVal] of Object.entries(nextProcs)) {
            if (procVal.by === from) {
              nextProcs[procKey] = { ...procVal, by: to };
              sessionTouched = true;
            }
          }
        }
      }

      if (sessionTouched) {
        stateChanged = true;
        s = {
          ...s,
          seats: nextSeats,
          worktrees: nextWorktrees,
          ...(nextRetained !== undefined ? { retained_seats: nextRetained } : {}),
          ...(nextSwapping !== undefined ? { swapping: nextSwapping } : {}),
          ...(nextProcs !== undefined ? { procs: nextProcs } : {}),
        };
        nextSessions[sessionName] = s;
      }
    }

    let nextBudgets = current.budgets ? { ...current.budgets } : undefined;
    if (nextBudgets) {
      const map = new Map(renames.map((r) => [r.from, r.to]));
      for (const [bKey, reading] of Object.entries(nextBudgets)) {
        if (reading.seat !== null && map.has(reading.seat)) {
          nextBudgets[bKey] = { ...reading, seat: map.get(reading.seat)! };
          stateChanged = true;
        }
      }
    }

    if (stateChanged) {
      current.sessions = nextSessions;
      if (nextBudgets !== undefined) current.budgets = nextBudgets;
    }
  });
  return stateChanged;
}

function computeRenumberPlan(
  root: string,
  team: TeamFile,
  home: string,
  now: Date,
): { ok: true; renames: Array<{ from: string; to: string }> } | { ok: false; reason: string } {
  const numbering = seatNumberingInForce({ home, root, team, now });
  const renames: Array<{ from: string; to: string }> = [];
  const movingFrom = new Set<string>();
  for (const seat of team.seats) {
    if (seat.count > 1) continue;
    const parsed = seatNumberOf(seat.name, numbering.separator) ?? seatNumberOf(seat.name);
    if (!parsed) continue;
    const target = `${parsed.base}${numbering.separator}${formatSeatNumber(parsed.number, numbering)}`;
    if (target === seat.name) continue;
    renames.push({ from: seat.name, to: target });
    movingFrom.add(seat.name);
  }
  const seenTargets = new Set<string>();
  for (const { from, to } of renames) {
    if (seenTargets.has(to)) {
      return { ok: false, reason: `cannot rename "${from}" to "${to}": another seat is also renumbering to "${to}"` };
    }
    seenTargets.add(to);
    if (!movingFrom.has(to) && team.seats.some((s) => s.name === to)) {
      return { ok: false, reason: `seat "${to}" is already declared in .agents/team.yaml` };
    }
    const nickErr = nicknameProblem(team.seats, to, from);
    if (nickErr) {
      return { ok: false, reason: `cannot rename "${from}" to "${to}": ${nickErr.message}` };
    }
  }
  return { ok: true, renames };
}

type RenameOutcome = 'ok' | 'refused' | 'invalid' | 'invocation';

export const rename: Command = (argv, io) => runRename(argv, io, realSources);
export default rename;

export async function runRename(argv: string[], io: Io, sources: RenameSources = realSources): Promise<number> {
  const outcome = await executeRename(argv, io, sources);
  if (outcome === 'invocation') {
    return 2; // exit: rename.invocation
  }
  if (outcome === 'invalid') {
    return 2; // exit: rename.invalid
  }
  if (outcome === 'refused') {
    return 1; // exit: rename.refused
  }
  return 0; // exit: rename.done
}

async function executeRename(argv: string[], io: Io, sources: RenameSources): Promise<RenameOutcome> {
  const args = readArgs(argv, ['session', 'file'], ['renumber', 'dry-run', 'json']);
  const renumber = args.flags.has('renumber');
  const dryRun = args.flags.has('dry-run');
  const json = args.flags.has('json');

  if (args.error) {
    io.stderr(`team rename: ${args.error}\n${USAGE}`);
    return 'invocation';
  }
  if (dryRun && !renumber) {
    io.stderr(`team rename: --dry-run is only valid with --renumber\n${USAGE}`);
    return 'invocation';
  }
  if (renumber && args.rest.length > 0) {
    io.stderr(`team rename: --renumber takes no seat arguments (unexpected "${args.rest[0]}")\n${USAGE}`);
    return 'invocation';
  }
  if (!renumber && args.rest.length !== 2) {
    const msg =
      args.rest.length === 0
        ? 'a seat name and a new seat name are required (or pass --renumber)'
        : args.rest.length === 1
          ? `missing <new-seat> after "${args.rest[0]}"`
          : `unexpected "${args.rest[2]}"`;
    io.stderr(`team rename: ${msg}\n${USAGE}`);
    return 'invocation';
  }

  const home = sources.home ?? homedir();
  const now = sources.now();
  const detached = detachedRefusal(walkCaller(io));
  let runnerGranted = false;
  if (detached !== undefined && readEntityCreateGrants(home).length > 0) {
    const hereRoot = findRoot(io.cwd);
    runnerGranted =
      hereRoot !== null && entityGrantAdmits(hereRoot, io, { home, now, cwd: io.cwd });
  }
  if (detached !== undefined && !runnerGranted) {
    io.stderr(`team rename: ${detached}\n`);
    return 'refused';
  }

  const walked = args.values.session !== undefined ? walkCaller(io) : undefined;
  const flagRefusal =
    fileOwnerRefusal(io, args.values.file) ??
    (walked !== undefined && !isOwner(walked) ? sessionOwnerRefusal(walked) : undefined);
  if (flagRefusal !== undefined) {
    io.stderr(`team rename: ${flagRefusal}\n`);
    return 'refused';
  }

  const launched = args.values.file ? undefined : launchedTeamFile(io, home);
  const loaded = readTeamConfig(io.cwd, {
    ...(args.values.file ?? launched ? { file: args.values.file ?? launched } : {}),
    home,
  });
  if (!loaded.ok) {
    for (const problem of loaded.errors) {
      io.stderr(`team rename: ${problem.line ? `line ${problem.line}: ` : ''}${problem.message}\n`);
    }
    return 'invalid';
  }
  const { team, path, root } = loaded;
  const dir = dirname(path);

  const verdictOf = (who: Caller, at: SeatStanding): ReturnType<typeof gateVerdict> =>
    gateVerdict(who, team, root, home, 'rename', at, sources.now);
  const judged =
    args.values.session !== undefined
      ? {
          ...judgeCallerOf(io, args.values.session === 'default' ? undefined : args.values.session),
          session: args.values.session,
        }
      : judgeCallerIn(io, dir, team, verdictOf);
  const { caller, shown, session } = judged;

  const dev = resolveDevMode('rename', io, {
    home,
    team,
    root,
    now,
  });
  logDevModeState(dir, 'rename', describeCaller(shown), dev, now);
  const verdict = verdictOf(caller, standingOf(dir, session, caller));

  const createGranted =
    verdict.kind !== 'ok' &&
    readEntityCreateGrants(home).length > 0 &&
    entityGrantAdmits(root, io, { home, now, cwd: io.cwd });
  if (verdict.kind === 'no-pane') {
    io.stderr(`team rename: ${noPaneRefusal(verdict.name)}\n`);
    return 'refused';
  }
  if (verdict.kind === 'another-pane') {
    io.stderr(`team rename: ${anotherPaneRefusal(verdict.name, verdict.recordedPane)}\n`);
    return 'refused';
  }
  if (verdict.kind === 'refused' && !createGranted) {
    const said = `only the owner or \`leads\` renames a seat; this call is ${describeCaller(shown)}${devModeExpiryNote(dev)}`;
    const folded = devModeCallerGate(dev, said);
    if (folded === null) {
      io.stderr(`team rename: ${said}\n`);
      return 'refused';
    }
    io.stderr(`team rename: ${folded}\n`);
    logDevMode(dir, 'rename', describeCaller(shown), folded, now);
  }

  let renames: Array<{ from: string; to: string }>;
  if (renumber) {
    const plan = computeRenumberPlan(root, team, home, now);
    if (!plan.ok) {
      io.stderr(`team rename: ${plan.reason}\n`);
      return 'refused';
    }
    renames = plan.renames;
    if (dryRun) {
      if (json) {
        io.stdout(`${JSON.stringify({ dryRun: true, renames }, null, 2)}\n`);
      } else if (renames.length === 0) {
        io.stdout('team rename: all numbered seats already match the seat numbering in force\n');
      } else {
        for (const item of renames) {
          io.stdout(`${item.from} -> ${item.to} (dry run)\n`);
        }
      }
      return 'ok';
    }
    if (renames.length === 0) {
      if (json) {
        io.stdout(`${JSON.stringify({ dryRun: false, renames: [] }, null, 2)}\n`);
      } else {
        io.stdout('team rename: all numbered seats already match the seat numbering in force\n');
      }
      return 'ok';
    }
  } else {
    const fromName = args.rest[0] ?? '';
    const toName = args.rest[1] ?? '';
    const seat = team.seats.find((s) => s.name === fromName);
    if (!seat) {
      io.stderr(`team rename: "${fromName}" is not a declared seat in .agents/team.yaml\n`);
      return 'refused';
    }
    if (seat.count > 1) {
      io.stderr(
        `team rename: "${fromName}" is declared under "${seat.declared}" with count ${seat.count} and cannot be renamed partially\n`,
      );
      return 'refused';
    }
    if (!SEAT_NAME_PATTERN.test(toName)) {
      io.stderr(
        `team rename: "${toName}" is not a valid seat name (lowercase letters, digits and hyphens, starting with a letter or digit)\n`,
      );
      return 'invalid';
    }
    if (fromName === toName) {
      io.stderr(`team rename: seat "${fromName}" is already named "${toName}"\n`);
      return 'refused';
    }
    if (team.seats.some((s) => s.name === toName)) {
      io.stderr(`team rename: seat "${toName}" is already declared in .agents/team.yaml\n`);
      return 'refused';
    }
    const nickClash = nicknameProblem(team.seats, toName, fromName);
    if (nickClash) {
      io.stderr(`team rename: cannot rename "${fromName}" to "${toName}": ${nickClash.message}\n`);
      return 'refused';
    }
    renames = [{ from: fromName, to: toName }];
  }

  const standing = (sources.standing ?? ((at) => approvalStanding(at, home)))(root);
  const originalText = readFileSync(path, 'utf8');
  let nextText = originalText;
  for (const { from, to } of renames) {
    nextText = renameSeat(nextText, from, to);
  }
  const validated = validateTeamFile(nextText, { home, root });
  if (!validated.ok) {
    const first = validated.errors[0];
    io.stderr(
      `team rename: ${first?.line ? `line ${first.line}: ` : ''}${first?.message ?? 'edited team file did not validate'}\n`,
    );
    return 'invalid';
  }

  const priorState = readState(dir);
  writeTeamFile(path, nextText);
  recordSeatRenameOf(standing, validated.team, root, renames, home);

  const stateMoved = renameSeatInState(dir, renames);

  const regInput: RegistryTeam = {
    home,
    team: validated.team,
    root,
    by: callerLabel(caller),
    session,
    ...(dev.on ? { devMode: true } : caller.kind === 'owner' ? { owner: true } : {}),
  };

  const results: SeatRenameResult[] = [];
  for (const { from, to } of renames) {
    const moved: string[] = ['.agents/team.yaml'];
    if (stateMoved) moved.push('.agents/team.state.json');

    let seatSession = session;
    let priorSeatState = priorState.sessions[session]?.seats[from];
    if (!priorSeatState) {
      for (const [sessName, sess] of Object.entries(priorState.sessions)) {
        if (sess?.seats[from]) {
          seatSession = sessName;
          priorSeatState = sess.seats[from];
          break;
        }
      }
    }
    const handle = priorSeatState?.id;
    const pane = priorSeatState?.pane;

    if (pane && sources.renameAgent) {
      try {
        if (sources.renameAgent(seatSession, pane, to)) {
          moved.push(`pane ${pane}`);
        }
      } catch {}
    }

    const reg = registerRename(regInput, from, to, handle);
    let agentId: string | null = null;
    if ('id' in reg && reg.id !== null) {
      agentId = reg.id;
      moved.push(`agent ${reg.id}`);
    }

    const leases = renameSeatLeases(root, from, to);
    for (const leaseId of leases) {
      moved.push(`.agents/leases/${leaseId}.json`);
    }

    const drops = moveSendDrops(root, from, to);
    moved.push(...drops);

    const mailboxMoved = moveMailboxMessages(root, home, from, to);
    if (mailboxMoved) moved.push(mailboxMoved);

    const seatFiles = moveSeatFiles(validated.team.project, root, home, from, to);
    moved.push(...seatFiles);

    const historyCount = renameSeatHistory(validated.team.project, root, home, from, to);
    if (historyCount > 0) {
      moved.push(`messages.jsonl (${String(historyCount)} ${historyCount === 1 ? 'entry' : 'entries'})`);
    }

    // The general seat brief, through the one boundary every attribution path calls: the seat
    // under its new name is attributed, so it gets a fresh delivery lifetime and a fresh record.
    // The old lifetime is never re-used — its record's payload names the old seat, so it cannot
    // serve the new name even though the folder move above carried it along. The claim lands
    // after the state's own rename, in the session that records the seat.
    const briefs = deliverBriefForAttribution({
      dir,
      root,
      session: seatSession,
      home,
      now,
      team: validated.team,
      state: readState(dir).sessions[seatSession] ?? emptySession(),
      attributed: [to],
    });
    await walkBriefDeliveries(briefs, { dir, home });
    for (const delivery of briefs.deliveries) {
      if (delivery.ok) continue;
      const said = `${delivery.seat}: the general seat brief was not delivered (${delivery.reason})`;
      io.stderr(`team rename: ${plainText(said)}\n`);
      logLine(dir, 'rename', callerLabel(caller), said, now);
    }
    if (briefs.recording !== undefined) {
      const said = `the general seat brief was written and not recorded (${briefs.recording})`;
      io.stderr(`team rename: ${plainText(said)}\n`);
      logLine(dir, 'rename', callerLabel(caller), said, now);
    }

    const summary = `renamed seat ${from} -> ${to} (moved: ${moved.join(', ')})`;
    logLine(dir, 'rename', callerLabel(caller), summary, now);
    results.push({ from, to, agent: agentId, moved });
  }

  const report = writeReachProjection(validated.team, home);
  const projNote = reachProjectionNote(report);
  if (projNote) {
    logLine(dir, 'rename', callerLabel(caller), projNote, now);
  }

  if (json) {
    io.stdout(`${JSON.stringify({ dryRun: false, renames: results }, null, 2)}\n`);
  } else {
    for (const res of results) {
      io.stdout(`renamed ${res.from} -> ${res.to}: moved ${res.moved.join(', ')}\n`);
    }
  }
  return 'ok';
}
