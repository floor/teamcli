// `team development-mode`: the one switch the owner asked for.
//
// One name, one machine setting. `team development-mode` reads it; `team development-mode set
// <local-fast|pr-per-change|off>` writes it. The value is the whole machine's: it governs
// `resolveDevMode`'s everyday caller gates and `devModeState`'s owner-gate admission together,
// and while it is present the legacy `TEAMCLI_DEV_MODE` variable and every per-team `dev-mode`
// word are ignored. `local-fast` lifts the gates of the `DEV_MODE_OPERATIONS` list exactly as
// the variable does; `pr-per-change` keeps the process half and lifts no caller gate; `off`
// lifts nothing and beats the legacy sources. An absent record leaves everything as it was.
//
// The write is the owner's: from a terminal outside herdr, by the existing out-of-band
// authorization for exactly this switch, or by an owner-seat request at the machine owner's Touch
// ID. `--show` (or `--dry-run`) prints what the switch would
// change and the `Owner-authorization fingerprint` — the digest of this machine, the exact mode
// and the prior generation. The owner reads it back, and the run with `TEAM_OWNER_APPROVAL`
// holding that hex is admitted. An empty or arbitrary token never matches, the token is never
// logged, and a switch that finds the generation moved refuses the replayed token. The record
// itself is signed with the owner's existing key; this command creates no key and no grant.
//
// `--request` records the switch as one owner-seat request (the card reads `TeamCLI: development
// mode` / `Set development mode to <mode> on this machine?`) exactly as `team config … --request`
// records a record change, and `--approval <request-id>` applies it once the owner's verified
// signature binds these words. The request is bound to the caller's repository, team, HEAD and
// words, and no charter admits it: the switch is the machine's, and only the owner's own answer
// may stand for her.
import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { ownerAuthorized } from '../approve/owner-token.ts';
import { describeCaller, isOwner, logTag, walkCaller, type Caller } from '../caller.ts';
import type { OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { ownerSeatStep } from '../client/owner-action-step.ts';
import {
  DEVELOPMENT_MODE_VALUES,
  developmentModeFingerprint,
  developmentModeGeneration,
  developmentModeStateLine,
  isDevelopmentMode,
  readDevelopmentMode,
  writeDevelopmentMode,
  type DevelopmentMode,
} from '../development_mode.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { plainText } from '../launch/plain.ts';
import { writeJson, writeJsonError } from '../output/index.ts';

export const USAGE = `Usage: team development-mode [--json]
       team development-mode set <local-fast|pr-per-change|off> [--show] [--dry-run] [--json]
       team development-mode set <local-fast|pr-per-change|off> --request [--json]
       team development-mode set <local-fast|pr-per-change|off> --approval <request-id> [--json]

Exits 0 when the setting is read, shown, changed, or a request is recorded, 1 when refused, 2
when the invocation is invalid.
`;

export type DevelopmentModeOptions = {
  /** The machine home the record lives under; defaults to the caller's home. */
  home?: string;
  now?: Date;
  /** The credential store a charter signature or an owner-seat answer is confirmed against.
   *  Absent: the system one. */
  ownerSeatStore?: OwnerSeatKeyStore;
  /** Present an owner-seat request to Touch ID at once (see OwnerSeatSources.present). */
  present?: boolean;
};

export const developmentMode: Command = (argv, io) => runDevelopmentMode(argv, io);
export default developmentMode;

const VALUES = DEVELOPMENT_MODE_VALUES.join('|');

/** The caller's place, in the log's words. The token path never puts its value here. */
function auditCaller(caller: Caller): string {
  return logTag(caller);
}

export async function runDevelopmentMode(
  argv: string[],
  rawIo: Io,
  options: DevelopmentModeOptions = {},
): Promise<number> {
  const io = cleanedIo(rawIo);
  const args = readArgs(argv, ['approval'], ['show', 'dry-run', 'json', 'request']);
  const json = args.flags.has('json');
  const home = options.home ?? homedir();
  const sub = args.rest[0];
  let outcome: 'ok' | 'refused' | 'invocation';
  if (args.error !== undefined) {
    if (json) writeJsonError(rawIo, 'development-mode.invocation', plainText(args.error), null);
    else io.stderr(`team development-mode: ${plainText(args.error)}\n${USAGE}`);
    outcome = 'invocation';
  } else if (sub === undefined) {
    const read = readDevelopmentMode(home);
    if (json) {
      writeJson(rawIo, 'team.development_mode', {
        format: 1,
        machine: true,
        set: read.kind === 'set',
        mode: read.kind === 'set' ? read.record.mode : null,
        since: read.kind === 'set' ? read.record.since : null,
        set_by: read.kind === 'set' ? 'owner' : null,
        generation: read.kind === 'set' ? read.record.generation : developmentModeGeneration(home),
        caller_gates_lifted: read.kind === 'set' && read.record.mode === 'local-fast',
        notice: read.kind === 'refused' ? read.why : null,
      });
    } else {
      io.stdout(`${developmentModeStateLine(read)}\n`);
    }
    outcome = read.kind === 'refused' ? 'refused' : 'ok';
  } else if (sub === 'set') {
    const modeArg = args.rest[1];
    const show = args.flags.has('show') || args.flags.has('dry-run');
    const ask = args.flags.has('request') || args.values.approval !== undefined;
    if (args.rest.length !== 2 || !isDevelopmentMode(modeArg)) {
      const why =
        args.rest.length === 2
          ? `the mode must be one of ${VALUES}; got "${plainText(modeArg ?? '')}"`
          : 'usage: team development-mode set <local-fast|pr-per-change|off>';
      if (json) writeJsonError(rawIo, 'development-mode.invocation', why, null);
      else io.stderr(`team development-mode: ${why}\n${USAGE}`);
      outcome = 'invocation';
    } else if (show && ask) {
      // `--show` prints the fingerprint and writes nothing; `--request` and `--approval` apply a
      // switch. Asking for both is an invocation error, not a request.
      const why = '--request and --approval apply a switch, and --show only prints what it would change: pass one';
      if (json) writeJsonError(rawIo, 'development-mode.invocation', why, null);
      else io.stderr(`team development-mode: ${why}\n${USAGE}`);
      outcome = 'invocation';
    } else {
      const mode: DevelopmentMode = modeArg;
      const prior = developmentModeGeneration(home);
      const fingerprint = developmentModeFingerprint(home, mode, prior);
      const read = readDevelopmentMode(home);
      const caller = walkCaller(rawIo);
      const owner = isOwner(caller);
      const token = ownerAuthorized(rawIo.env, fingerprint);
      // The owner-seat door, exactly as `team config set … --request` opens it: the request binds
      // this machine switch to the caller's repository, team, HEAD and words, and the owner's
      // answer to it is the approval. No charter admits this switch (see `ownerSeatStep`).
      let seatApproved = false;
      if (ask) {
        const step = ownerSeatStep('development-mode', 'development-mode', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: false, json }, io, {
          home,
          now: () => options.now ?? new Date(),
          ...(options.ownerSeatStore === undefined ? {} : { ownerSeatStore: options.ownerSeatStore }),
          ...(options.present === undefined ? {} : { present: options.present }),
        });
        if (step.kind === 'requested') {
          return 0; // exit: development-mode.approval-requested
        }
        if (step.kind === 'refused') {
          return 1; // exit: development-mode.approval-refused
        }
        seatApproved = step.kind === 'admitted';
      }

      if (show) {
        // Read-only, and anyone may ask: the agent needs the fingerprint to carry the owner's
        // yes back, exactly as `approve --show` did. Nothing is written and nothing is logged.
        if (json) {
          writeJson(rawIo, 'team.development_mode', {
            format: 1,
            machine: true,
            dry_run: true,
            set: read.kind === 'set',
            mode,
            since: null,
            set_by: null,
            generation: prior,
            caller_gates_lifted: mode === 'local-fast',
            fingerprint,
            notice: read.kind === 'refused' ? read.why : null,
          });
        } else {
          io.stdout(`would set the machine development mode to ${mode}\n`);
          io.stdout(`${developmentModeStateLine(read)}\n`);
          io.stdout(`Owner-authorization fingerprint: ${fingerprint}\n`);
        }
        outcome = 'ok';
      } else if (!owner && !token && !seatApproved) {
        const msg = `only the owner switches the machine development mode, from a terminal outside herdr, or with the owner-authorization token for this exact switch; this call is ${describeCaller(caller)}`;
        if (json) {
          writeJsonError(
            rawIo,
            'development-mode.refused',
            plainText(msg),
            'run `team development-mode set <mode> --show`, have the owner read the fingerprint back, then rerun with TEAM_OWNER_APPROVAL=<fingerprint>',
            1,
            'owner-only',
          );
        } else {
          io.stderr(`team development-mode: ${plainText(msg)}\n`);
        }
        outcome = 'refused';
      } else {
        const written = writeDevelopmentMode({
          home,
          mode,
          now: options.now ?? new Date(),
          caller: auditCaller(caller),
          // The token binds the exact prior generation; a switch that finds it moved refuses.
          ...(token ? { expectGeneration: prior } : {}),
        });
        if (!written.ok) {
          if (json) writeJsonError(rawIo, 'development-mode.refused', plainText(written.why), null, 1, 'owner-only');
          else io.stderr(`team development-mode: ${plainText(written.why)}\n`);
          outcome = 'refused';
        } else {
          const line = `dev mode: ${written.record.mode}, since ${written.record.since}, set by the owner`;
          if (json) {
            writeJson(rawIo, 'team.development_mode', {
              format: 1,
              machine: true,
              dry_run: false,
              set: true,
              mode: written.record.mode,
              since: written.record.since,
              set_by: 'owner',
              generation: written.record.generation,
              previous: written.previous === null ? null : written.previous.mode,
              caller_gates_lifted: written.record.mode === 'local-fast',
              token_authorized: token && !owner,
            });
          } else {
            io.stdout(`${line}${token && !owner ? '; owner-token-authorized' : ''}\n`);
          }
          outcome = 'ok';
        }
      }
    }
  } else {
    const why = `unexpected "${plainText(sub)}"; expected "set", or no subcommand`;
    if (json) writeJsonError(rawIo, 'development-mode.invocation', why, null);
    else io.stderr(`team development-mode: ${why}\n${USAGE}`);
    outcome = 'invocation';
  }

  if (outcome === 'invocation') {
    return 2; // exit: development-mode.invocation
  }
  if (outcome === 'refused') {
    return 1; // exit: development-mode.refused
  }
  return 0; // exit: development-mode.done
}
