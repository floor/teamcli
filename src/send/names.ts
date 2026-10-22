// Readable sender names: the one place a sender is rendered for people.
//
// A send writes two things about who wrote it: the signed record's `from` and `from_id` fields —
// the seat's name and the registry's own id — and the body's first line, the headline a person
// reads. The record keeps the id wherever TeamCLI prints a sender; only that headline changes,
// and it changes to a name a person can read: the seat's nickname, its seat name, or its
// `seat@team` address, by the project's `sender_name` word.
//
// The word is read nearest first — the reading seat's key, the team file's key, the project
// registry's word — and defaults to `auto`: inside the seat's own team a sender reads as its
// nickname (the seat name when the file writes none), and from another team as `seat@team`,
// because nicknames are unique only inside one team. `nickname` always reads the nickname,
// `seat` always the seat name, and `seat@team` always the address.
//
// TeamCLI resolves the nickname from the team registry's roster, where sync projects the file's
// `nickname` field, and the team's name from the record's `project` — the team file's own
// `project:` key. A seat's signed `nickname` setting is its own word and stands over that
// projection. A record read from disk carries the seat and the agent id, never the team: the
// roster line the id sits on is where its team is found. A registry that cannot answer is no
// answer: the seat name stands, and a team no record names reads as its id, exactly as an
// earlier build printed it.

import { seatOverridesOf } from '../config/apply.ts';
import { loadTeamFile } from '../file/load.ts';
import type { TeamFile } from '../file/types.ts';
import { ofTeam as projectOfTeam, type ProjectRecord } from '../registry/projects.ts';
import { readTeams, teamIdOf, type TeamRecord } from '../registry/teams.ts';
import { DEFAULT_SENDER_NAME, isSenderNameMode, type SenderNameMode } from '../settings/inherit.ts';

/** The project's word, with the default standing when the record declares none. A word this
 *  build cannot read never reaches here: the record's reader refuses it, and a record read by an
 *  older build is read as no word rather than guessed at. */
export function senderNameModeOf(project: Pick<ProjectRecord, 'senderName'> | null | undefined): SenderNameMode {
  const word = project?.senderName;
  return isSenderNameMode(word) ? word : DEFAULT_SENDER_NAME;
}

/** One sender as the rule reads it: the seat's name, the team it sits in (by team id, when a
 *  record names it), and the agent's registry id, when one is known. The id is the record's own
 *  identity and finds the roster line the nickname sits on; the printed name never carries it. */
export type SenderIdentity = {
  seat: string;
  team?: string | null;
  id?: string | null;
};

/** What a reading needs: the word in force, the team whose command is printing (its id), and the
 *  registered teams, whose roster lines hold both the nickname and the team's own name. A
 *  reading over a real registry also carries the seat's *signed* nickname, when one is set: the
 *  roster line is the team file's projection, and a signed setting stands in its place. */
export type SenderNaming = {
  mode: SenderNameMode;
  viewerTeam: string | null;
  teams: Readonly<Record<string, TeamRecord>>;
  /** The nickname a sender's signed seat record holds, or null; absent reads the roster alone. */
  signedNickname?: (sender: SenderIdentity, team: string | null) => string | null;
};

/** No project word, no registry: a reading that knows only the sender's seat and team. */
export function defaultNaming(viewerTeam: string | null = null): SenderNaming {
  return { mode: DEFAULT_SENDER_NAME, viewerTeam, teams: {} };
}

/**
 * The team a sender sits in: the registry's roster line that holds it — by the agent id first,
 * because ids are unique across the registry, then by the seat name inside the reader's own team,
 * and last by a seat name only one team declares — and a record's own team field when no roster
 * holds the id. A name more than one team could claim and no id to tell them apart is no answer,
 * and the reading falls back to the seat alone. A sender read from a record carries no team of its
 * own: the drop and the mailbox hold the seat and the id, and the roster is where the id's team
 * is found.
 */
function teamOf(sender: SenderIdentity, naming: SenderNaming): string | null {
  const teams = naming.teams;
  // The id first: it is unique across the registry, while a record's own team field may name a
  // team this machine's registry does not hold yet — a stale id would hide the roster line that
  // knows both the nickname and the team's name.
  if (sender.id) {
    for (const [id, team] of Object.entries(teams)) {
      if (team.roster.some((line) => line.agent === sender.id)) return id;
    }
  }
  if (sender.team != null) return sender.team;
  if (naming.viewerTeam !== null && teams[naming.viewerTeam]?.roster.some((line) => line.seat === sender.seat)) {
    return naming.viewerTeam;
  }
  const holders = Object.entries(teams).filter(([, team]) => team.roster.some((line) => line.seat === sender.seat));
  return holders.length === 1 ? (holders[0]?.[0] ?? null) : null;
}

/** The nickname a team's roster gives a sender: by the agent id when it is known, else by the
 *  seat name — one team holds at most one line per seat, and the file refuses a repeated
 *  nickname. A signed seat setting is the seat's own word and stands over the roster's, which is
 *  the file's projection; a record that does not verify says nothing here, the same way a send
 *  never fails on a broken record. Null when neither the record nor the roster holds one. */
function nicknameOf(sender: SenderIdentity, team: string | null, naming: SenderNaming): string | null {
  const signed = naming.signedNickname?.(sender, team) ?? null;
  if (signed !== null) return signed;
  const record = team ? naming.teams[team] : undefined;
  if (!record) return null;
  const byId = sender.id ? record.roster.find((line) => line.agent === sender.id) : undefined;
  const line = byId ?? record.roster.find((entry) => entry.seat === sender.seat);
  return line?.nickname ?? null;
}

/** The nickname a reading resolves for one sender, and nothing else: null when neither the
 *  signed seat record nor the roster holds one. A caller that prints another name in the
 *  nickname's place reads this first, so an absent nickname is told from one spelled like the
 *  seat name; `senderDisplayName` renders both the same way on purpose. */
export function senderNickname(sender: SenderIdentity, naming: SenderNaming): string | null {
  return nicknameOf(sender, teamOf(sender, naming), naming);
}

/** The team's own name — the team file's `project:` key — or the id no record names, the same
 *  spelling an earlier build printed. */
function teamNameOf(team: string, teams: Readonly<Record<string, TeamRecord>>): string {
  return teams[team]?.project ?? team;
}

/**
 * The name a person reads for one sender, under the word in force. The four words:
 *
 *   - `seat` — the seat's name, always;
 *   - `seat@team` — the address, `<seat>@<team>` (the seat alone when no record names the team);
 *   - `nickname` — the nickname, or the seat name when the file writes none;
 *   - `auto` — the nickname (or the seat name) inside the reader's own team, and `seat@team`
 *     from another team: nicknames are unique only inside one team, so a bare nickname from
 *     elsewhere would not say whom it names. A team the registry does not hold is no answer,
 *     and the sender reads as inside the reader's team.
 */
export function senderDisplayName(sender: SenderIdentity, naming: SenderNaming): string {
  const seat = sender.seat;
  const team = teamOf(sender, naming);
  const address = team === null ? seat : `${seat}@${teamNameOf(team, naming.teams)}`;
  switch (naming.mode) {
    case 'seat':
      return seat;
    case 'seat@team':
      return address;
    case 'nickname':
      return nicknameOf(sender, team, naming) ?? seat;
    case 'auto':
    default: {
      // Another team only when the registry holds it: an id no roster answers for is no answer,
      // and the seat's own team — whose roster then names it — is the reading that stands.
      const otherTeam = team !== null && team !== naming.viewerTeam && naming.teams[team] !== undefined;
      return otherTeam ? address : nicknameOf(sender, team, naming) ?? seat;
    }
  }
}

/**
 * The display name a seat's own session carries: the same four words read inside the seat's own
 * team, where the file's nickname is at hand. `auto` and `nickname` are the nickname (the seat
 * name when the file writes none), `seat` is the seat name, and `seat@team` the address with the
 * team's own name. A CLI launched with it shows a person where a message came from without
 * reading a registry id.
 */
export function sessionDisplayName(input: {
  seat: string;
  nickname?: string | null;
  /** The seat's team, by team id. */
  team: string | null;
  /** The team's own name — the file's `project:` key — when the caller holds it. */
  teamName?: string | null;
  mode: SenderNameMode;
}): string {
  const name = input.nickname ?? input.seat;
  switch (input.mode) {
    case 'seat':
      return input.seat;
    case 'seat@team':
      return input.team === null ? input.seat : `${input.seat}@${input.teamName ?? input.team}`;
    case 'nickname':
    case 'auto':
    default:
      return name;
  }
}

/**
 * The word a reading seat reads by, the chain read nearest first: the seat's own `sender_name`
 * key, then the team file's, then the project registry record's word — and `auto` when none
 * declares one. The entity and machine levels are silent in this build, as they are for the
 * delivery order. Every read is tolerant: a file that cannot be loaded and a registry that
 * cannot answer are no word, never a failed command, because the word says how a name is
 * printed, never whether the command may run.
 *
 * `file` is the team file when the caller already holds it; a cross-team reading passes the
 * receiving team's file loaded from its root. `seat` is the reading seat — the receiving seat
 * for a send, the caller for a listing; absent, only the team's and the project's words count.
 */
export function senderNameModeFor(input: {
  /** The home the registry is read under; absent, only the file's words and a handed-in reader
   *  answer, and the chain stops at `auto` rather than reaching for another home. */
  home?: string;
  root: string;
  seat?: string | null;
  file?: TeamFile | null;
  /** The team the reading belongs to, when the caller already knows it. */
  team?: string | null;
  projectOfTeam?: (teamId: string) => ProjectRecord | null;
}): SenderNameMode {
  let file: TeamFile | null = input.file ?? null;
  if (file === null) {
    try {
      const loaded = loadTeamFile(input.root, input.home === undefined ? {} : { home: input.home });
      file = loaded.ok ? loaded.team : null;
    } catch {
      file = null;
    }
  }
  const seatWord = input.seat ? file?.seats.find((one) => one.name === input.seat)?.senderName : undefined;
  if (seatWord !== undefined) return seatWord;
  if (file?.senderName !== null && file?.senderName !== undefined) return file.senderName;
  let team = input.team ?? null;
  if (team === null) {
    try {
      team = teamIdOf(input.root);
    } catch {
      team = null;
    }
  }
  if (team === null) return DEFAULT_SENDER_NAME;
  try {
    if (input.projectOfTeam) return senderNameModeOf(input.projectOfTeam(team));
    if (input.home === undefined) return DEFAULT_SENDER_NAME;
    return senderNameModeOf(projectOfTeam(input.home, team));
  } catch {
    return DEFAULT_SENDER_NAME;
  }
}

/** The project's word for the team at `root`, read tolerantly: a registry that cannot answer is
 *  the default word, so a launch never fails on the setting. */
export function senderNameModeAt(home: string, root: string, seat?: string | null): SenderNameMode {
  return senderNameModeFor({ home, root, ...(seat === undefined ? {} : { seat }) });
}

/**
 * The signed nickname a reading resolves, looked up per sender and kept for the life of the
 * reading: a listing prints many rows from few seats, and each seat's chain is verified once. The
 * team record's root and the roster line's seat name are what find the agent record; a seat no
 * roster holds has no signed word here, and a record that does not verify says nothing, so the
 * roster's projection stands — a display never fails on a broken record.
 */
export function signedNicknames(
  home: string,
  teams: Readonly<Record<string, TeamRecord>>,
): NonNullable<SenderNaming['signedNickname']> {
  const answers = new Map<string, string | null>();
  return (sender, team) => {
    const record = team ? teams[team] : undefined;
    if (record === undefined) return null;
    const line = (sender.id ? record.roster.find((entry) => entry.agent === sender.id) : undefined)
      ?? record.roster.find((entry) => entry.seat === sender.seat);
    if (line === undefined) return null;
    const key = `${record.root}\u0000${line.seat}`;
    if (answers.has(key)) return answers.get(key) ?? null;
    const nickname = seatOverridesOf({ home, root: record.root, seat: line.seat }).nickname ?? null;
    answers.set(key, nickname);
    return nickname;
  };
}

/**
 * The naming a reading across teams uses — the feed's `--all`, or one run outside a checkout:
 *  the registry's rosters, no viewer team and no project word. A sender in a team the registry
 *  holds reads as `seat@team`, its single honest address with no own team to compare; one no
 *  roster holds reads as its seat. A registry that cannot answer is the empty reading, never a
 *  failed command. */
export function namingAcross(home: string): SenderNaming {
  try {
    const teams = readTeams(home);
    return { mode: DEFAULT_SENDER_NAME, viewerTeam: null, teams, signedNickname: signedNicknames(home, teams) };
  } catch {
    return defaultNaming();
  }
}

/**
 * The naming a command in `root` reads, from the files on this machine: the receiving team's own
 * id, the team records, and the word of the project that team sits in. A registry that cannot
 * answer is no answer — the default word and the seat names stand — because a display must not
 * fail a command the way a broken registry fails the commands that act. A caller that already
 * holds a reading hands it in: `teams`, `viewerTeam`, and the `projectOfTeam` its own sources
 * answer with, the way `src/send/delivery.ts` takes the receiving team's chain.
 */
export function namingFor(input: {
  home: string;
  root: string;
  /** The team registry's reading, when the caller already holds it. */
  teams?: Readonly<Record<string, TeamRecord>>;
  /** The project a team sits in, when the caller already has a reader for it. */
  projectOfTeam?: (teamId: string) => ProjectRecord | null;
  /** The team whose command is printing; read from `root` when absent. */
  viewerTeam?: string | null;
  /** The seat the reading serves, whose own word is the nearest in the chain. */
  seat?: string | null;
  /** The reading team's file, when the caller already holds it. */
  file?: TeamFile | null;
}): SenderNaming {
  let viewerTeam: string | null = input.viewerTeam ?? null;
  if (viewerTeam === null) {
    try {
      viewerTeam = teamIdOf(input.root);
    } catch {
      viewerTeam = null;
    }
  }
  let teams: Readonly<Record<string, TeamRecord>> = input.teams ?? {};
  if (!input.teams) {
    try {
      teams = readTeams(input.home);
    } catch {
      teams = {};
    }
  }
  const mode = senderNameModeFor({
    home: input.home,
    root: input.root,
    team: viewerTeam,
    ...(input.seat === undefined ? {} : { seat: input.seat }),
    ...(input.file === undefined ? {} : { file: input.file }),
    ...(input.projectOfTeam === undefined ? {} : { projectOfTeam: input.projectOfTeam }),
  });
  return { mode, viewerTeam, teams, signedNickname: signedNicknames(input.home, teams) };
}
