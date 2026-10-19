// The command-to-capability map: the decision record's table as code — one row per command,
// each saying what admits a caller before any caller is read, and the words a refusal repeats
// (decided-grants-minimum-2026-10-17, point (f); the Kernel's table, §9). The record's rows are
// the first block below; 0.5.2 adds a row for every remaining CLI word, read from the gate the
// word's own module applies, so the contract (`contract/cli.json`) can state who may run every
// word the adapter exposes. The map stays closed: a word with no row here is still refused by
// the resolver (src/permissions/resolve.ts) rather than judged, and the code invents no
// capability. A command whose verbs gate differently carries a `command:subcommand` row for
// each verb, and a subcommand node of the contract repeats that row. The vocabulary's own half
// — the eight grantable words — is imported from grants.ts, the one source both sides share: a
// grant carries only the names in that list, and the map's rows for them are those same names,
// as commands. The four administrative names a team grant never carries (`grant`, `create`,
// `agree`, `leads`, grants.ts's TEAM_GRANT_FORBIDDEN) are a different namespace: they are
// never capability words, and `create` — named in the record's init row "where it exists" — is
// today no command, so the map holds no row for it.
import { GRANT_CAPABILITIES } from './grants.ts';

/** The grantable capabilities, as the map's vocabulary: the eight words a grant may carry, and
 *  the only names a grant may use. */
export type Capability = (typeof GRANT_CAPABILITIES)[number];

/** Whether a word is one of the eight. */
export function isCapability(word: string): word is Capability {
  return (GRANT_CAPABILITIES as readonly string[]).includes(word);
}

/** What admits a caller to one command, before any caller is read, and the words a refusal
 *  repeats. The gate is what the record's table says under "authorised by (0.5.0)". The
 *  `admission` and `pane-authority` rows name the gate that owns their commands: this map
 *  admits no one to either, and the resolver refuses them with the owner named.
 *
 *  The rows added in 0.5.2 are named after the verdict function their command's module calls,
 *  never a rule copied by hand, so a row cannot admit a caller its module refuses:
 *  `any-caller` asks for no record at all; `seat-only` admits a seat of the team on its
 *  recorded pane and not the owner; `leads-only` admits a seat the file marks `leads` and not
 *  the owner; `team-change` is `mayChangeTeamVerdict` (the owner, the orchestrator's seat or
 *  the operator's seat, on its recorded pane); `team-pause` is `mayPauseTeamVerdict` (the
 *  owner or the orchestrator's seat, on its recorded pane — the operator is not admitted);
 *  `team-read` is `mayReadTeam` (a seat the state
 *  places on its recorded pane, or an approved delegate pane). A row may also carry
 *  `terminal`: the module refuses a run with no terminal through `detachedRefusal`, and the
 *  requirement stands on top of the kind (`watch` is any caller with a terminal or its own
 *  pane). */
export type GateTerminal = { who: string; where: string };

export type Gate = (
  | { kind: 'owner-only'; why: string }
  | { kind: 'owner-or-leads'; why: string }
  | { kind: 'owner-or-own-team'; why: string }
  | { kind: 'seat-record'; why: string }
  | { kind: 'capability'; why: string }
  | { kind: 'admission'; why: string }
  | { kind: 'pane-authority'; why: string }
  | { kind: 'any-caller'; why: string }
  | { kind: 'seat-only'; why: string }
  | { kind: 'leads-only'; why: string }
  | { kind: 'team-change'; why: string }
  | { kind: 'team-pause'; why: string }
  | { kind: 'team-read'; why: string }
) & {
  /** A run with no terminal is refused, by the same `detachedRefusal` the module calls. */
  terminal?: GateTerminal;
};

/** The nine read surfaces the record names; each admits any seat with a registry record. Two
 *  of them — `available`, `waits` — are Runtime words the table names and no command module
 *  exists for yet; their rows stand all the same, because the map is the table. */
const READ_SURFACES = ['messages', 'feed', 'status', 'list', 'check', 'usage', 'available', 'next', 'waits'] as const;

/** The whole map: the command's own word (the CLI's, src/commands/*) to what admits it. */
export const COMMAND_GATES: Readonly<Record<string, Gate>> = buildGates();

function buildGates(): Record<string, Gate> {
  const gates: Record<string, Gate> = {
    init: {
      kind: 'owner-only',
      why: 'writing a team where none exists is the owner\'s act in 0.5.0: no create-bounds exist yet, so no agent holds `create`',
    },
    up: {
      kind: 'owner-or-leads',
      why: '`start`: it runs the hash-pinned start command, and an operation is reached only through `leads` held in a role, never through a grant',
    },
    down: {
      kind: 'owner-or-leads',
      why: '`stop`: the owner or `leads` for its own team, and the owner may always stop',
    },
    restart: {
      kind: 'owner-or-leads',
      why: 'the `start` row for a seat: as `start`',
    },
    reload: {
      kind: 'owner-or-leads',
      why: 'the `start` row for a running seat, as `restart`: closing and relaunching one seat is the same act',
    },
    add: {
      kind: 'owner-only',
      why: 'adding a seat is the owner\'s in 0.5.0, where no `agree` or `grant` holders stand',
    },
    remove: {
      kind: 'owner-or-leads',
      why: 'removing a seat: the owner or `leads`; a seat holding `grant`, `agree` or `leads` stands only by the owner',
    },
    rename: {
      kind: 'owner-or-leads',
      why: 'renaming a seat: the owner or `leads` for its own team',
    },
    register: {
      kind: 'owner-or-own-team',
      why: 'a registry record is a report and confers no right: the owner, or the seat\'s own team',
    },
    grant: {
      kind: 'owner-only',
      why: 'granting is the approval, and the owner grants alone in 0.5.0',
    },
    revoke: {
      kind: 'owner-only',
      why: 'removing a standing grant is the owner\'s edit, and the revocation channel of 0.5.0 is the owner at a terminal',
    },
    delegate: {
      kind: 'owner-only',
      why: 'a standing grant with a command list, written against this map: the owner\'s',
    },
    send: {
      kind: 'admission',
      why: 'admission is chain position and the pair\'s setting, never a role\'s name: it is decided by the send admission, and this map admits no one to it',
    },
    answer: {
      kind: 'pane-authority',
      why: 'a key into another agent\'s pane belongs to the pane\'s lead, a seat above it, or the owner\'s word for that case; trust, login and security prompts to the owner\'s alone — pane authority is its own gate, and this map admits no one to it',
    },
    // The table's rows above are the decision record's. The rows below name the commands the
    // table does not, each read from the gate its own module applies: the adapter that generates
    // tools from the contract asks who may run every word, and a row that copied its guard by
    // hand would drift from the module. `any-caller` admits any caller, owner or not, record or
    // not; `seat-only` admits a declared seat of the team on its recorded pane and not the
    // owner; `leads-only` admits a seat the file marks `leads` and not the owner;
    // `team-change` is the row whose module calls `mayChangeTeamVerdict`, and `team-read` the
    // row whose module calls `mayReadTeam` — the same functions decide, never a copy of their
    // rule. A row whose module refuses a run with no terminal carries `terminal` as well, so
    // the requirement is stated instead of hidden behind a kind that reads wider. A command
    // whose verbs differ says so in its `why`, and the module, never this map, decides the
    // verb's own refusal.
    'ask-show': {
      kind: 'any-caller',
      why: 'it verifies signed ask and marker files under a key the caller already holds: no team file, no seat and no terminal is read',
    },
    broker: {
      kind: 'owner-only',
      why: 'the broker reads the tracker credential from the owner\'s keychain, one per clone, from a terminal outside herdr',
    },
    bus: {
      kind: 'owner-only',
      why: 'the bus reconciles the project\'s event log, and the owner runs it, one per clone, from a terminal outside herdr',
    },
    commits: {
      kind: 'any-caller',
      why: 'it reads the commit range and the ledger only, from any folder, and asks for no session and no terminal',
    },
    'conformance-adapter': {
      kind: 'any-caller',
      why: 'the hidden port answers classify and yaml requests on stdin: it reads no team file and asks for no caller',
    },
    doctor: {
      kind: 'any-caller',
      why: 'the report changes nothing; the owner alone gets the budget checks, and every other caller gets the same report without them',
    },
    drops: {
      kind: 'seat-only',
      why: 'a drop folder is one seat\'s mailbox: the seat the team declares, on the pane the state records for it, and never the owner; --read is the launch line\'s own invocation and asks for no caller',
    },
    help: {
      kind: 'any-caller',
      why: 'the help text reads no team file and asks for no caller',
    },
    hold: {
      kind: 'team-change',
      why: 'a hold is the team\'s: the owner, the orchestrator\'s seat or the operator\'s seat, on its recorded pane, places and releases it',
    },
    issues: {
      kind: 'any-caller',
      why: 'it lists the task file the owner committed, from the checkout, and asks for no session and no terminal',
    },
    lock: {
      kind: 'any-caller',
      why: 'any caller may take a free machine lock from a folder whose team file loads; a lock another caller holds is refused, and unlock releases only the caller\'s own',
    },
    mcp: {
      kind: 'any-caller',
      why: 'status and doctor write nothing and ask for no caller; serve is the launch line\'s own invocation for a declared seat and asks for none either',
    },
    pause: {
      kind: 'team-pause',
      why: 'a pause stops every seat\'s intake of new work, the orchestrator\'s own lever on the team: the owner or the orchestrator\'s seat, on its recorded pane; the operator is not admitted, and its own stop is `team hold`',
      terminal: { who: 'the owner or the orchestrator', where: 'a terminal outside herdr or its own seat' },
    },
    plan: {
      kind: 'seat-only',
      why: 'a declared seat of this team plans, on the pane the state records for it; the owner and a run with no terminal are not admitted',
    },
    policy: {
      kind: 'team-read',
      why: 'the view is read by the owner, a seat the state places on its recorded pane, or an approved delegate pane; set and unset are the owner\'s alone, from a terminal outside herdr',
    },
    pr: {
      kind: 'any-caller',
      why: 'it reads a pull request body and the checks only, from any folder, and asks for no session and no terminal',
    },
    proc: {
      kind: 'owner-or-own-team',
      why: 'add and done are the owner\'s or a declared seat\'s, from a terminal; list reads what status does, so an approved delegate pane may list too',
      terminal: { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' },
    },
    projects: {
      kind: 'any-caller',
      why: 'it reads the project registry and changes nothing, from any folder',
    },
    raise: {
      kind: 'leads-only',
      why: 'the line is the lead\'s: the orchestrator\'s seat or a seat the team marks `leads`, on its recorded pane, and the owner is not admitted',
    },
    release: {
      kind: 'any-caller',
      why: 'it reads the release facts and asks for no session, terminal or login; the Linear check alone needs the owner\'s keychain',
    },
    reply: {
      kind: 'admission',
      why: 'a reply is judged by the send admission exactly as a send is, with the reply rule; the caller must be the record\'s addressee',
    },
    resume: {
      kind: 'team-pause',
      why: 'a resume reopens the intake a pause closed, by the same gate: the owner or the orchestrator\'s seat, on its recorded pane; the operator is not admitted',
      terminal: { who: 'the owner or the orchestrator', where: 'a terminal outside herdr or its own seat' },
    },
    route: {
      kind: 'admission',
      why: 'a route is judged by the send admission: the owner and admitted seats are answered, and a run with no terminal is refused',
    },
    seats: {
      kind: 'team-read',
      why: 'the owner, a seat the state places on its recorded pane, or an approved delegate pane reads the seats; --session and --file are the owner\'s alone',
    },
    sessions: {
      kind: 'any-caller',
      why: 'it lists the machine-wide session registry the state records and changes nothing: no team file, no seat and no terminal is read',
    },
    tempo: {
      kind: 'owner-only',
      why: 'the tempo word is the owner\'s, from a terminal outside herdr',
    },
    unlock: {
      kind: 'any-caller',
      why: 'a lock is anyone\'s to take, and its release is the holder\'s alone: the caller the holder file names releases it, and anyone else is shown the holder',
    },
    watch: {
      kind: 'any-caller',
      why: 'anyone in a terminal or its own pane starts the watch; a run with no terminal is refused before it starts',
      terminal: { who: 'the owner or a placed seat', where: 'a terminal outside herdr or its own pane' },
    },
    worktree: {
      kind: 'team-change',
      why: 'the owner, the orchestrator\'s seat or the operator\'s seat manages worktrees; --session and --file are the owner\'s',
    },
    // Subcommand rows, keyed `command:subcommand`: a verb whose gate differs from its command's
    // states its own row, and every subcommand node of the contract repeats one — never the
    // command's row standing in for a verb the module gates differently. Where the verb and the
    // command share a gate, the row repeats the command's own sentence.
    'commits:check': {
      kind: 'any-caller',
      why: 'the check reads the commit range and the ledger only, from any folder, and asks for no session and no terminal',
    },
    'mcp:doctor': {
      kind: 'any-caller',
      why: 'the report writes nothing and asks for no caller',
    },
    'mcp:serve': {
      kind: 'any-caller',
      why: 'the launch line names its seat and session; the server reads and receipts only that seat\'s inbox, and asks for no caller',
    },
    'mcp:status': {
      kind: 'any-caller',
      why: 'the report writes nothing and asks for no caller',
    },
    'policy:set': {
      kind: 'owner-only',
      why: 'the owner alone sets the policy, from a terminal outside herdr, signed and logged',
    },
    'policy:unset': {
      kind: 'owner-only',
      why: 'the owner alone unsets the policy, from a terminal outside herdr, signed and logged',
    },
    'pr:check': {
      kind: 'any-caller',
      why: 'the check reads the pull request body and the checks only, from any folder, and asks for no session and no terminal',
    },
    'proc:add': {
      kind: 'owner-or-own-team',
      why: 'the owner or a declared seat records its process; a seat of another team and a run with no terminal are refused',
      terminal: { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' },
    },
    'proc:done': {
      kind: 'owner-or-own-team',
      why: 'a seat clears its own, a lead clears another seat\'s, and the owner clears any; a run with no terminal is refused',
      terminal: { who: 'the owner or a seat of this team', where: 'a terminal outside herdr or its own pane' },
    },
    'proc:list': {
      kind: 'team-read',
      why: 'the owner, a seat the state places on its own pane, or an approved delegate pane reads the list',
    },
    'release:check': {
      kind: 'any-caller',
      why: 'the check reads the release facts and asks for no session, terminal or login; the Linear check alone needs the owner\'s keychain',
    },
    'revoke:delegate': {
      kind: 'owner-only',
      why: 'removing a standing delegation is the owner\'s edit, and the revocation channel of 0.5.0 is the owner at a terminal',
    },
    'revoke:grant': {
      kind: 'owner-only',
      why: 'removing a standing grant is the owner\'s edit, and the revocation channel of 0.5.0 is the owner at a terminal',
    },
    'worktree:list': {
      kind: 'team-change',
      why: 'the owner, the orchestrator\'s seat or the operator\'s seat lists the worktrees; --session and --file are the owner\'s',
    },
    'worktree:new': {
      kind: 'team-change',
      why: 'the owner, the orchestrator\'s seat or the operator\'s seat creates a worktree; --session and --file are the owner\'s',
    },
    'worktree:remove': {
      kind: 'team-change',
      why: 'the owner, the orchestrator\'s seat or the operator\'s seat removes a worktree; --session and --file are the owner\'s',
    },
  };
  for (const word of READ_SURFACES) {
    gates[word] = {
      kind: 'seat-record',
      why: `a read surface of the Runtime and the modules: any seat with a registry record, and the \`read\` scope is not enforced in 0.5.0`,
    };
  }
  for (const capability of GRANT_CAPABILITIES) {
    gates[capability] = {
      kind: 'capability',
      why: 'the Kernel\'s operational capability, held by the seat it names, within its scope and the constraints of §5; 0.5.0 gates none of them',
    };
  }
  return gates;
}
