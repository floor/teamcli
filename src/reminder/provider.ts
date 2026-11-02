// The daemon's reminder reader: the entity record parsed into specs, re-read when the file
// changes and held between beats. Reading the owner's file and resolving every address on each
// five-second beat would be work no change asked for, and a refused entry would be logged every
// beat; the file's own stamp decides when the read happens, so one broken line is named once, on
// the change that wrote it, and an untouched file quietens the beat.
//
// A change in the registry (a team renamed, a seat recorded) is not a change in this file. The
// list is re-resolved at the next read; between reads an address that stopped resolving is
// refused by the daemon's admission at the fire, with the seat named, so a stale target is
// recorded as a refusal rather than sent.
import { statSync } from 'node:fs';
import { entitiesPath } from '../entities.ts';
import { machineZone, readReminderConfig } from './config.ts';
import { resolveReminderEntries } from './resolve.ts';
import type { ReminderSpec } from './run.ts';

/** The beat's log, handed to the reader so a refused reminder is named where the daemon logs. */
export type ReminderProviderLog = (line: string) => void;

export type ReminderProvider = (log: ReminderProviderLog) => readonly ReminderSpec[];

export type ReminderProviderInput = {
  /** The home whose entity record is read; the daemon's own. */
  home: string;
  /** The canonical checkouts this daemon hosts: a target outside them refuses the reminder at
   *  the read, before any fire. Absent, hosting is left to the send's admission. */
  hosted?: readonly string[];
  /** The zone a reminder without one of its own is read in; the machine's when absent. */
  defaultZone?: string;
};

export function createReminderProvider(input: ReminderProviderInput): ReminderProvider {
  let stamp: string | null = null;
  let read = false;
  let specs: readonly ReminderSpec[] = [];
  return (log) => {
    const next = stampOf(input.home);
    if (read && next === stamp) return specs;
    read = true;
    stamp = next;
    try {
      const config = readReminderConfig(input.home, { defaultZone: input.defaultZone ?? machineZone() });
      for (const problem of config.problems) log(`reminders: ${problem.why}`);
      const resolved = input.hosted === undefined
        ? resolveReminderEntries(input.home, config.entries)
        : resolveReminderEntries(input.home, config.entries, { hosted: input.hosted });
      for (const problem of resolved.problems) log(`reminders: ${problem.why}`);
      specs = resolved.specs;
    } catch (error) {
      // An unexpected failure keeps the list the last good read produced and says so once, on
      // the change that caused it: the file's stamp has moved, so the next beat is quiet.
      const why = error instanceof Error ? error.message : String(error);
      log(`reminders: the configured list could not be read — ${why}; keeping the previous list`);
    }
    return specs;
  };
}

/** The entity record's stamp: its modification time and size, or a word for an absent file. A
 *  read that cannot stat the file is a change like any other, so the read runs and names what
 *  the file's own reader reports. */
function stampOf(home: string): string {
  try {
    const stat = statSync(entitiesPath(home));
    return `${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return 'absent';
  }
}
