// `team sessions`: the sessions TeamCLI recorded for each seat, read across every project state
// folder on this machine. The records are written by the launch and stop commands themselves
// (`up`, `add`, `restart`, `reload`, `down`, `remove`), never from an agent's word; this command
// only reads them. A listing is not a claim about what a seat is doing now: the record's end is
// the last stop TeamCLI saw, and a session whose CLI died without a stop still reads open.
import { readArgs } from '../args.ts';
import { homedir } from 'node:os';
import { auditClientRefusal, authorizeClientRun, clientFormProblem, verifyClientForm } from '../client/client-form.ts';
import { KEY_ISOLATION_LINE } from '../client/records.ts';
import { cleanedIo, type Command, type Io } from '../io.ts';
import {
  hasJsonFlag,
  pluralCount,
  renderTable,
  ttyStyle,
  writeJson,
  writeJsonError,
} from '../output/index.ts';
import { plainText } from '../launch/plain.ts';
import { readAllSessions, readStoreSessions, type SessionRecord } from '../sessions/registry.ts';
import { storePath } from '../store/store.ts';

export const USAGE = `Usage: team sessions [<seat>] [--by <model|team|entity>] [--json]
       team sessions [<seat>] --client <grant-file> --key <client-key> [--team <team>] [--by <model|team|entity>] [--json]

Lists one record per CLI session TeamCLI launched for a seat, across every team on this machine.
The record carries the seat, the team and entity, the CLI and lab, the model, version and
effort, the account it spends, when it started and ended and why, its CLI session id and whether
the CLI can resume it, and, when a command recorded them, its tokens, cost and links. A field no
command measured is absent, and its cost prints as \`unknown\` — never as zero.

\`--by\` groups the listing by model, team or entity. \`<seat>\` narrows it to one seat name.
\`team resume\` is not part of this release.

The --client form is for a client with no terminal that the owner signed a manager bundle grant carrying sessions for: it lists the records of that one team, as signed, and not the other teams on this machine. It changes nothing and never prompts.

Exits 0 when the records are listed, 1 when a session registry can't be read or a client grant is refused, 2 when the invocation can't be read.
`;

export type SessionsSources = {
  home: string;
  now(): Date;
};

export const realSources: SessionsSources = { home: homedir(), now: () => new Date() };

export const sessions: Command = (argv, io) => runSessions(argv, io, realSources);
export default sessions;

export type SessionGroup = 'model' | 'team' | 'entity';

const GROUPS: readonly SessionGroup[] = ['model', 'team', 'entity'];
const SEAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** The `--json` shape of one record. An unknown count or cost is an absent key, never zero. */
export type SessionJson = {
  id: string;
  seat: string;
  nickname?: string;
  team: string;
  project: string;
  entity?: string;
  cli: string;
  lab: string;
  model?: string;
  version?: string;
  effort?: string;
  account: string;
  herdr_session: string;
  pane?: string;
  workspace?: string;
  cli_session?: string;
  resumable?: boolean;
  resume_until?: string;
  handover?: string;
  previous?: string;
  next?: string;
  started: string;
  ended: string | null;
  reason: string | null;
  note?: string;
  tokens?: { in?: number; out?: number; cached?: number; source: 'measured' | 'estimated' };
  cost?: { amount: number; currency: string; source: 'measured' | 'estimated' };
  links?: { commits?: string[]; prs?: string[]; releases?: string[] };
}

export type SessionsJson = {
  format: 1;
  by: SessionGroup | null;
  seat: string | null;
  sessions: SessionJson[];
}

export function sessionJson(record: SessionRecord): SessionJson {
  return {
    id: record.id,
    seat: record.seat,
    ...(record.nickname === undefined ? {} : { nickname: record.nickname }),
    team: record.team,
    project: record.project,
    ...(record.entity === undefined ? {} : { entity: record.entity }),
    cli: record.cli,
    lab: record.lab,
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    account: record.account,
    herdr_session: record.herdr_session,
    ...(record.pane === undefined ? {} : { pane: record.pane }),
    ...(record.workspace === undefined ? {} : { workspace: record.workspace }),
    ...(record.cli_session === undefined ? {} : { cli_session: record.cli_session }),
    ...(record.resumable === undefined ? {} : { resumable: record.resumable }),
    ...(record.resume_until === undefined ? {} : { resume_until: record.resume_until }),
    ...(record.handover === undefined ? {} : { handover: record.handover }),
    ...(record.previous === undefined ? {} : { previous: record.previous }),
    ...(record.next === undefined ? {} : { next: record.next }),
    started: record.ts,
    ended: record.ended ?? null,
    reason: record.reason ?? null,
    ...(record.note === undefined ? {} : { note: record.note }),
    ...(record.tokens === undefined ? {} : { tokens: record.tokens }),
    ...(record.cost === undefined ? {} : { cost: record.cost }),
    ...(record.links === undefined ? {} : { links: record.links }),
  };
}

/** `2026-10-19T14:03:27.512Z` as the table shows it: UTC, to the minute, marked `Z`. */
export function shortStamp(iso: string): string {
  const at = iso.indexOf('T');
  if (at < 0) return iso;
  return `${iso.slice(0, at)} ${iso.slice(at + 1, at + 6)}Z`;
}

/** A cost the registry holds, or the word that says it does not hold one. */
export function costText(cost: SessionRecord['cost']): string {
  if (cost === undefined) return 'unknown';
  const amount = `${cost.amount} ${cost.currency}`;
  return cost.source === 'estimated' ? `${amount} (estimated)` : amount;
}

function groupOf(record: SessionRecord, by: SessionGroup): string {
  if (by === 'model') return record.model ?? 'unknown model';
  if (by === 'team') return record.team;
  return record.entity ?? 'no entity';
}

/** The records in group order, then start order; without `--by`, start order alone. */
export function groupSessions(
  records: readonly SessionRecord[],
  by: SessionGroup | null,
): { group: string | null; sessions: SessionRecord[] }[] {
  if (by === null) return [{ group: null, sessions: [...records] }];
  const groups = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const name = groupOf(record, by);
    const held = groups.get(name);
    if (held === undefined) groups.set(name, [record]);
    else held.push(record);
  }
  return [...groups.keys()]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => ({ group: name, sessions: groups.get(name) as SessionRecord[] }));
}

export async function runSessions(argv: string[], io: Io, sources: SessionsSources = realSources): Promise<number> {
  const out = cleanedIo(io);
  const args = readArgs(argv, ['by', 'client', 'key', 'team'], ['json']);
  const json = hasJsonFlag(argv);
  const byValue = args.values.by;
  const clientProblem = args.error === undefined ? clientFormProblem(args.values, 'team sessions --client <grant-file> --key <client-key-file>') : null;
  const by = GROUPS.find((one) => one === byValue);
  const seat = args.rest[0];
  // One refusal site for every malformed invocation: the contract row names this return once.
  const malformed = args.error !== undefined
    || args.rest.length > 1
    || clientProblem !== null
    || (byValue !== undefined && by === undefined)
    || (seat !== undefined && !SEAT.test(seat));
  if (malformed) {
    const why = plainText(
      args.error
        ?? (args.rest.length > 1
          ? `unexpected "${args.rest[1]}"`
          : clientProblem !== null
            ? clientProblem
            : seat !== undefined && !SEAT.test(seat)
              ? `"${seat}" is not a seat name`
              : `--by must be one of ${GROUPS.join(', ')}`),
    );
    const repair = seat !== undefined && !SEAT.test(seat)
      ? 'a seat name reads like a role: letters, digits, dot, dash or underscore'
      : 'run team sessions [<seat>] [--by model|team|entity]';
    if (json) writeJsonError(io, 'sessions.invocation', why, repair);
    else out.stderr(`team sessions: ${why}\n${USAGE}`);
    // exit: sessions.invocation
    return 2;
  }

  // The client form: a manager grant the owner signed for ONE team at ONE folder, proven by the client's
  // own key and verified whole before anything is read. The records it lists are that team's own store,
  // never the machine-wide listing the owner's run reads.
  let read: ReturnType<typeof readAllSessions>;
  if (args.values.client !== undefined) {
    if (!json) io.stderr(`${KEY_ISOLATION_LINE}\n`);
    const at = sources.now();
    const verified = verifyClientForm({ home: sources.home, now: at }, { op: 'sessions', values: args.values, cwd: io.cwd });
    const stood = verified.ok ? authorizeClientRun(sources.home, verified.run, 'sessions', at) : null;
    if (!verified.ok || stood !== null) {
      const why = plainText(verified.ok ? stood! : verified.why);
      auditClientRefusal('sessions', verified.ok ? verified.run.grant : verified.named, why, at);
      if (json) writeJsonError(io, 'sessions.client-refused', why, null);
      else out.stderr(`team sessions: ${why}\n`);
      // exit: sessions.client-refused
      return 1;
    }
    const { grant } = verified.run;
    if (!json) io.stderr(`client grant ${grant.grantId}: ${grant.clientId} for team ${grant.up.project} at ${verified.run.root}, until ${grant.expires}\n`);
    read = readStoreSessions(storePath(grant.up.project, grant.up.root, sources.home), sources.home);
  } else {
    read = readAllSessions(sources.home);
  }
  if (!read.ok) {
    if (json) writeJsonError(io, 'sessions.read', read.reason, null);
    else out.stderr(`team sessions: ${read.reason}\n`);
    // exit: sessions.read
    return 1;
  }
  const matching = seat === undefined ? read.sessions : read.sessions.filter((record) => record.seat === seat);
  const grouped = groupSessions(matching, by ?? null);

  if (!json) {
    const lines: string[] = [pluralCount(matching.length, 'session')];
    if (matching.length > 0) {
      const style = ttyStyle(io, { json: false });
      grouped.forEach((section, index) => {
        if (section.group !== null) {
          if (index > 0) lines.push('');
          lines.push(`${by}: ${section.group}`);
        }
        lines.push(...renderTable({
          headers: ['SESSION', 'SEAT', 'TEAM', 'MODEL', 'STARTED', 'ENDED', 'WHY', 'COST'],
          rows: section.sessions.map((record) => [
            record.id,
            record.seat,
            record.team,
            record.model ?? '-',
            shortStamp(record.ts),
            record.ended === undefined ? '-' : shortStamp(record.ended),
            record.reason ?? '-',
            costText(record.cost),
          ]),
          style,
        }));
      });
    }
    // Through `io`, not the cleaned view: the style above is this io's TTY style.
    io.stdout(`${lines.join('\n')}\n`);
  } else {
    const payload: SessionsJson = {
      format: 1,
      by: by ?? null,
      seat: seat ?? null,
      sessions: grouped.flatMap((section) => section.sessions).map(sessionJson),
    };
    writeJson(io, 'team.sessions', payload);
  }
  if (matching.length === 0) {
    // exit: sessions.none
    return 0;
  }
  // exit: sessions.shown
  return 0;
}
