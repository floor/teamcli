// The handler boundary for the queue's two green-slice events. A request may carry the three
// fields `readSliceWords` reads and nothing else: the caller is a placement the host derived with
// the existing caller primitives (`placeCaller`, the recorded seat pane, the lease, the approval
// standing), never a field read from request JSON. The machine's user id and the socket's file
// mode say nothing about who is calling, so no `caller` object in a payload is trusted, and no
// `kind: owner` is fabricated here. The CLI and the future unified host call this same core, so
// the gates cannot drift apart. The result is data — an event and a status, or a refusal id and
// its sentence — so a host never has to parse the command's text.
import { join } from 'node:path';
import { approvalDifferencesOf } from '../approve/approval.ts';
import {
  anotherPaneRefusal,
  callerVerdict,
  logTag,
  noPaneRefusal,
  standingOf,
  type Caller,
} from '../caller.ts';
import { devModeCallerGate, devModeState } from '../dev_mode.ts';
import type { TeamFile } from '../file/types.ts';
import type { Io } from '../io.ts';
import { logLine } from '../log.ts';
import { approvalStanding } from '../store/store.ts';
import { recordGreenSliceInstall, recordGreenSliceReady, type GreenSliceEvent, type GreenSliceInstall, type GreenSliceReady, type GreenSliceRecorded } from './green-slices.ts';
import { liveLeaseOf } from './lease.ts';
import { fileSourceOf, isTaskId, readFileSource, type FileSource } from './queue.ts';

/** The refusal rows a producer event can report. Each is also a contract exit id. */
export type SliceRefusalId =
  | 'queue.caller'
  | 'queue.installer'
  | 'queue.lease'
  | 'queue.read'
  | 'queue.record'
  | 'queue.source';

export type SliceRefusal = { id: SliceRefusalId; message: string };

export type SliceResult<E extends GreenSliceEvent = GreenSliceEvent> =
  | { ok: true; status: 'recorded' | 'held'; event: E }
  | { ok: false; refusal: SliceRefusal };

/** The only fields a producer request may carry. Anything else — a caller, a seat, an installer,
 *  an owner flag — is not read: identity is the `Caller` the host passes beside these. */
export type SliceWords = { task: string; commit: string; version: string };

export type SliceRequest = { task?: string; commit?: string; version?: string; defaultVersion: string };

/** Validates the request fields as the CLI validates its words, so both doors refuse alike. */
export function readSliceWords(
  request: SliceRequest,
): { ok: true; words: SliceWords } | { ok: false; message: string; usage: boolean } {
  const { task, commit, version } = request;
  if (task === undefined) return { ok: false, message: 'a task is required', usage: true };
  if (!isTaskId(task)) {
    return {
      ok: false,
      message: `"${task}" is not a task id: use letters, digits, dot, dash or underscore, starting with a letter or digit`,
      usage: false,
    };
  }
  if (commit === undefined) return { ok: false, message: '--commit is required', usage: true };
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    return { ok: false, message: `"${commit}" is not a commit: use 7 to 40 lowercase hex digits`, usage: false };
  }
  if (version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) {
    return { ok: false, message: `"${version}" is not a version: use letters, digits, dot, dash, plus or underscore`, usage: false };
  }
  return { ok: true, words: { task, commit, version: version ?? request.defaultVersion } };
}

export type SliceInput = SliceWords & {
  /** The caller the host verified. Never built from request JSON: a payload's `caller`, `seat`
   *  or `kind: owner` is not identity. */
  caller: Caller;
  /** How a refusal names the caller: the CLI describes the claim it read, the host describes the
   *  principal it derived. */
  described: string;
  /** The instant the lease and the journal are judged against. */
  now: number;
  /** The environment the central dev-mode resolver reads (`TEAMCLI_DEV_MODE`). Absent, the
   *  variable admits nothing here and a governing `dev-mode` policy still decides. Identity is
   *  never read from it. */
  env?: Pick<Io, 'env'>['env'];
};

/**
 * A seat's own record that a finished, green commit awaits the installer. The seat is the
 * verified caller, never an argument, and it must hold the live lease of the task it names; the
 * task must be in the queue the team reads. The install is not implied by any of this: only an
 * install event covers the slice.
 */
export function readySlice(team: TeamFile, root: string, input: SliceInput): SliceResult<GreenSliceReady> {
  const source = sourceOf(team);
  if (source === null) return refuse('queue.source', LINEAR_REFUSAL);
  const seat = readySeat(team, root, input);
  if (!seat.ok) return seat;
  const lease = liveLeaseOf(root, seat.name, input.now);
  if (lease === null) {
    return refuse('queue.lease', `seat ${seat.name} holds no live lease: take the task with \`team next\`, then record the slice it finished`);
  }
  if (lease.id !== input.task) {
    return refuse('queue.lease', `seat ${seat.name} holds a live lease of ${lease.id}, not ${input.task}: record the slice of the task in its hands`);
  }
  const present = taskPresent(root, source, input.task);
  if (!present.ok) return present;
  return record(() =>
    recordGreenSliceReady(join(root, '.agents'), {
      task: input.task,
      seat: seat.name,
      commit: input.commit,
      version: input.version,
      at: new Date(input.now),
    }),
  );
}

/**
 * The installer's explicit acknowledgment that a commit is installed: the owner, or the one seat
 * the file names with an `installer:` that is part of the approval in force (or, while dev mode
 * is on at this team's place, the live validated section), on its recorded pane. Running the
 * event is the acknowledgment; no merge, clock or version comparison stands in for it, and
 * `installedBy` is the verified caller, never an argument. The task need not still be in the
 * queue — the acknowledgment is of the commit.
 */
export function installSlice(team: TeamFile, root: string, home: string, input: SliceInput): SliceResult<GreenSliceInstall> {
  if (sourceOf(team) === null) return refuse('queue.source', LINEAR_REFUSAL);
  const installer = installSeat(team, root, home, input);
  if (!installer.ok) return installer;
  return record(() =>
    recordGreenSliceInstall(join(root, '.agents'), {
      task: input.task,
      commit: input.commit,
      version: input.version,
      installedBy: installer.name,
      at: new Date(input.now),
    }),
  );
}

const LINEAR_REFUSAL = 'the team file declares a linear task source; there is no local queue, and the tracker is never written';

function sourceOf(team: TeamFile): FileSource | null {
  return fileSourceOf(team);
}

/** The seat that computes `ready`: a declared seat of this team, on the pane the state records
 *  for it, in the session judged. The owner is not a seat, and recording another seat's slice is
 *  not this event's. */
function readySeat(team: TeamFile, root: string, input: SliceInput): { ok: true; name: string } | { ok: false; refusal: SliceRefusal } {
  const named = declaredSeat(team, input.caller);
  if (named === null) {
    return refuse('queue.caller', `only a seat of this team records a green slice ready; this call is ${input.described}`);
  }
  const verdict = callerVerdict(named, named.name, standingOf(join(root, '.agents'), team.session, named));
  if (verdict.kind === 'no-pane') return refuse('queue.caller', noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse('queue.caller', anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse('queue.caller', `only a seat of this team records a green slice ready; this call is ${input.described}`);
  }
  return { ok: true, name: named.name };
}

/**
 * Who may record an install: the owner, or the one seat the file designates, on its recorded
 * pane, while that designation is the approved one or dev mode is on at this team's place. A
 * designation the owner has not approved — a hand edit since the last approval, or no approval in
 * force at all — admits nobody but the owner: the file cannot make itself an installer. Under
 * dev mode the live file's validated designation stands instead, and the admission is logged with
 * the verified caller; every check above it — the declared seat, its recorded pane, the exact
 * `installer:` name — stands unchanged, so no other seat gains anything.
 */
function installSeat(
  team: TeamFile,
  root: string,
  home: string,
  input: SliceInput,
): { ok: true; name: string } | { ok: false; refusal: SliceRefusal } {
  if (input.caller.kind === 'owner') return { ok: true, name: 'owner' };
  const named = declaredSeat(team, input.caller);
  if (named === null) {
    return refuse('queue.installer', `only the owner or the team's designated installer records an install; this call is ${input.described}`);
  }
  const verdict = callerVerdict(named, named.name, standingOf(join(root, '.agents'), team.session, named));
  if (verdict.kind === 'no-pane') return refuse('queue.installer', noPaneRefusal(verdict.name));
  if (verdict.kind === 'another-pane') return refuse('queue.installer', anotherPaneRefusal(verdict.name, verdict.recordedPane));
  if (verdict.kind !== 'ok') {
    return refuse('queue.installer', `only the owner or the team's designated installer records an install; this call is ${input.described}`);
  }
  if (team.installer === null) {
    return refuse('queue.installer', 'the team file designates no installer: only the owner records an install');
  }
  if (team.installer !== named.name) {
    return refuse('queue.installer', `only the owner or ${team.installer}, the designated installer, records an install; this call is seat ${named.name}`);
  }
  if (designationApproved(root, team, home)) return { ok: true, name: named.name };
  // The live validated installer section stands under dev mode, resolved at this team's place by
  // the one central reader: signed machine provenance, and a chain that will not read is off, not
  // a release default. The admission is the declared, placed seat above — never a wider privilege.
  const state = devModeState({ env: input.env ?? {} }, { home, team, root, now: new Date(input.now) });
  if (!state.on) return refuse('queue.installer', UNAPPROVED_INSTALLER);
  const warning = devModeCallerGate(state, UNAPPROVED_INSTALLER);
  if (warning !== null) {
    logLine(join(root, '.agents'), 'queue install', logTag(input.caller), `${warning}; admitted as installer`, new Date(input.now));
  }
  return { ok: true, name: named.name };
}

const UNAPPROVED_INSTALLER =
  'the installer designation is not the approved one: only the owner records an install until the owner approves the file';

/** Whether the `installer:` section the live file reads is the one the last verified approval
 *  sealed. No verified approval, or a changed section, is not approved: the install gate then
 *  falls back to the owner. */
function designationApproved(root: string, team: TeamFile, home: string): boolean {
  const standing = approvalStanding(root, home);
  if (standing.kind !== 'verified') return false;
  return !approvalDifferencesOf(standing, team).includes('`installer` changed');
}

function declaredSeat(team: TeamFile, caller: Caller): Extract<Caller, { kind: 'seat' }> | null {
  return caller.kind === 'seat' && team.seats.some((seat) => seat.name === caller.name) ? caller : null;
}

/** The task the seat is finishing must be in the queue it works from; a refusal of the file is
 *  the read refusal, and a missing record is named as such. */
function taskPresent(root: string, source: FileSource, task: string): { ok: true } | { ok: false; refusal: SliceRefusal } {
  const read = readFileSource(root, source);
  if (read.kind === 'missing') return refuse('queue.read', 'the task file is not there');
  if (read.kind === 'outside') return refuse('queue.read', 'tasks.path must stay inside the checkout');
  if (read.kind === 'not-a-list') return refuse('queue.read', 'the queue file is not a list');
  if (!read.records.some((record) => record.id === task)) {
    return refuse('queue.read', `the queue has no task "${task}"`);
  }
  return { ok: true };
}

function record<E extends GreenSliceEvent>(make: () => GreenSliceRecorded<E>): SliceResult<E> {
  let recorded;
  try {
    recorded = make();
  } catch (error) {
    return refuse('queue.record', error instanceof Error ? error.message : String(error));
  }
  if (!recorded.ok) return refuse('queue.record', recorded.why);
  return { ok: true, status: recorded.added ? 'recorded' : 'held', event: recorded.event };
}

function refuse(id: SliceRefusalId, message: string): { ok: false; refusal: SliceRefusal } {
  return { ok: false, refusal: { id, message } };
}
