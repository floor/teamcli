// `team settings <seat>` — one seat's settings and where each value comes from. It reads the
// live team file and the registry and writes nothing: the write verbs (`set`, `unset`) arrive
// with the signed-record store the decision leaves open.
//
// The read is the composition in `src/config/compose.ts`; this module only decides who may read
// it, which team file it reads, and how the rows print.

import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { fileOwnerRefusal, isOwner, walkCaller } from '../caller.ts';
import { readSeatSettings } from '../config/read.ts';
import { sayApply, sayConfigOrigin, sayConfigValue } from '../config/text.ts';
import type { DelegateSources } from '../delegate.ts';
import { currentTeam } from '../file/current.ts';
import { isParseError } from '../file/load.ts';
import type { Problem } from '../file/types.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import { hasJsonFlag, renderTable, ttyStyle, writeJson, writeJsonError } from '../output/index.ts';
import { mayReadTeam } from '../read-gate.ts';

export const USAGE = `Usage: team settings <seat> [--file <path>] [--json]

Prints the seat's settings and where each value comes from: the team file, the team's own order, the release default, or unset. Reads the live team file and changes nothing.

Exits 0 when the settings are printed, 1 when the seat is not declared or the file is the owner's, 2 when the invocation or the team file is invalid.
`;

export type SettingsCommandOptions = {
  home?: string;
  now?: Date;
  /** The read gate's own sources, when a test stands in for the machine: the same shape
   *  `team seats` takes, so a scene can place the caller without a real herdr. */
  gate?: DelegateSources;
};

export const settings: Command = (argv, io) => runSettings(argv, io);
export default settings;

export async function runSettings(
  argv: string[],
  rawIo: Io,
  options: SettingsCommandOptions = {},
): Promise<number> {
  const io = cleanedIo(rawIo);
  const json = hasJsonFlag(argv);
  const args = readArgs(argv, ['file'], ['json']);
  if (args.error !== undefined || args.rest.length !== 1) {
    const why = args.error
      ?? (args.rest.length === 0 ? 'a seat name is required' : `unexpected "${args.rest[1]}"`);
    if (json) {
      writeJsonError(io, 'settings.invocation', why, null);
    } else {
      io.stderr(`team settings: ${why}\n${USAGE}`);
    }
    // exit: settings.invocation
    return 2;
  }
  const seatName = args.rest[0] as string;

  const walked = walkCaller(io);
  const owner = isOwner(walked);
  if (args.values.file !== undefined) {
    const refusal = fileOwnerRefusal(io, args.values.file);
    if (refusal !== undefined) {
      if (json) {
        writeJsonError(io, 'settings.file-owner', refusal, 'the owner runs `team settings <seat> --file <path>` from a terminal outside herdr', 1, 'owner-only');
      } else {
        io.stderr(`team settings: ${refusal}\n`);
      }
      // exit: settings.file-owner
      return 1;
    }
  }

  const home = options.home ?? homedir();
  const now = options.now ?? new Date();
  const current = currentTeam(io.cwd, owner ? args.values.file : undefined, now, home, owner);
  if (!owner) {
    if (!current.ok || !mayReadTeam(current, io, options.gate !== undefined ? { home, gate: options.gate } : { home })) {
      if (json) {
        writeJsonError(io, 'settings.not-yours', 'this team is not yours to read', null);
      } else {
        io.stderr('team settings: this team is not yours to read\n');
      }
      // exit: settings.not-yours
      return 2;
    }
  } else if (!current.ok) {
    const id = current.errors[0]?.message.includes('not inside a git repository')
      ? 'settings.not-a-repo'
      : current.errors.some(isParseError)
        ? 'settings.file-invalid'
        : 'settings.file';
    if (json) {
      const msg = current.errors.map((p) => `${p.line ? `team.yaml line ${p.line}: ` : ''}${p.message}`).join('; ');
      writeJsonError(io, id, msg, null);
    } else {
      printProblems(io, current.errors);
    }
    // exit: settings.not-a-repo
    // exit: settings.file
    // exit: settings.file-invalid
    return 2;
  }

  const { team } = current;
  const seat = team.seats.find((one) => one.name === seatName);
  if (seat === undefined) {
    const message = `no seat "${seatName}" is declared in ${team.project}`;
    if (json) {
      writeJsonError(io, 'settings.no-seat', message, null);
    } else {
      io.stderr(`team settings: ${message}\n`);
    }
    // exit: settings.no-seat
    return 1;
  }

  if (!json && current.notice !== undefined) io.stdout(`${current.notice}\n`);

  const read = readSeatSettings({
    home,
    root: current.root,
    project: team.project,
    seat,
    teamDeliveryOrder: team.deliveryOrder,
  });
  if (!read.ok) {
    if (json) {
      writeJsonError(io, 'settings.source', read.refusals.map((one) => one.why).join('; '), null);
    } else {
      for (const refusal of read.refusals) io.stderr(`team settings: ${refusal.why}\n`);
    }
    // exit: settings.source
    return 2;
  }
  const rows = read.rows;
  if (json) {
    writeJson(io, 'team.settings', {
      format: 1,
      project: team.project,
      seat: seat.name,
      settings: rows.map((row) => ({
        key: row.key,
        value: row.value,
        source: row.origin,
        applies: row.applies,
        ...(row.sourceFile !== undefined ? { source_file: row.sourceFile } : {}),
      })),
    });
  } else {
    const style = ttyStyle(io, { json });
    const lines = renderTable({
      headers: ['KEY', 'VALUE', 'SOURCE', 'APPLIES'],
      rows: rows.map((row) => [row.key, sayConfigValue(row.value), sayConfigOrigin(row.origin), sayApply(row.applies)]),
      style,
    });
    io.stdout(`${lines.join('\n')}\n`);
  }
  // exit: settings.shown
  return 0;
}

function printProblems(io: Io, problems: Problem[]): void {
  for (const problem of problems) {
    io.stderr(`team settings: ${problem.line ? `team.yaml line ${problem.line}: ` : ''}${problem.message}\n`);
  }
}
