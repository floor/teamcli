// The general door: one place, in the dispatcher, where every command accepts a general grant.
// `team <command> ... --general <grant.json> --key <client.key>` is verified here with
// `admitGeneral` for the command's own op and the entity of the team in this folder; an admitted
// run reaches the command as the owner (its caller is the owner, so no detached or terminal
// refusal applies), with the two options taken off its argv. A command added later is covered
// the same way, with no wiring of its own.
//
// Left to the command itself: `up`, `init` and `config`, which read `--general` with their own
// admission (an owner-seat-shaped launch, a first record, a signed edit). Never admitted here:
// `team client general-grant`, the one command that issues grants — a grant never issues itself.
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Io } from '../io.ts';
import { readTeamConfig } from '../file/team-config.ts';
import { admitGeneral, type GeneralGrant, type GeneralOp } from './general-grant.ts';

/** Commands that parse `--general` themselves. */
export const OWN_GENERAL = new Set(['up', 'init', 'config']);

/** Whether this command line is the grant-issuing command, which no general grant admits. */
export function issuesGrants(name: string, rest: readonly string[]): boolean {
  return name === 'client' && rest.find((word) => !word.startsWith('-')) === 'general-grant';
}

export type Door =
  | { kind: 'pass'; argv: string[]; io: Io }
  | { kind: 'usage'; why: string; json: boolean }
  | { kind: 'refused'; why: string; json: boolean }
  | { kind: 'admitted'; argv: string[]; io: Io; grant: GeneralGrant; json: boolean };

/** One option's value, `--name v` or `--name=v`, and the argv without it. */
function take(argv: string[], name: string): { value: string | undefined; present: boolean; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  let present = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i] as string;
    if (word === `--${name}`) {
      present = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { value = next; i++; }
      continue;
    }
    if (word.startsWith(`--${name}=`)) { present = true; value = word.slice(name.length + 3); continue; }
    rest.push(word);
  }
  return { value, present, rest };
}

function entityHere(io: Io, home: string): string | null {
  try {
    const here = readTeamConfig(io.cwd, { home, checkOnly: true });
    return here.ok ? here.team.entity ?? null : null;
  } catch {
    return null;
  }
}

/** The door's verdict for `team <name> <rest>`. Without `--general` it passes the line untouched. */
export function generalDoor(name: string, rest: string[], io: Io, now: Date = new Date()): Door {
  if (OWN_GENERAL.has(name)) return { kind: 'pass', argv: rest, io };
  const general = take(rest, 'general');
  if (!general.present) return { kind: 'pass', argv: rest, io };
  const json = rest.includes('--json') || rest.some((word) => word.startsWith('--json='));
  if (issuesGrants(name, rest)) return { kind: 'usage', why: 'team client general-grant issues grants and takes no --general (a holder issues with --via <grant.json> --key <client.key>)', json };
  if (general.value === undefined) return { kind: 'usage', why: '--general takes <grant.json>', json };
  const key = take(general.rest, 'key');
  if (!key.present || key.value === undefined) return { kind: 'usage', why: '--general needs --key <client.key>', json };
  const home = io.env.HOME ?? homedir();
  const grantPath = resolve(io.cwd, general.value);
  const keyPath = resolve(io.cwd, key.value);
  const admitted = admitGeneral(home, grantPath, keyPath, name as GeneralOp, entityHere(io, home), now);
  if (!admitted.ok) return { kind: 'refused', why: admitted.why, json };
  return { kind: 'admitted', argv: key.rest, io: { ...io, caller: { kind: 'owner' }, general: { grant: grantPath, key: keyPath } }, grant: admitted.grant, json };
}
