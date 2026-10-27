import { homedir } from 'node:os';
import { readArgs } from '../args.ts';
import { callerLabel, callerOf, describeCaller, detachedRefusal, isOwner, type Caller } from '../caller.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRoot, loadTeamText, TEAM_FILE } from '../file/load.ts';
import { charterGate } from '../charter/check.ts';
import { admitOwnerAction, createOwnerActionRequest, OWNER_ACTION_TTL_MS } from '../client/owner-action.ts';
import { headOf, ownerSeatRuleAdmits, ownerSeatStep } from '../client/owner-action-step.ts';
import { systemOwnerSeatKeyStore, type OwnerSeatKeyStore } from '../client/owner-seat.ts';
import { actionRequestsFolder } from '../client/team-create.ts';
import { retireTeamFile, type Retired } from '../file/retire.ts';
import { canonicalTeam, readTeamConfig } from '../file/team-config.ts';
import { importTeamFile, type ImportMode, type ImportOutcome } from '../file/team-import.ts';
import { approvalStanding } from '../store/store.ts';
import { sha256 } from '../registry/team-config-store.ts';
import { teamIdOf } from '../registry/teams.ts';
import type { Command, Io } from '../io.ts';
import { hasJsonFlag, refuse, writeJson } from '../output/index.ts';

export const USAGE = `Usage: team migrate [--keep-file] [--dry-run] [--json]
       team migrate [--keep-file] --request [--json]
       team migrate [--keep-file] --approval <request-id> [--json]

Moves this team's definition from .agents/team.yaml into the registry, once. The team
is imported, read back from the registry and compared with the file by canonical record;
only then is .agents/team.yaml moved to the system Trash (or renamed to
.agents/team.yaml.migrated when no Trash can be reached; it is never deleted). Every
command then reads the team from the registry, and team config edits it. The approval
stays in force: it is signed over the canonical record, not the file.

The owner runs it from a terminal outside herdr. Anyone else asks the owner seat:
the card names the team, the project, the seat count and the canonical-record hash,
the owner signs it with Touch ID or the iPhone passkey, and the same run continues
once that signature verifies. --request records the card and stops; --approval runs
one the owner already signed. A denial, an expiry, or a signature that does not
match writes nothing. No signer approves a request they asked for.

Run again on a team the registry already holds, it moves a leftover file that says
what the registry says, and refuses one that does not (team import replaces the record).

  --keep-file  import and verify, and leave .agents/team.yaml where it is
  --dry-run    say what would be imported, and write nothing; anyone in the project may run it
  --request    record this migrate for the owner seat and do not import yet
  --approval <request-id>
               run the migrate the owner seat signed for, once
  --json       the result as one JSON document on stdout

Exits 0 when the team is in the registry (or would be, with --dry-run) or a request
is recorded, 1 when the migrate is refused or the team was already moved, 2 when the
invocation, team file, or registry record can't be read.
`;

export const migrate: Command = (argv, io) => runMigrate(argv, io);

/** Home, clock, and the owner-seat store. `onOwnerRequest` is the test seam that signs while a run waits. */
export type ImportSources = {
  home?: string;
  now?: () => Date;
  ownerSeatStore?: OwnerSeatKeyStore;
  /** Called once the card is recorded, before this run looks for the signature. */
  onOwnerRequest?: (id: string) => void | Promise<void>;
  /** The pause between looks. Production waits one second. */
  sleep?: (ms: number) => Promise<void>;
};

/** The command with its home and clock named, for tests that keep the registry in a temp home. */
export async function runMigrate(argv: string[], io: Io, sources: ImportSources = {}): Promise<number> {
  const ended = await runTeamImport('migrate', argv, readArgs(argv, ['approval'], ['json', 'dry-run', 'keep-file', 'request']), io, sources);
  switch (ended) {
    case 'done':
      // exit: migrate.done
      return 0;
    case 'approval-requested':
      // exit: migrate.approval-requested
      return 0;
    case 'approval-refused':
    case 'detached':
      // exit: migrate.approval-refused
      return 1;
    case 'not-owner':
      // exit: migrate.not-owner
      return 1;
    case 'already-migrated':
      // exit: migrate.already-migrated
      return 1;
    case 'invocation':
      // exit: migrate.invocation
      return 2;
    case 'invalid':
      // exit: migrate.invalid
      return 2;
    case 'registry':
      // exit: migrate.registry
      return 2;
    default:
      // exit: migrate.round-trip
      return 2;
  }
}
export default migrate;

/** How a run ended: each command turns it into its own exit code. */
export type ImportEnd = 'approval-requested' | 'approval-refused' | 'done' | 'detached' | 'not-owner' | 'already-migrated' | 'invocation' | 'invalid' | 'registry' | 'round-trip';

const MIGRATE_POLL_MS = 1000;

type MigrateFacts = { root: string; team: string; id: string; project: string; seats: number; record: string };

/** The words a migrate approval binds: keep-file, and the record the card names. */
function migrateWords(keepFile: boolean, facts: MigrateFacts): string[] {
  return [
    ...(keepFile ? ['--keep-file'] : []),
    `team=${facts.team}`,
    `id=${facts.id}`,
    `project=${facts.project}`,
    `seats=${String(facts.seats)}`,
    `record=${facts.record}`,
  ];
}

/** The team file this migrate would import, read the same way the import itself reads it. */
function readMigrateFacts(cwd: string, home: string): { ok: true; facts: MigrateFacts } | { ok: false; why: string } {
  const root = findRoot(cwd);
  if (root === null) return { ok: false, why: 'not inside a git repository: run team from a project' };
  const from = join(root, TEAM_FILE);
  let text: string;
  try {
    text = readFileSync(from, 'utf8');
  } catch {
    return { ok: false, why: `no readable team file at ${from}` };
  }
  const loaded = loadTeamText(text, root, from, { home });
  if (!loaded.ok) return { ok: false, why: loaded.errors.map((p) => (p.line ? `line ${p.line}: ` : '') + p.message).join('; ') };
  return {
    ok: true,
    facts: {
      root: loaded.root,
      team: loaded.team.project,
      id: teamIdOf(loaded.root),
      project: loaded.team.inProject ?? loaded.team.project,
      seats: loaded.team.seats.length,
      record: sha256(canonicalTeam(loaded.team)),
    },
  };
}

/** A team the registry already holds, rewritten the way a migrate reports it: a matching leftover
 *  (or no file) is nothing to import; a file that says something else stays refused. */
function settleMigrated(outcome: ImportOutcome, cwd: string, home: string, teamFile: string): ImportOutcome {
  if (outcome.ok || (outcome.reason !== 'already-migrated' && !(outcome.reason === 'invalid' && !existsSync(teamFile)))) return outcome;
  const held = readTeamConfig(cwd, { home, source: 'registry' });
  if (!held.ok || (held.leftover !== undefined && !held.leftover.matches)) return outcome;
  return {
    ok: true,
    action: 'unchanged',
    project: held.team.project,
    id: teamIdOf(held.root),
    root: held.root,
    from: teamFile,
    record: null,
    replaced: false,
    verified: true,
  };
}

/** Pauses until the answer file is there, or the request's lifetime has passed. */
async function waitForSeatAnswer(home: string, id: string, expiresAt: string | null, now: () => Date, sleep: (ms: number) => Promise<void>): Promise<void> {
  const answer = join(actionRequestsFolder(home), `${id}.seat-answer.json`);
  const cap = expiresAt === null ? now().getTime() + OWNER_ACTION_TTL_MS : Date.parse(expiresAt);
  while (!existsSync(answer)) {
    if (now().getTime() >= cap) return;
    await sleep(MIGRATE_POLL_MS);
  }
}

type MigrateDoor = { kind: 'admitted' } | { kind: 'end'; end: ImportEnd };

/** Verifies a migrate approval. An always rule does not count: it is not signed over this record.
 *  The check claims nothing; the claim is a second admit, after the signature has verified. */
function admitMigrate(
  home: string,
  id: string,
  facts: MigrateFacts,
  keepFile: boolean,
  store: OwnerSeatKeyStore,
  now: Date,
): ReturnType<typeof admitOwnerAction> {
  const ask = {
    action: 'team-migrate' as const,
    root: facts.root,
    team: facts.team,
    head: headOf(facts.root),
    words: migrateWords(keepFile, facts),
    claim: false,
  };
  const looked = admitOwnerAction(home, id, ask, store, now);
  if (!looked.ok) return looked;
  if (looked.via === 'rule') {
    return { ok: false, why: `request ${id} has no owner-seat answer for this record; an always rule does not migrate a team` };
  }
  return admitOwnerAction(home, id, { ...ask, claim: true }, store, now);
}

/** Records the migrate card, or runs one the owner seat already signed. A run with neither
 *  `--request` nor `--approval` records the card and waits for the signature in this process. */
async function migrateDoor(
  args: ReturnType<typeof readArgs>,
  io: Io,
  caller: Caller,
  sources: ImportSources,
  json: boolean,
  keepFile: boolean,
  now: () => Date,
): Promise<MigrateDoor> {
  const home = sources.home ?? homedir();
  const refused = (message: string): MigrateDoor => {
    refuse(io, json, 'migrate', { id: 'migrate.approval-refused', message, repair: null });
    return { kind: 'end', end: 'approval-refused' };
  };
  if (args.flags.has('request') && args.values.approval !== undefined) {
    return refused('--request asks the owner seat and --approval runs an answered request: pass one');
  }
  const read = readMigrateFacts(io.cwd, home);
  if (!read.ok) {
    refuse(io, json, 'migrate', { id: 'migrate.invalid', message: read.why, repair: null });
    return { kind: 'end', end: 'invalid' };
  }
  const store = sources.ownerSeatStore ?? systemOwnerSeatKeyStore();
  if (args.values.approval !== undefined) {
    const admitted = admitMigrate(home, args.values.approval, read.facts, keepFile, store, now());
    if (!admitted.ok) return refused(admitted.why);
    if (!json) io.stderr(`team migrate: owner-seat approval ${args.values.approval} (signed by ${admitted.signer})\n`);
    return { kind: 'admitted' };
  }
  const made = createOwnerActionRequest(home, {
    actions: ['team-migrate'],
    root: read.facts.root,
    team: read.facts.team,
    head: headOf(read.facts.root),
    args: { 'team-migrate': migrateWords(keepFile, read.facts) },
    requestedBy: callerLabel(caller),
  }, now());
  if (!made.ok) return refused(made.why);
  const id = made.record.request_id;
  const rerun = `team migrate${keepFile ? ' --keep-file' : ''} --approval ${id}`;
  const where = made.page === 'live' ? 'the owner page is already open and will show this card' : 'the owner answers it on the owner page';
  if (args.flags.has('request')) {
    if (json) io.stdout(`${JSON.stringify({ format: 1, status: 'requested', request_id: id, expires_at: made.record.expires_at, text: made.text, page: made.page, run: rerun })}\n`);
    else io.stdout(`team migrate: owner-seat request ${id} recorded; ${where}\nthen run: ${rerun}\n`);
    return { kind: 'end', end: 'approval-requested' };
  }
  // The card is the inbox text. Under --json the result document is the only stdout, so the wait stays quiet.
  if (!json) io.stdout(`team migrate: owner-seat request ${id} recorded; ${where}\n${made.text}\nwaiting for the signed approval\n`);
  if (sources.onOwnerRequest) await sources.onOwnerRequest(id);
  else await waitForSeatAnswer(home, id, made.record.expires_at, now, sources.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))));
  const again = readMigrateFacts(io.cwd, home);
  if (!again.ok) return refused(again.why);
  const admitted = admitMigrate(home, id, again.facts, keepFile, store, now());
  if (!admitted.ok) return refused(admitted.why);
  if (!json) io.stderr(`team migrate: owner-seat approval ${id} (signed by ${admitted.signer})\n`);
  return { kind: 'admitted' };
}

/** The one runner for `team migrate` and `team import` (src/commands/import.ts). It prints and
 *  says how the run ended; the exit code is each command's own. */
export async function runTeamImport(
  mode: ImportMode,
  argv: string[],
  args: ReturnType<typeof readArgs>,
  io: Io,
  sources: ImportSources = {},
): Promise<ImportEnd> {
  const usage = mode === 'migrate' ? USAGE : (await import('./import.ts')).USAGE;
  const json = hasJsonFlag(argv);
  const extra = mode === 'import' ? args.rest.slice(1) : args.rest;
  if (args.error || extra.length > 0) {
    refuse(io, json, mode, { id: `${mode}.invocation`, message: args.error ?? `unexpected "${extra[0]}"`, repair: null, usage });
    return 'invocation';
  }
  const file = mode === 'import' ? args.rest[0] : undefined;
  const caller = callerOf(io);
  // The owner-seat door, for `import` (src/client/owner-action-step.ts): `--request` asks the owner
  // seat; `--approval <id>` runs the import the owner seat signed for, with no owner terminal.
  const seat = mode === 'import'
    ? ownerSeatStep('import', 'team-import', argv, { request: args.flags.has('request'), approval: args.values.approval, dry: args.flags.has('dry-run'), json }, io, sources)
    : { kind: 'none' as const };
  if (seat.kind === 'requested') return 'approval-requested';
  if (seat.kind === 'refused') return 'approval-refused';
  const dryRun = args.flags.has('dry-run');
  const keepFile = mode === 'import' || args.flags.has('keep-file');
  const home = sources.home ?? homedir();
  const now = (): Date => sources.now?.() ?? new Date();
  let charterAdmitted = false;
  // A dry run only reads. A blocking charter stops a real migrate before any card is written.
  if (mode === 'migrate' && !dryRun) {
    const gate = charterGate(home, { operation: 'migrate', cwd: io.cwd }, sources.ownerSeatStore);
    if (gate.kind === 'block') {
      refuse(io, json, mode, { id: `${mode}.not-owner`, message: gate.message, repair: null });
      return 'not-owner';
    }
    charterAdmitted = gate.kind === 'admit';
  }
  const ownerTerminal = isOwner(caller);
  let doorAdmitted = false;
  let outcome: ImportOutcome | undefined;
  const explicitDoor = mode === 'migrate' && !dryRun && (args.flags.has('request') || args.values.approval !== undefined);
  // Anyone but the owner at a terminal asks the owner seat, unless the charter already admits the run.
  const implicitDoor = mode === 'migrate' && !dryRun && !ownerTerminal && !charterAdmitted;
  if (explicitDoor || implicitDoor) {
    const teamFileEarly = join(findRoot(io.cwd) ?? io.cwd, TEAM_FILE);
    const looked = settleMigrated(importTeamFile({ cwd: io.cwd, home, mode, dryRun: true, now: now() }), io.cwd, home, teamFileEarly);
    // A matching leftover is retired only when this run would move the file. That retirement is a
    // write, so it needs the same signature. A no-op does not ask.
    const retireLeft = looked.ok && looked.action === 'unchanged' && !keepFile && existsSync(teamFileEarly);
    if (!looked.ok || (looked.action === 'unchanged' && !retireLeft)) outcome = looked;
    else {
      const door = await migrateDoor(args, io, caller, sources, json, keepFile, now);
      if (door.kind === 'end') return door.end;
      doorAdmitted = true;
    }
  }
  const seatApproved = charterAdmitted || seat.kind === 'admitted'
    || (mode === 'import' && !isOwner(caller) && ownerSeatRuleAdmits('team-import', io.cwd, dryRun, sources));
  // Migrate's dry run, the owner at a terminal, a charter, or a verified card skips the old gate.
  // Import keeps it. A migrate that already failed closed (nothing to ask) does too.
  const skipOwner = mode === 'migrate' && (dryRun || ownerTerminal || charterAdmitted || doorAdmitted || outcome !== undefined);
  if (!skipOwner) {
    const detached = seatApproved ? undefined : detachedRefusal(caller);
    if (detached !== undefined) {
      refuse(io, json, mode, { id: `${mode}.detached`, message: detached, repair: null });
      return 'detached';
    }
    if (!isOwner(caller) && !seatApproved) {
      // The team's configuration is the owner's: moving it is the owner's act, as writing it is.
      refuse(io, json, mode, {
        id: `${mode}.not-owner`,
        message: `only the owner runs ${mode}, from a terminal outside herdr; this call is ${describeCaller(caller)}`,
        repair: null,
        rule: 'owner-only',
      });
      return 'not-owner';
    }
  }
  const root = findRoot(io.cwd) ?? io.cwd;
  const teamFile = join(root, TEAM_FILE);
  // The approval's standing before the move: the move must not change it.
  const before = approvalStanding(root, home).kind;
  if (outcome === undefined) {
    outcome = settleMigrated(importTeamFile({
      cwd: io.cwd,
      home,
      mode,
      ...(file !== undefined ? { file } : {}),
      dryRun,
      now: now(),
    }), io.cwd, home, teamFile);
  }
  if (!outcome.ok) {
    const message = outcome.errors.map((p) => (p.line ? `line ${p.line}: ` : '') + p.message).join('; ');
    const where = outcome.reason === 'invalid' && outcome.from ? `${outcome.from}: ` : '';
    refuse(io, json, mode, {
      id: `${mode}.${outcome.reason}`,
      message: `${where}${message}`,
      repair: outcome.reason === 'already-migrated' ? 'team import' : null,
    });
    return outcome.reason;
  }
  // The file is retired only after the read-back verified, never on a dry run, never for
  // `team import` (its file is the owner's copy), and not with --keep-file.
  let retired: Retired | null = null;
  // A non-owner retires the file only after the owner seat (or the charter) admitted this run.
  const mayRetire = mode !== 'migrate' || ownerTerminal || charterAdmitted || doorAdmitted;
  if (mayRetire && !keepFile && !dryRun && outcome.verified && existsSync(teamFile)) retired = retireTeamFile(teamFile);
  const after = approvalStanding(root, home).kind;
  if (json) {
    writeJson(io, `team.${mode}`, {
      format: 1,
      project: outcome.project,
      team_id: outcome.id,
      root: outcome.root,
      from: outcome.from,
      action: outcome.action,
      replaced: outcome.replaced,
      verified: outcome.verified,
      record_sha256: outcome.record,
      ...(mode === 'migrate' ? { file: retired === null ? (existsSync(teamFile) ? 'kept' : 'absent') : retired.how, file_moved_to: retired?.to ?? null, approval: after } : {}),
    });
    return 'done';
  }
  if (outcome.action === 'would-import') {
    io.stdout(`${outcome.project}: would ${outcome.replaced ? 'replace the registry\'s record with' : 'import'} ${outcome.from} (team ${outcome.id}); nothing written\n`);
    if (mode === 'migrate' && !keepFile) io.stdout(`then ${TEAM_FILE} would be moved to the Trash (--keep-file leaves it)\n`);
    return 'done';
  }
  if (outcome.action === 'unchanged') {
    io.stdout(`${outcome.project}: the registry already holds this team; nothing to import\n`);
  } else {
    io.stdout(`${outcome.project}: ${outcome.replaced ? 'replaced the registry\'s record with' : 'imported'} ${outcome.from} (team ${outcome.id}); read back and verified\n`);
  }
  if (mode === 'import') {
    io.stdout('the team is read from the registry; the file is not read\n');
  } else if (retired !== null) {
    io.stdout(`${TEAM_FILE} ${retired.how === 'trash' ? 'was moved to the Trash' : `was renamed to ${retired.to} (no Trash could be reached)`}; edit the team with team config\n`);
  } else if (existsSync(teamFile)) {
    io.stdout(`${TEAM_FILE} was kept (--keep-file); it is no longer read, and team migrate moves it later\n`);
  }
  if (mode === 'migrate' && before === 'verified') {
    io.stdout(after === 'verified' ? 'the approval is still in force: it is signed over the canonical record\n' : `the approval no longer verifies (${after}); approve the team again\n`);
  }
  return 'done';
}
